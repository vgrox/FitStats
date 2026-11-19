import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-expect-error Browser module is plain JavaScript.
import { filterActivities, prepareActivity, sortActivities, milestones, rankMilestone } from "../dashboard/activity-filters.js";

const rows = [
  { id: 1, name: "Morning Run", type: "Run", date: "2026-11-15T20:00:00Z", localDate: "2026-11-16T01:30:00Z", pace: 5, speed: 12, heartRate: 150 },
  { id: 2, name: "Morning Ride", type: "Ride", date: "2026-11-16T07:00:00Z", pace: 2, speed: 30, heartRate: null },
  { id: 3, name: "Morning Strength", type: "Workout", date: "2026-11-16T08:00:00Z", pace: 0, speed: null, heartRate: 140 }
].map(prepareActivity);
const ids = (results: {id: number}[]) => results.map(({ id }) => id);

test("intersects local date, weekday, search, type, and inclusive numeric bounds", () => {
  assert.deepEqual(ids(filterActivities(rows, {
    types: new Set(["Run", "Ride"]), term: "morning",
    from: "2026-11-16", through: "2026-11-16", weekday: "1",
    ranges: [["heartRate", 150, 150]], categories: []
  })), [1]);
});

test("ranks pace and speed independently and leaves missing metrics last both ways", () => {
  assert.deepEqual(ids(sortActivities(rows, "pace", "asc")), [2, 1, 3]);
  assert.deepEqual(ids(sortActivities(rows, "pace", "desc")), [1, 2, 3]);
  assert.deepEqual(ids(sortActivities(rows, "speed", "desc")), [2, 1, 3]);
  assert.deepEqual(ids(sortActivities(rows, "speed", "asc")), [1, 2, 3]);
});

test("milestones use the right sport, metric and duration fallback", () => {
  const activities = [
    { id: 1, type: "Run", km: 20, pace: 6, seconds: 7200, elapsed: 9000 },
    { id: 2, type: "TrailRun", km: 5, pace: 4, seconds: 1200 },
    { id: 3, type: "VirtualRide", km: 50, pace: 2, seconds: 6000 },
    { id: 4, type: "Ride", km: 30, pace: 1, seconds: 1800 },
    { id: 5, type: "WeightTraining", seconds: 0, elapsed: 8000 },
    { id: 6, type: "Run", km: 0, pace: null }
  ].map(prepareActivity);
  assert.deepEqual(milestones.map((milestone: Parameters<typeof rankMilestone>[1]) =>
    ids(rankMilestone(activities, milestone))), [
    [3, 4], [4, 3], [1, 2], [2, 1], [5, 1, 3, 4, 2]
  ]);
});
