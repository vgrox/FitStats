import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.js";
import { mapActivity } from "../src/activity-mapper.js";
import { ActivityRepository, AthleteRepository, WebhookRepository, WebhookSubscriptionRepository } from "../src/repositories.js";

test("creates the schema and safely upserts activities and webhook duplicates", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fitstats-test-"));
  const db = openDatabase({ databasePath: path.join(directory, "fitstats.db") });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    for (const name of ["athletes", "strava_tokens", "activities", "activity_streams", "sync_state", "webhook_events", "webhook_subscriptions"]) {
      assert.ok(tables.some((table) => table.name === name));
    }
    new AthleteRepository(db).saveAthlete({
      athleteId: 1, username: null, firstname: null, lastname: null, city: null, state: null, country: null,
      sex: null, profileMediumUrl: null, profileUrl: null, weightKg: null, rawJson: "{}"
    });
    const activities = new ActivityRepository(db);
    const input = mapActivity({ id: 100, name: "Test", sport_type: "Run", start_date: "2026-01-01T00:00:00Z" }, 1);
    assert.equal(activities.upsert(input), "inserted");
    assert.equal(activities.upsert(input), "skipped");
    activities.softDelete(1, 100);
    assert.equal(activities.upsert(input), "updated");

    const events = new WebhookRepository(db);
    const event = {
      dedupeKey: "same", subscriptionId: 1, ownerId: 1, objectId: 100,
      objectType: "activity" as const, aspectType: "update" as const, eventTime: 1,
      updatesJson: "{}", rawJson: "{}"
    };
    assert.equal(events.record(event).duplicate, false);
    assert.equal(events.record(event).duplicate, true);

    const subscriptions = new WebhookSubscriptionRepository(db);
    subscriptions.saveActive(5, "https://example.test/webhooks/strava");
    subscriptions.saveActive(6, "https://example.test/new-webhooks/strava");
    assert.equal(subscriptions.activeSubscriptionId(), 6);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
