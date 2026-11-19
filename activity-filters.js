export const metrics = [
  ["km", "Distance", "km"], ["minutes", "Moving time", "min"],
  ["elapsedMinutes", "Elapsed time", "min"], ["pace", "Average pace", "min/km"],
  ["speed", "Average speed", "km/h"], ["maxSpeed", "Top speed", "km/h"],
  ["elevation", "Elevation gain", "m"], ["heartRate", "Average heart rate", "bpm"],
  ["maxHeartRate", "Max heart rate", "bpm"], ["cadence", "Average cadence", "rpm"],
  ["maxCadence", "Max cadence", "rpm"], ["power", "Average power", "W"],
  ["weightedPower", "Weighted power", "W"], ["maxPower", "Max power", "W"],
  ["energy", "Energy", "kJ"], ["calories", "Calories", "kcal"]
];

const rideTypes = new Set(["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide", "Handcycle", "Velomobile"]);
const runTypes = new Set(["Run", "TrailRun", "VirtualRun"]);

export const milestones = [
  { slug: "longest-ride", title: "Longest ride", key: "km", direction: "desc", types: rideTypes, description: "Rides ranked by distance, longest first." },
  { slug: "fastest-ride", title: "Fastest ride", key: "pace", direction: "asc", types: rideTypes, description: "Rides ranked by average pace, fastest first (lowest time per kilometre)." },
  { slug: "longest-run", title: "Longest run", key: "km", direction: "desc", types: runTypes, description: "Runs ranked by distance, longest first." },
  { slug: "fastest-run", title: "Fastest run", key: "pace", direction: "asc", types: runTypes, description: "Runs ranked by average pace, fastest first (lowest time per kilometre)." },
  { slug: "longest-activity", title: "Longest activity", key: "duration", direction: "desc", description: "All activity types, ranked by moving time. Elapsed recording time is used when moving time is unavailable. Sort by elapsed time to compare recordings." }
];

export function rankMilestone(activities, { key, direction, types }) {
  return sortActivities(activities.filter(row =>
    (!types || types.has(row.type)) && Number.isFinite(row[key]) && row[key] > 0), key, direction);
}

export function prepareActivity(row) {
  const date = (row.localDate || row.date)?.slice(0, 10) ?? null;
  return { ...row, day: date, weekday: date ? new Date(date + "T00:00:00Z").getUTCDay() : null,
    minutes: row.seconds == null ? null : row.seconds / 60,
    duration: row.seconds > 0 ? row.seconds / 60 : row.elapsed > 0 ? row.elapsed / 60 : null,
    elapsedMinutes: row.elapsed == null ? null : row.elapsed / 60,
    pace: row.pace > 0 ? row.pace : null };
}

export function filterActivities(activities, { types, term, from, through, weekday, ranges, categories }) {
  return activities.filter(row =>
    (!types.size || types.has(row.type)) &&
    (!term || row.name.toLowerCase().includes(term)) &&
    (!from || (row.day && row.day >= from)) &&
    (!through || (row.day && row.day <= through)) &&
    (weekday === "" || row.weekday === Number(weekday)) &&
    categories.every(([key, value]) => value === "" || (row[key] != null && String(row[key]) === value)) &&
    ranges.every(([key, min, max]) => Number.isFinite(row[key]) && row[key] >= min && row[key] <= max));
}

export function sortActivities(activities, key, direction) {
  return [...activities].sort((a, b) => {
    const left = a[key], right = b[key];
    if (left == null || right == null) {
      if (left != null) return -1;
      if (right != null) return 1;
    } else {
      const order = typeof left === "string"
        ? (key === "date" ? (left < right ? -1 : left > right ? 1 : 0) : left.localeCompare(right))
        : left - right;
      if (order) return direction === "asc" ? order : -order;
    }
    return (b.date ?? "").localeCompare(a.date ?? "") || b.id - a.id;
  });
}

export function comparePeriods(activities, endDay, days) {
  const end = new Date(endDay + "T00:00:00Z");
  function dayOffset(days) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  const current = { from: dayOffset(1 - days), through: endDay, count: 0, seconds: 0, km: 0 };
  const previous = { from: dayOffset(1 - 2 * days), through: dayOffset(-days), count: 0, seconds: 0, km: 0 };
  for (const activity of activities) {
    if (!activity.day || activity.day < previous.from || activity.day > current.through) continue;
    const period = activity.day >= current.from ? current : previous;
    period.count++;
    period.seconds += activity.seconds ?? 0;
    period.km += activity.km ?? 0;
  }
  return { current, previous };
}
