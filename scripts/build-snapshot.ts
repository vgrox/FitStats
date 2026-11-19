import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { importActivityArchive } from "../src/activity-details.js";
import { dashboardActivities } from "../src/dashboard-routes.js";
import { buildStaticDashboard } from "./build-demo.mjs";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: npm run snapshot:build -- /path/to/strava-export.zip");

const temporary = await mkdtemp(join(tmpdir(), "fitstats-snapshot-"));
const output = new URL("../dist/snapshot/", import.meta.url);
const db = openDatabase({ databasePath: join(temporary, "export.db") });
try {
  const report = await importActivityArchive(db, archive);
  const workouts = dashboardActivities(db).all() as { id: number }[];
  const detail = db.prepare("SELECT source, payload FROM activity_details WHERE activity_id = ?");
  const summary = db.prepare(`SELECT name, description, sport_type, start_date, distance_m,
     moving_time_s, elapsed_time_s, total_elevation_gain_m, average_speed_mps, max_speed_mps,
     average_heartrate_bpm, max_heartrate_bpm, average_cadence_rpm, max_cadence_rpm,
     average_watts, max_watts, calories_kcal FROM activities WHERE strava_activity_id = ?`);
  await buildStaticDashboard("snapshot", output);
  const directory = new URL("workouts/", output);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory);
  const rows = [];
  for (const [index, workout] of workouts.entries()) {
    const id = index + 1;
    rows.push({ ...workout, id });
    const sources = Object.fromEntries((detail.all(workout.id) as { source: string; payload: string }[])
      .map(({ source, payload }) => [source, JSON.parse(payload)]));
    const fit = sources.fit;
    // Keep chart and lap fields without original file headers or device identifiers.
    const recording = sources.recording;
    const details = {
      summary: summary.get(workout.id),
      raw: {},
      streams: {},
      ...(fit ? { fit: {
        sessions: fit.sessions?.map(({ total_timer_time, total_ascent, total_descent, avg_heart_rate, max_heart_rate, avg_cadence, max_cadence, total_calories, avg_power, normalized_power, max_power, total_work, total_steps }: Record<string, unknown>) => ({
          total_timer_time, total_ascent, total_descent, avg_heart_rate, max_heart_rate, avg_cadence, max_cadence, total_calories, avg_power, normalized_power, max_power, total_work, total_steps
        })),
        records: fit.records?.map(({ timestamp, position_lat, position_long, enhanced_altitude, altitude, enhanced_speed, speed, distance, heart_rate, cadence, power, temperature, gps_accuracy }: Record<string, unknown>) => ({
          timestamp, position_lat, position_long, enhanced_altitude, altitude, enhanced_speed, speed, distance, heart_rate, cadence, power, temperature, gps_accuracy
        }))
      } } : {}),
      ...(recording ? { recording: { data: recording.data } } : {}),
      gpx: sources.gpx,
      tcx: sources.tcx
    };
    await writeFile(new URL(id + ".json", directory), JSON.stringify(details));
  }
  await writeFile(new URL("workouts.json", output), JSON.stringify(rows));
  console.log(`Built a snapshot of ${rows.length} workouts with ${report.fit + report.gpx + report.tcx + report.json} parsed recordings. Recording failures: ${report.failures.length}.`);
} finally {
  db.close();
  await rm(temporary, { recursive: true, force: true });
}
