import type Database from "better-sqlite3";
import AdmZip from "adm-zip";
import FitParser from "fit-file-parser";
import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { importStravaExport } from "./strava-export.js";
import { StravaClient, StravaHttpError } from "./strava-client.js";

export function detailWriter(db: Database.Database) {
  const statement = db.prepare("INSERT INTO activity_details VALUES (?, ?, ?) ON CONFLICT(activity_id, source) DO UPDATE SET payload = excluded.payload");
  return (id: number, source: string, value: unknown) => statement.run(id, source, JSON.stringify(value));
}

const list = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : value ? [value] : []).filter(item => item && typeof item === "object");
const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });
function track(data: Buffer, extension: string) {
  const parsed = xml.parse(data);
  if (extension === "tcx") {
    return list(parsed.TrainingCenterDatabase?.Activities?.Activity).flatMap(activity =>
      list(activity.Lap).flatMap(lap => list(lap.Track).map(track => list(track.Trackpoint).map(p => {
        const pos = p.Position as Record<string, unknown> | undefined;
        const extensions = (p.Extensions as Record<string, Record<string, unknown>> | undefined)?.TPX;
        return { timestamp: p.Time, position_lat: pos?.LatitudeDegrees, position_long: pos?.LongitudeDegrees,
          altitude: p.AltitudeMeters, distance: p.DistanceMeters, cadence: p.Cadence ?? extensions?.RunCadence,
          heart_rate: (p.HeartRateBpm as Record<string, unknown> | undefined)?.Value, speed: extensions?.Speed, power: extensions?.Watts };
      }))));
  }
  return list(parsed.gpx?.trk).flatMap(trk => list(trk.trkseg).map(seg => list(seg.trkpt).map(p => {
    const ext = (p.extensions as Record<string, Record<string, unknown>> | undefined)?.TrackPointExtension;
    return { timestamp: p.time, position_lat: p["@_lat"], position_long: p["@_lon"], altitude: p.ele,
      heart_rate: ext?.hr, cadence: ext?.cad, temperature: ext?.atemp };
  })));
}

export async function importActivityArchive(db: Database.Database, filename: string) {
  const archive = new AdmZip(filename);
  const csv = archive.readFile("activities.csv");
  if (!csv) throw new Error("The archive has no activities.csv.");
  const directory = mkdtempSync(join(tmpdir(), "fitstats-"));
  let imported;
  try {
    const path = join(directory, "activities.csv");
    writeFileSync(path, csv, { mode: 0o600 });
    imported = importStravaExport(db, path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const [headers, ...rows] = parse(csv, { bom: true, skip_empty_lines: true }) as string[][];
  const filenameIndex = headers.indexOf("Filename");
  const idIndex = headers.indexOf("Activity ID");
  const save = detailWriter(db);
  const fit = new FitParser({ force: true, mode: "list" });
  const report = { ...imported, fit: 0, gpx: 0, tcx: 0, json: 0, failures: [] as { id: number; reason: string }[] };
  for (const row of rows) {
    const id = Number(row[idIndex]);
    save(id, "export", headers.flatMap((header, i) => row[i]?.trim() ? [[header, row[i]]] : []));
    const name = row[filenameIndex];
    if (!name) continue;
    try {
      const file = archive.readFile(name);
      if (!file) throw new Error("Original file missing");
      const data = name.endsWith(".gz") ? gunzipSync(file) : file;
      const extension = name.toLowerCase().replace(/\.gz$/, "").split(".").at(-1);
      if (extension === "fit") {
        const parsed = await fit.parseAsync(Buffer.from(data));
        save(id, "fit", parsed);
        report.fit++;
      } else if (extension === "gpx" || extension === "tcx") {
        const tracks = track(data, extension);
        if (!tracks.some(segment => segment.length)) throw new Error("Original file has no track points");
        save(id, extension, tracks);
        report[extension]++;
      } else if (extension === "json") {
        const original = JSON.parse(data.toString("utf8"));
        if (!Array.isArray(original.data)) throw new Error("Unrecognized Strava recording");
        const metadata = { ...original.metadata };
        delete metadata.http_user_agent;
        delete metadata.athlete_id;
        delete metadata.external_id;
        save(id, "recording", { metadata, data: original.data });
        report.json++;
      } else {
        throw new Error("Unsupported original file format");
      }
    } catch (error) {
      report.failures.push({ id, reason: error instanceof Error ? error.message : "Original file could not be parsed" });
    }
  }
  return report;
}

export async function enrichActivities(db: Database.Database, client: StravaClient, athleteId: number) {
  const save = detailWriter(db);
  const missing = db.prepare(`SELECT strava_activity_id AS id FROM activities a
    WHERE athlete_id = ? AND is_deleted = 0 AND NOT EXISTS (
      SELECT 1 FROM activity_details WHERE activity_id = a.strava_activity_id AND source = ?
    ) AND (? <> 'zones' OR average_heartrate_bpm IS NOT NULL OR max_heartrate_bpm IS NOT NULL)
    ORDER BY start_date DESC`);
  for (const source of ["zones", "detail", "streams"] as const) {
    const rows = missing.all(athleteId, source, source) as { id: number }[];
    let saved = 0, unavailable = 0, failed = 0;
    for (const { id } of rows) {
      try {
        const result = await (source === "detail" ? client.getActivity(athleteId, id) :
          source === "zones" ? client.getActivityZones(athleteId, id) : client.getActivityStreams(athleteId, id));
        save(id, source, result);
        saved++;
      } catch (error) {
        if (error instanceof StravaHttpError && error.status === 404) {
          save(id, source, null);
          unavailable++;
        } else {
          failed++;
          console.warn(`Strava ${source} request failed for activity ${id}.`, error instanceof Error ? error.message : "");
          if (error instanceof StravaHttpError && error.status === 403 && source !== "detail") break;
          if (failed >= 3 || (error instanceof StravaHttpError && [401, 429].includes(error.status))) throw error;
        }
      }
    }
    console.log(JSON.stringify({ source, selected: rows.length, saved, unavailable, failed }));
  }
}
