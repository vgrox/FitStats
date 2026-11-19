import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFitStatsServer } from "../src/server.js";

test("starts without Strava credentials and exposes a clear health status", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fitstats-server-test-"));
  const runtime = createFitStatsServer({
    databasePath: path.join(directory, "fitstats.db"),
    host: "127.0.0.1",
    port: 0,
    syncLookbackDays: 30,
    strava: {
      apiBaseUrl: "https://www.strava.com/api/v3",
      redirectUri: "http://127.0.0.1/oauth/strava/callback"
    }
  });
  try {
    await runtime.start();
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as { configuration: { oauthReady: boolean }; connected: boolean };
    assert.equal(body.configuration.oauthReady, false);
    assert.equal(body.connected, false);
  } finally {
    await runtime.close();
    runtime.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("serves private activity details only after authentication and hides deleted rows", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fitstats-details-test-"));
  const password = "private-test-dashboard-password";
  const runtime = createFitStatsServer({
    databasePath: path.join(directory, "fitstats.db"),
    host: "127.0.0.1",
    port: 0,
    syncLookbackDays: 30,
    strava: {
      apiBaseUrl: "https://www.strava.com/api/v3",
      redirectUri: "http://127.0.0.1/oauth/strava/callback"
    }
  }, password);
  try {
    runtime.db.exec(`
      INSERT INTO athletes (athlete_id, raw_json, created_at, updated_at) VALUES (1, '{}', '', '');
      INSERT INTO activities (strava_activity_id, athlete_id, name, raw_json, created_at, updated_at)
        VALUES (10, 1, 'Run', '{}', '', '');
      INSERT INTO activity_details VALUES (10, 'export', '[["Total Steps","1200"]]');
    `);
    await runtime.start();
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/activities/10`;
    const headers = { authorization: "Basic " + Buffer.from("fitstats:" + password).toString("base64") };
    assert.equal((await fetch(url)).status, 401);
    const origin = new URL(url).origin;
    assert.equal((await fetch(origin + "/milestones/fastest-run")).status, 401);
    for (const slug of ["longest-ride", "fastest-ride", "longest-run", "fastest-run", "longest-activity"]) {
      const page = await fetch(origin + "/milestones/" + slug, { headers });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /id="rank-column"/);
    }
    assert.equal((await fetch(origin + "/activity-filters.js", { headers })).status, 200);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const result = await response.json() as { summary: { name: string }; export: string[][] };
    assert.equal(result.summary.name, "Run");
    assert.deepEqual(result.export, [["Total Steps", "1200"]]);
    runtime.db.exec("UPDATE activities SET is_deleted = 1 WHERE strava_activity_id = 10");
    assert.equal((await fetch(url, { headers })).status, 404);
  } finally {
    await runtime.close();
    runtime.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
