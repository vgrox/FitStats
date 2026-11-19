import assert from "node:assert/strict";
import test from "node:test";
import { getOAuthSettings, loadConfig } from "../src/config.js";

test("database configuration works without Strava credentials", () => {
  const config = loadConfig({ FITSTATS_DB_PATH: "data/test.db" });
  assert.match(config.databasePath, /data\/test\.db$/);
  assert.throws(() => getOAuthSettings(config), /Missing required configuration/);
});
