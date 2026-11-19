import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { decryptValue, encryptValue } from "./crypto.js";
import type {
  ActivityInput,
  AthleteInput,
  StoredToken,
  StoredWebhookEvent,
  TokenInput,
  WebhookEventInput
} from "./types.js";

const now = (): string => new Date().toISOString();

export class AthleteRepository {
  constructor(private readonly db: Database.Database) {}

  saveAthlete(athlete: AthleteInput): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO athletes (
        athlete_id, username, firstname, lastname, city, state, country, sex,
        profile_medium_url, profile_url, weight_kg, is_authorized, raw_json, created_at, updated_at
      ) VALUES (
        @athleteId, @username, @firstname, @lastname, @city, @state, @country, @sex,
        @profileMediumUrl, @profileUrl, @weightKg, 1, @rawJson, @createdAt, @updatedAt
      ) ON CONFLICT(athlete_id) DO UPDATE SET
        username = excluded.username, firstname = excluded.firstname, lastname = excluded.lastname,
        city = excluded.city, state = excluded.state, country = excluded.country, sex = excluded.sex,
        profile_medium_url = excluded.profile_medium_url, profile_url = excluded.profile_url,
        weight_kg = excluded.weight_kg, is_authorized = 1, raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `).run({ ...athlete, createdAt: timestamp, updatedAt: timestamp });
  }

  connectionStatus(): { athleteId: number; isAuthorized: boolean; expiresAt: number | null } | null {
    return this.db.prepare(`
      SELECT a.athlete_id AS athleteId, a.is_authorized AS isAuthorized, t.expires_at AS expiresAt
      FROM athletes a
      LEFT JOIN strava_tokens t ON t.athlete_id = a.athlete_id AND t.revoked_at IS NULL
      WHERE a.is_authorized = 1
      ORDER BY a.updated_at DESC
      LIMIT 1
    `).get() as { athleteId: number; isAuthorized: boolean; expiresAt: number | null } | null;
  }

  requireConnectedAthleteId(): number {
    const row = this.db.prepare(`
      SELECT a.athlete_id AS athleteId
      FROM athletes a JOIN strava_tokens t ON t.athlete_id = a.athlete_id
      WHERE a.is_authorized = 1 AND t.revoked_at IS NULL
      ORDER BY a.updated_at DESC LIMIT 1
    `).get() as { athleteId: number } | undefined;
    if (!row) throw new Error("No Strava account is connected. Start the local service and open /connect/strava first.");
    return row.athleteId;
  }

  deactivate(athleteId: number): void {
    const timestamp = now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE athletes SET is_authorized = 0, updated_at = ? WHERE athlete_id = ?").run(timestamp, athleteId);
      this.db.prepare("UPDATE strava_tokens SET revoked_at = ?, updated_at = ? WHERE athlete_id = ?").run(timestamp, timestamp, athleteId);
    })();
  }
}

export class TokenRepository {
  constructor(private readonly db: Database.Database, private readonly keyHex: string) {}

  save(athleteId: number, token: TokenInput): void {
    const access = encryptValue(token.accessToken, this.keyHex);
    const refresh = encryptValue(token.refreshToken, this.keyHex);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO strava_tokens (
        athlete_id, access_token_ciphertext, access_token_iv, access_token_auth_tag,
        refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag,
        expires_at, scope, token_type, revoked_at, created_at, updated_at
      ) VALUES (
        @athleteId, @accessCiphertext, @accessIv, @accessAuthTag,
        @refreshCiphertext, @refreshIv, @refreshAuthTag,
        @expiresAt, @scope, @tokenType, NULL, @createdAt, @updatedAt
      ) ON CONFLICT(athlete_id) DO UPDATE SET
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_iv = excluded.access_token_iv,
        access_token_auth_tag = excluded.access_token_auth_tag,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        refresh_token_iv = excluded.refresh_token_iv,
        refresh_token_auth_tag = excluded.refresh_token_auth_tag,
        expires_at = excluded.expires_at, scope = excluded.scope, token_type = excluded.token_type,
        revoked_at = NULL, updated_at = excluded.updated_at
    `).run({
      athleteId,
      accessCiphertext: access.ciphertext,
      accessIv: access.iv,
      accessAuthTag: access.authTag,
      refreshCiphertext: refresh.ciphertext,
      refreshIv: refresh.iv,
      refreshAuthTag: refresh.authTag,
      expiresAt: token.expiresAt,
      scope: token.scope,
      tokenType: token.tokenType,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  get(athleteId: number): StoredToken | null {
    const row = this.db.prepare(`
      SELECT * FROM strava_tokens WHERE athlete_id = ? AND revoked_at IS NULL
    `).get(athleteId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      athleteId,
      accessToken: decryptValue({
        ciphertext: String(row.access_token_ciphertext), iv: String(row.access_token_iv), authTag: String(row.access_token_auth_tag)
      }, this.keyHex),
      refreshToken: decryptValue({
        ciphertext: String(row.refresh_token_ciphertext), iv: String(row.refresh_token_iv), authTag: String(row.refresh_token_auth_tag)
      }, this.keyHex),
      expiresAt: Number(row.expires_at),
      scope: String(row.scope),
      tokenType: typeof row.token_type === "string" ? row.token_type : null
    };
  }
}

export class ActivityRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(activity: ActivityInput): "inserted" | "updated" | "skipped" {
    const existing = this.db.prepare(
      "SELECT raw_json AS rawJson, is_deleted AS isDeleted FROM activities WHERE strava_activity_id = ?"
    ).get(activity.stravaActivityId) as { rawJson: string; isDeleted: number } | undefined;
    if (existing && existing.rawJson === activity.rawJson && !existing.isDeleted) return "skipped";

    const timestamp = now();
    this.db.prepare(`
      INSERT INTO activities (
        strava_activity_id, athlete_id, name, description, sport_type, activity_type, workout_type,
        start_date, start_date_local, timezone, distance_m, moving_time_s, elapsed_time_s,
        total_elevation_gain_m, average_speed_mps, max_speed_mps, pace_seconds_per_km,
        average_heartrate_bpm, max_heartrate_bpm, average_cadence_rpm, max_cadence_rpm,
        average_watts, weighted_average_watts, max_watts, kilojoules, calories_kcal,
        achievement_count, kudos_count, comment_count, summary_polyline, start_lat, start_lng,
        end_lat, end_lng, gear_id, visibility, trainer, commute, manual, private,
        is_deleted, deleted_at, strava_created_at, strava_updated_at, raw_json, created_at, updated_at
      ) VALUES (
        @stravaActivityId, @athleteId, @name, @description, @sportType, @activityType, @workoutType,
        @startDate, @startDateLocal, @timezone, @distanceM, @movingTimeS, @elapsedTimeS,
        @totalElevationGainM, @averageSpeedMps, @maxSpeedMps, @paceSecondsPerKm,
        @averageHeartrateBpm, @maxHeartrateBpm, @averageCadenceRpm, @maxCadenceRpm,
        @averageWatts, @weightedAverageWatts, @maxWatts, @kilojoules, @caloriesKcal,
        @achievementCount, @kudosCount, @commentCount, @summaryPolyline, @startLat, @startLng,
        @endLat, @endLng, @gearId, @visibility, @trainer, @commute, @manual, @private,
        0, NULL, @stravaCreatedAt, @stravaUpdatedAt, @rawJson, @createdAt, @updatedAt
      ) ON CONFLICT(strava_activity_id) DO UPDATE SET
        athlete_id = excluded.athlete_id, name = excluded.name, description = excluded.description,
        sport_type = excluded.sport_type, activity_type = excluded.activity_type, workout_type = excluded.workout_type,
        start_date = excluded.start_date, start_date_local = excluded.start_date_local, timezone = excluded.timezone,
        distance_m = excluded.distance_m, moving_time_s = excluded.moving_time_s, elapsed_time_s = excluded.elapsed_time_s,
        total_elevation_gain_m = excluded.total_elevation_gain_m, average_speed_mps = excluded.average_speed_mps,
        max_speed_mps = excluded.max_speed_mps, pace_seconds_per_km = excluded.pace_seconds_per_km,
        average_heartrate_bpm = excluded.average_heartrate_bpm, max_heartrate_bpm = excluded.max_heartrate_bpm,
        average_cadence_rpm = excluded.average_cadence_rpm, max_cadence_rpm = excluded.max_cadence_rpm,
        average_watts = excluded.average_watts, weighted_average_watts = excluded.weighted_average_watts,
        max_watts = excluded.max_watts, kilojoules = excluded.kilojoules, calories_kcal = excluded.calories_kcal,
        achievement_count = excluded.achievement_count, kudos_count = excluded.kudos_count,
        comment_count = excluded.comment_count, summary_polyline = excluded.summary_polyline,
        start_lat = excluded.start_lat, start_lng = excluded.start_lng, end_lat = excluded.end_lat, end_lng = excluded.end_lng,
        gear_id = excluded.gear_id, visibility = excluded.visibility, trainer = excluded.trainer,
        commute = excluded.commute, manual = excluded.manual, private = excluded.private,
        is_deleted = 0, deleted_at = NULL, strava_created_at = excluded.strava_created_at,
        strava_updated_at = excluded.strava_updated_at, raw_json = excluded.raw_json, updated_at = excluded.updated_at
    `).run({ ...activity, createdAt: timestamp, updatedAt: timestamp });
    return existing ? "updated" : "inserted";
  }

  softDelete(athleteId: number, activityId: number): void {
    const timestamp = now();
    this.db.prepare(`
      UPDATE activities SET is_deleted = 1, deleted_at = ?, updated_at = ?
      WHERE athlete_id = ? AND strava_activity_id = ?
    `).run(timestamp, timestamp, athleteId, activityId);
  }

  nextActivitiesWithoutStreams(limit: number): number[] {
    return (this.db.prepare(`
      SELECT a.strava_activity_id AS id
      FROM activities a
      LEFT JOIN activity_streams s ON s.activity_id = a.strava_activity_id
      WHERE a.is_deleted = 0
      GROUP BY a.strava_activity_id
      HAVING COUNT(s.stream_type) = 0
      ORDER BY a.start_date DESC
      LIMIT ?
    `).all(limit) as Array<{ id: number }>).map((row) => row.id);
  }
}

