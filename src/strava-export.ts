import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { mapActivity } from "./activity-mapper.js";
import { ActivityRepository } from "./repositories.js";

const exportAthleteId = 0;

export function importStravaExport(db: Database.Database, filename: string) {
  const [headers, ...rows] = parse(readFileSync(filename), {
    bom: true,
    skip_empty_lines: true
  }) as string[][];
  const columns = (headers ?? []).map(header => header.trim());
  for (const required of ["Activity ID", "Activity Date", "Activity Name", "Activity Type"]) {
    if (!columns.includes(required)) throw new Error(`Expected a Strava activities.csv with the "${required}" column.`);
  }

  const repository = new ActivityRepository(db);
  const exists = db.prepare("SELECT 1 FROM activities WHERE strava_activity_id = ?");
  return db.transaction(() => {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO athletes (athlete_id, is_authorized, raw_json, created_at, updated_at)
      VALUES (?, 0, '{}', ?, ?) ON CONFLICT(athlete_id) DO NOTHING
    `).run(exportAthleteId, timestamp, timestamp);

    const summary = { rows: rows.length, inserted: 0, skipped: 0 };
    for (const [index, row] of rows.entries()) {
      // Strava repeats some headers. The detailed Distance column is in metres.
      const value = (column: string) => row[columns.indexOf(column)]?.trim() || null;
      const metric = (column: string, index = columns.indexOf(column)) => {
        const raw = row[index]?.trim() || null;
        if (raw === null) return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
      };

      const idText = value("Activity ID");
      const id = Number(idText);
      if (!idText || !/^\d+$/.test(idText) || !Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`Invalid activity ID in CSV record ${index + 2}.`);
      }
      if (exists.get(id)) {
        summary.skipped++;
        continue;
      }

      const date = value("Activity Date");
      const parsedDate = date ? Date.parse(date + (/\b(?:GMT|UTC)\b|Z$|[+-]\d{2}:?\d{2}$/i.test(date) ? "" : /^\d{4}-\d{2}-\d{2}T/.test(date) ? "Z" : " UTC")) : NaN;
      if (date && !Number.isFinite(parsedDate)) throw new Error(`Invalid activity date in CSV record ${index + 2}.`);

      const summaryDistance = metric("Distance");
      const lastDistance = columns.lastIndexOf("Distance");
      const detailedDistance = lastDistance > columns.indexOf("Distance") ? metric("Distance", lastDistance) : null;
      const distance = detailedDistance ?? (summaryDistance === null ? null : summaryDistance * (value("Activity Type") === "Swim" ? 1 : 1000));
      const movingTime = metric("Moving Time");
      const elapsedTime = metric("Elapsed Time");
      const type = value("Activity Type");
      const speed = distance !== null && movingTime !== null && movingTime > 0 ? distance / movingTime : null;
      const activity = mapActivity({
        id,
        name: value("Activity Name"),
        description: value("Activity Description"),
        type,
        sport_type: type?.replaceAll(" ", ""),
        start_date: date ? new Date(parsedDate).toISOString() : null,
        distance,
        moving_time: movingTime === null ? null : Math.round(movingTime),
        elapsed_time: elapsedTime === null ? null : Math.round(elapsedTime),
        total_elevation_gain: metric("Elevation Gain"),
        average_speed: speed,
        max_speed: metric("Max Speed"),
        average_heartrate: metric("Average Heart Rate"),
        max_heartrate: metric("Max Heart Rate"),
        average_cadence: metric("Average Cadence"),
        max_cadence: metric("Max Cadence"),
        average_watts: metric("Average Watts"),
        max_watts: metric("Max Watts"),
        calories: metric("Calories")
      }, exportAthleteId);
      activity.rawJson = JSON.stringify({ source: "strava-export", columns, row });
      repository.upsert(activity);
      summary.inserted++;
    }
    return summary;
  }).immediate();
}
