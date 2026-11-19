CREATE TABLE athletes (
  athlete_id INTEGER PRIMARY KEY,
  username TEXT,
  firstname TEXT,
  lastname TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  sex TEXT,
  profile_medium_url TEXT,
  profile_url TEXT,
  weight_kg REAL,
  is_authorized INTEGER NOT NULL DEFAULT 1 CHECK (is_authorized IN (0, 1)),
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tokens are AES-256-GCM encrypted before they reach this table. The encryption
-- key exists only in the local .env file and is never stored in this database.
CREATE TABLE strava_tokens (
  athlete_id INTEGER PRIMARY KEY REFERENCES athletes(athlete_id) ON DELETE CASCADE,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_auth_tag TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_auth_tag TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  scope TEXT NOT NULL,
  token_type TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE activities (
  strava_activity_id INTEGER PRIMARY KEY,
  athlete_id INTEGER NOT NULL REFERENCES athletes(athlete_id),
  name TEXT NOT NULL,
  description TEXT,
  sport_type TEXT,
  activity_type TEXT,
  workout_type INTEGER,
  start_date TEXT,
  start_date_local TEXT,
  timezone TEXT,
  distance_m REAL,
  moving_time_s INTEGER,
  elapsed_time_s INTEGER,
  total_elevation_gain_m REAL,
  average_speed_mps REAL,
  max_speed_mps REAL,
  pace_seconds_per_km REAL,
  average_heartrate_bpm REAL,
  max_heartrate_bpm REAL,
  average_cadence_rpm REAL,
  max_cadence_rpm REAL,
  average_watts REAL,
  weighted_average_watts REAL,
  max_watts REAL,
  kilojoules REAL,
  calories_kcal REAL,
  achievement_count INTEGER,
  kudos_count INTEGER,
  comment_count INTEGER,
  summary_polyline TEXT,
  start_lat REAL,
  start_lng REAL,
  end_lat REAL,
  end_lng REAL,
  gear_id TEXT,
  visibility TEXT,
  trainer INTEGER CHECK (trainer IN (0, 1)),
  commute INTEGER CHECK (commute IN (0, 1)),
  manual INTEGER CHECK (manual IN (0, 1)),
  private INTEGER CHECK (private IN (0, 1)),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  deleted_at TEXT,
  strava_created_at TEXT,
  strava_updated_at TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX activities_athlete_start_date_idx ON activities(athlete_id, start_date DESC);
CREATE INDEX activities_athlete_active_idx ON activities(athlete_id, is_deleted, start_date DESC);
CREATE INDEX activities_strava_updated_idx ON activities(strava_updated_at DESC);

-- Each stream is kept as the original ordered Strava data array. This avoids a
-- very large row-per-point table while remaining easy for a dashboard to query.
CREATE TABLE activity_streams (
  activity_id INTEGER NOT NULL REFERENCES activities(strava_activity_id) ON DELETE CASCADE,
  stream_type TEXT NOT NULL,
  series_type TEXT,
  resolution TEXT,
  original_size INTEGER,
  data_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (activity_id, stream_type)
);

CREATE TABLE sync_state (
  scope TEXT PRIMARY KEY,
  athlete_id INTEGER REFERENCES athletes(athlete_id) ON DELETE CASCADE,
  last_successful_sync_at TEXT,
  checkpoint_updated_after INTEGER,
  cursor_json TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  subscription_id INTEGER,
  owner_id INTEGER,
  object_id INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  aspect_type TEXT NOT NULL,
  event_time INTEGER,
  updates_json TEXT,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'processed', 'failed', 'ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  next_retry_at TEXT,
  last_error TEXT
);

CREATE INDEX webhook_events_retry_idx ON webhook_events(status, next_retry_at);
CREATE INDEX webhook_events_object_idx ON webhook_events(object_type, object_id, owner_id);
