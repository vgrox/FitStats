import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";

const assets = new Map<string, { mime: string; body: Buffer }>(([
  ["/", "text/html", "index.html"],
  ["/fitstats-icon.png", "image/png", "fitstats-icon.png"],
  ["/style.css", "text/css", "style.css"],
  ["/activity.js", "text/javascript", "activity.js"],
  ["/activity-filters.js", "text/javascript", "activity-filters.js"],
  ["/dashboard.js", "text/javascript", "dashboard.js"]
] as const).map(([route, mime, file]) => [route, { mime, body: readFileSync(new URL(`../dashboard/${file}`, import.meta.url)) }]));

export const isMilestonePath = (path: string): boolean => /^\/milestones\/(longest-ride|fastest-ride|longest-run|fastest-run|longest-activity)\/?$/.test(path);

export function dashboardActivities(db: Database.Database) {
  return db.prepare(`
    SELECT strava_activity_id AS id, name, COALESCE(activity_type_override, activity_type, sport_type, 'Other') AS type,
           start_date AS date, start_date_local AS localDate, distance_m / 1000.0 AS km,
           moving_time_s AS seconds, elapsed_time_s AS elapsed, total_elevation_gain_m AS elevation,
           COALESCE(pace_seconds_per_km, moving_time_s / (distance_m / 1000.0)) / 60.0 AS pace,
           COALESCE(average_speed_mps, distance_m / NULLIF(moving_time_s, 0)) * 3.6 AS speed,
           max_speed_mps * 3.6 AS maxSpeed, average_heartrate_bpm AS heartRate,
           max_heartrate_bpm AS maxHeartRate, average_cadence_rpm AS cadence, max_cadence_rpm AS maxCadence,
           average_watts AS power, weighted_average_watts AS weightedPower, max_watts AS maxPower,
           kilojoules AS energy, calories_kcal AS calories, gear_id AS gear,
           trainer, commute, manual, visibility, workout_type AS workoutType
    FROM activities WHERE is_deleted = 0 ORDER BY start_date DESC, strava_activity_id DESC
  `);
}

export function createDashboardHandler(db: Database.Database, { manualSync = false } = {}) {
  const query = dashboardActivities(db);
  const lastSync = db.prepare(`
    SELECT last_successful_sync_at AS timestamp, last_successful_insert_count AS inserted,
           MAX(CASE WHEN last_error IS NOT NULL THEN updated_at END) OVER () AS failure
    FROM sync_state WHERE scope LIKE 'incremental-sync:%'
    ORDER BY last_successful_sync_at DESC, scope
    LIMIT 1
  `);
  const activity = db.prepare(`SELECT * FROM activities WHERE strava_activity_id = ? AND is_deleted = 0`);
  const detail = db.prepare("SELECT source, payload FROM activity_details WHERE activity_id = ?");
  const stream = db.prepare("SELECT stream_type, raw_json FROM activity_streams WHERE activity_id = ?");
  return (request: IncomingMessage, response: ServerResponse): void => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
    if (request.method === "GET" && request.url === "/api/activities") {
      const sync = lastSync.get() as { timestamp: string | null; failure: string | null; inserted: number | null } | undefined;
      const { timestamp, failure, inserted } = sync ?? {};
      if (inserted != null) response.setHeader("X-Strava-New-Workouts", String(inserted));
      if (manualSync) response.setHeader("X-FitStats-Manual-Sync", "1");
      if (failure) response.setHeader("X-Strava-Last-Sync-Failure", failure);
      if (timestamp) response.setHeader("X-Strava-Last-Successful-Sync", timestamp);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(query.all()));
      return;
    }
    const match = request.method === "GET" && request.url?.match(/^\/api\/activities\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      const row = activity.get(id) as Record<string, unknown> | undefined;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      if (!row) {
        response.writeHead(404).end(JSON.stringify({ error: "Activity not found" }));
        return;
      }
      const sources = Object.fromEntries((detail.all(id) as {source: string; payload: string}[])
        .map(({ source, payload }) => [source, JSON.parse(payload)]));
      const oldStreams = Object.fromEntries((stream.all(id) as {stream_type: string; raw_json: string}[])
        .map(({ stream_type, raw_json }) => [stream_type, JSON.parse(raw_json)]));
      const { raw_json, ...summary } = row;
      response.end(JSON.stringify({ summary, raw: JSON.parse(String(raw_json)), ...sources,
        streams: { ...oldStreams, ...sources.streams } }));
      return;
    }
    const path = request.url ?? "";
    const asset = request.method === "GET" ? assets.get(isMilestonePath(path) ? "/" : path) : undefined;
    if (asset) {
      response.writeHead(200, { "Content-Type": `${asset.mime}${asset.mime.startsWith("text/") ? "; charset=utf-8" : ""}` });
      response.end(asset.body);
      return;
    }
    response.writeHead(404).end();
  };
}
