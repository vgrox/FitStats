import type { ActivityInput, AthleteInput, UnknownRecord } from "./types.js";

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function flag(value: unknown): number | null {
  return typeof value === "boolean" ? Number(value) : integer(value) === null ? null : Number(Boolean(value));
}

function coordinates(value: unknown): [number | null, number | null] {
  if (!Array.isArray(value)) return [null, null];
  return [number(value[0]), number(value[1])];
}

const paceSportTypes = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike", "Wheelchair"]);

export function mapAthlete(raw: unknown): AthleteInput {
  const athlete = record(raw);
  const athleteId = integer(athlete.id);
  if (athleteId === null) throw new Error("Strava OAuth response did not include a valid athlete ID.");
  return {
    athleteId,
    username: text(athlete.username),
    firstname: text(athlete.firstname),
    lastname: text(athlete.lastname),
    city: text(athlete.city),
    state: text(athlete.state),
    country: text(athlete.country),
    sex: text(athlete.sex),
    profileMediumUrl: text(athlete.profile_medium),
    profileUrl: text(athlete.profile),
    weightKg: number(athlete.weight),
    rawJson: JSON.stringify(raw)
  };
}

export function mapActivity(raw: unknown, athleteId: number): ActivityInput {
  const activity = record(raw);
  const stravaActivityId = integer(activity.id);
  if (stravaActivityId === null) throw new Error("Strava activity did not include a valid ID.");

  const sportType = text(activity.sport_type) ?? text(activity.type);
  const averageSpeedMps = number(activity.average_speed);
  const [startLat, startLng] = coordinates(activity.start_latlng);
  const [endLat, endLng] = coordinates(activity.end_latlng);
  const map = record(activity.map);
  const paceSecondsPerKm = sportType && paceSportTypes.has(sportType) && averageSpeedMps && averageSpeedMps > 0
    ? 1000 / averageSpeedMps
    : null;

  return {
    stravaActivityId,
    athleteId,
    name: text(activity.name) ?? "Untitled activity",
    description: text(activity.description),
    sportType,
    activityType: text(activity.type),
    workoutType: integer(activity.workout_type),
    startDate: text(activity.start_date),
    startDateLocal: text(activity.start_date_local),
    timezone: text(activity.timezone),
    distanceM: number(activity.distance),
    movingTimeS: integer(activity.moving_time),
    elapsedTimeS: integer(activity.elapsed_time),
    totalElevationGainM: number(activity.total_elevation_gain),
    averageSpeedMps,
    maxSpeedMps: number(activity.max_speed),
    paceSecondsPerKm,
    averageHeartrateBpm: number(activity.average_heartrate),
    maxHeartrateBpm: number(activity.max_heartrate),
    averageCadenceRpm: number(activity.average_cadence),
    maxCadenceRpm: number(activity.max_cadence),
    averageWatts: number(activity.average_watts),
    weightedAverageWatts: number(activity.weighted_average_watts),
    maxWatts: number(activity.max_watts),
    kilojoules: number(activity.kilojoules),
    caloriesKcal: number(activity.calories),
    achievementCount: integer(activity.achievement_count),
    kudosCount: integer(activity.kudos_count),
    commentCount: integer(activity.comment_count),
    summaryPolyline: text(map.summary_polyline),
    startLat,
    startLng,
    endLat,
    endLng,
    gearId: text(activity.gear_id),
    visibility: text(activity.visibility),
    trainer: flag(activity.trainer),
    commute: flag(activity.commute),
    manual: flag(activity.manual),
    private: flag(activity.private),
    stravaCreatedAt: text(activity.created_at),
    stravaUpdatedAt: text(activity.updated_at),
    rawJson: JSON.stringify(raw)
  };
}