export class StreamRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(activityId: number, streamType: string, stream: Record<string, unknown>): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO activity_streams (
        activity_id, stream_type, series_type, resolution, original_size, data_json, raw_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id, stream_type) DO UPDATE SET
        series_type = excluded.series_type, resolution = excluded.resolution,
        original_size = excluded.original_size, data_json = excluded.data_json,
        raw_json = excluded.raw_json, fetched_at = excluded.fetched_at
    `).run(
      activityId,
      streamType,
      typeof stream.series_type === "string" ? stream.series_type : null,
      typeof stream.resolution === "string" ? stream.resolution : null,
      typeof stream.original_size === "number" ? stream.original_size : null,
      JSON.stringify(stream.data ?? []),
      JSON.stringify(stream),
      timestamp
    );
  }
}

export class SyncStateRepository {
  constructor(private readonly db: Database.Database) {}

  get(scope: string): { cursorJson: string | null; lastSuccessfulSyncAt: string | null; checkpointUpdatedAfter: number | null } | null {
    return this.db.prepare(`
      SELECT cursor_json AS cursorJson, last_successful_sync_at AS lastSuccessfulSyncAt,
        checkpoint_updated_after AS checkpointUpdatedAfter
      FROM sync_state WHERE scope = ?
    `).get(scope) as { cursorJson: string | null; lastSuccessfulSyncAt: string | null; checkpointUpdatedAfter: number | null } | null;
  }

  progress(scope: string, athleteId: number, cursorJson: string, checkpointUpdatedAfter: number | null = null): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO sync_state (scope, athlete_id, checkpoint_updated_after, cursor_json, last_attempt_at, last_error, consecutive_failures, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, 0, ?)
      ON CONFLICT(scope) DO UPDATE SET athlete_id = excluded.athlete_id,
        checkpoint_updated_after = COALESCE(excluded.checkpoint_updated_after, sync_state.checkpoint_updated_after),
        cursor_json = excluded.cursor_json, last_attempt_at = excluded.last_attempt_at,
        last_error = NULL, consecutive_failures = 0, updated_at = excluded.updated_at
    `).run(scope, athleteId, checkpointUpdatedAfter, cursorJson, timestamp, timestamp);
  }

  success(scope: string, athleteId: number, checkpointUpdatedAfter: number | null = null, inserted: number | null = null): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO sync_state (scope, athlete_id, last_successful_sync_at, checkpoint_updated_after, cursor_json, last_attempt_at, last_error, consecutive_failures, updated_at, last_successful_insert_count)
      VALUES (?, ?, ?, ?, NULL, ?, NULL, 0, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET athlete_id = excluded.athlete_id,
        last_successful_sync_at = excluded.last_successful_sync_at,
        last_successful_insert_count = excluded.last_successful_insert_count,
        checkpoint_updated_after = COALESCE(excluded.checkpoint_updated_after, sync_state.checkpoint_updated_after),
        cursor_json = NULL, last_attempt_at = excluded.last_attempt_at,
        last_error = NULL, consecutive_failures = 0, updated_at = excluded.updated_at
    `).run(scope, athleteId, timestamp, checkpointUpdatedAfter, timestamp, timestamp, inserted);
  }

  failure(scope: string, athleteId: number, message: string): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO sync_state (scope, athlete_id, last_attempt_at, last_error, consecutive_failures, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET athlete_id = excluded.athlete_id,
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
        consecutive_failures = sync_state.consecutive_failures + 1, updated_at = excluded.updated_at
    `).run(scope, athleteId, timestamp, message, timestamp);
  }
}

