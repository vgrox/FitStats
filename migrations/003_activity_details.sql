CREATE TABLE activity_details (
  activity_id INTEGER NOT NULL REFERENCES activities(strava_activity_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (activity_id, source)
);
