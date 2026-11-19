-- Strava allows one push subscription per application. Keeping its ID locally
-- lets the receiver reject events sent to the public endpoint by a different
-- subscription before they can alter local activity state.
CREATE TABLE webhook_subscriptions (
  subscription_id INTEGER PRIMARY KEY,
  callback_url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX webhook_subscriptions_active_idx
  ON webhook_subscriptions(is_active, updated_at DESC);