export class WebhookRepository {
  constructor(private readonly db: Database.Database) {}

  record(event: WebhookEventInput): { id: number; duplicate: boolean } {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_events (
        dedupe_key, subscription_id, owner_id, object_id, object_type, aspect_type,
        event_time, updates_json, raw_json, received_at, status
      ) VALUES (
        @dedupeKey, @subscriptionId, @ownerId, @objectId, @objectType, @aspectType,
        @eventTime, @updatesJson, @rawJson, @receivedAt, 'queued'
      )
    `).run({ ...event, receivedAt: now() });
    const row = this.db.prepare("SELECT id FROM webhook_events WHERE dedupe_key = ?").get(event.dedupeKey) as { id: number };
    return { id: row.id, duplicate: result.changes === 0 };
  }

  get(id: number): StoredWebhookEvent | null {
    const row = this.db.prepare(`
      SELECT id, dedupe_key AS dedupeKey, subscription_id AS subscriptionId, owner_id AS ownerId,
        object_id AS objectId, object_type AS objectType, aspect_type AS aspectType,
        event_time AS eventTime, updates_json AS updatesJson, raw_json AS rawJson, status, attempts
      FROM webhook_events WHERE id = ?
    `).get(id) as StoredWebhookEvent | undefined;
    return row ?? null;
  }

  retryable(limit = 50): number[] {
    const timestamp = now();
    return (this.db.prepare(`
      SELECT id FROM webhook_events
      WHERE status = 'queued' OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= ?))
      ORDER BY id ASC LIMIT ?
    `).all(timestamp, limit) as Array<{ id: number }>).map((row) => row.id);
  }

  markProcessing(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, last_error = NULL
      WHERE id = ? AND status IN ('queued', 'failed')
    `).run(id);
    return result.changes === 1;
  }

  markProcessed(id: number, status: "processed" | "ignored" = "processed"): void {
    this.db.prepare(`
      UPDATE webhook_events SET status = ?, processed_at = ?, next_retry_at = NULL, last_error = NULL WHERE id = ?
    `).run(status, now(), id);
  }

  markFailed(id: number, attempts: number): void {
    const delaySeconds = Math.min(3600, 5 ** Math.min(attempts, 5));
    const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    this.db.prepare(`
      UPDATE webhook_events SET status = 'failed', next_retry_at = ?, last_error = 'Strava processing failed' WHERE id = ?
    `).run(nextRetryAt, id);
  }

  resetStaleProcessing(): void {
    const threshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    this.db.prepare(`
      UPDATE webhook_events SET status = 'failed', next_retry_at = ?, last_error = 'Recovered after interrupted processing'
      WHERE status = 'processing' AND received_at < ?
    `).run(now(), threshold);
  }
}

