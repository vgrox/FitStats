export type UnknownRecord = Record<string, unknown>;

export interface AthleteInput {
  athleteId: number;
  username: string | null;
  firstname: string | null;
  lastname: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  sex: string | null;
  profileMediumUrl: string | null;
  profileUrl: string | null;
  weightKg: number | null;
  rawJson: string;
}

export interface ActivityInput {
  stravaActivityId: number;
  athleteId: number;
  name: string;
  description: string | null;
  sportType: string | null;
  activityType: string | null;
  workoutType: number | null;
  startDate: string | null;
  startDateLocal: string | null;
  timezone: string | null;
  distanceM: number | null;
  movingTimeS: number | null;
  elapsedTimeS: number | null;
  totalElevationGainM: number | null;
  averageSpeedMps: number | null;
  maxSpeedMps: number | null;
  paceSecondsPerKm: number | null;
  averageHeartrateBpm: number | null;
  maxHeartrateBpm: number | null;
  averageCadenceRpm: number | null;
  maxCadenceRpm: number | null;
  averageWatts: number | null;
  weightedAverageWatts: number | null;
  maxWatts: number | null;
  kilojoules: number | null;
  caloriesKcal: number | null;
  achievementCount: number | null;
  kudosCount: number | null;
  commentCount: number | null;
  summaryPolyline: string | null;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  gearId: string | null;
  visibility: string | null;
  trainer: number | null;
  commute: number | null;
  manual: number | null;
  private: number | null;
  stravaCreatedAt: string | null;
  stravaUpdatedAt: string | null;
  rawJson: string;
}

export interface TokenInput {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  tokenType: string | null;
}

export interface StoredToken extends TokenInput {
  athleteId: number;
}

export interface WebhookEventInput {
  subscriptionId: number | null;
  ownerId: number | null;
  objectId: number;
  objectType: "activity" | "athlete";
  aspectType: "create" | "update" | "delete";
  eventTime: number | null;
  updatesJson: string | null;
  rawJson: string;
  dedupeKey: string;
}

export interface StoredWebhookEvent extends WebhookEventInput {
  id: number;
  status: "queued" | "processing" | "processed" | "failed" | "ignored";
  attempts: number;
}

export interface SyncRunSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  oldestActivityDate: string | null;
  newestActivityDate: string | null;
}
