import assert from "node:assert/strict";
import test from "node:test";
import { mapActivity } from "../src/activity-mapper.js";

test("maps Strava metrics using documented base units and calculates running pace", () => {
  const activity = mapActivity({
    id: 123,
    name: "Morning run",
    sport_type: "Run",
    distance: 5000,
    average_speed: 2.5,
    start_latlng: [28.6, 77.2],
    end_latlng: [28.61, 77.21],
    trainer: false,
    manual: true,
    map: { summary_polyline: "abc" }
  }, 42);

  assert.equal(activity.stravaActivityId, 123);
  assert.equal(activity.athleteId, 42);
  assert.equal(activity.distanceM, 5000);
  assert.equal(activity.averageSpeedMps, 2.5);
  assert.equal(activity.paceSecondsPerKm, 400);
  assert.equal(activity.startLat, 28.6);
  assert.equal(activity.manual, 1);
  assert.equal(activity.trainer, 0);
});

test("does not calculate pace for cycling activities", () => {
  const activity = mapActivity({ id: 456, name: "Ride", sport_type: "Ride", average_speed: 8 }, 42);
  assert.equal(activity.paceSecondsPerKm, null);
});