export class WebhookSubscriptionRepository {
  constructor(private readonly db: Database.Database) {}

  saveActive(subscriptionId: number, callbackUrl: string): void {
    const timestamp = now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE webhook_subscriptions SET is_active = 0, updated_at = ? WHERE is_active = 1").run(timestamp);
      this.db.prepare(`
        INSERT INTO webhook_subscriptions (subscription_id, callback_url, is_active, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET
          callback_url = excluded.callback_url, is_active = 1, updated_at = excluded.updated_at
      `).run(subscriptionId, callbackUrl, timestamp, timestamp);
    })();
  }

  deactivate(subscriptionId: number): void {
    this.db.prepare(
      "UPDATE webhook_subscriptions SET is_active = 0, updated_at = ? WHERE subscription_id = ?"
    ).run(now(), subscriptionId);
  }

  deactivateAll(): void {
    this.db.prepare(
      "UPDATE webhook_subscriptions SET is_active = 0, updated_at = ? WHERE is_active = 1"
    ).run(now());
  }

  activeSubscriptionId(): number | null {
    const row = this.db.prepare(`
      SELECT subscription_id AS subscriptionId
      FROM webhook_subscriptions
      WHERE is_active = 1
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as { subscriptionId: number } | undefined;
    return row?.subscriptionId ?? null;
  }
}

export function webhookDedupeKey(rawJson: string): string {
  return createHash("sha256").update(rawJson).digest("hex");
}
