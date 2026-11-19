import type { AppConfig, OAuthSettings } from "./config.js";
import type Database from "better-sqlite3";
import { mapActivity } from "./activity-mapper.js";
import { logger } from "./logger.js";
import {
  ActivityRepository,
  AthleteRepository,
  StreamRepository,
  SyncStateRepository,
  TokenRepository
} from "./repositories.js";
import { StravaClient } from "./strava-client.js";
import type { SyncRunSummary } from "./types.js";

function blankSummary(): SyncRunSummary {
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, oldestActivityDate: null, newestActivityDate: null };
}

function addDate(summary: SyncRunSummary, date: string | null): void {
  if (!date) return;
  if (!summary.oldestActivityDate || date < summary.oldestActivityDate) summary.oldestActivityDate = date;
  if (!summary.newestActivityDate || date > summary.newestActivityDate) summary.newestActivityDate = date;
}

function parsePage(cursorJson: string | null): number {
  if (!cursorJson) return 1;
  try {
    const parsed = JSON.parse(cursorJson) as { page?: unknown };
    return typeof parsed.page === "number" && parsed.page > 0 ? parsed.page : 1;
  } catch {
    return 1;
  }
}

export class SyncService {
  private readonly activities: ActivityRepository;
  private readonly athletes: AthleteRepository;
  private readonly streams: StreamRepository;
  private readonly state: SyncStateRepository;
  private readonly client: StravaClient;

  constructor(db: Database.Database, oauth: OAuthSettings, private readonly config: AppConfig) {
    this.activities = new ActivityRepository(db);
    this.athletes = new AthleteRepository(db);
    this.streams = new StreamRepository(db);
    this.state = new SyncStateRepository(db);
    this.client = new StravaClient(oauth, new TokenRepository(db, oauth.tokenEncryptionKey));
  }

  async importHistory(): Promise<SyncRunSummary> {
    const athleteId = this.athletes.requireConnectedAthleteId();
    const scope = `historical-import:${athleteId}`;
    const checkpoint = this.state.get(scope);
    return this.runPaged(scope, athleteId, parsePage(checkpoint?.cursorJson ?? null));
  }

  async incrementalSync(days = this.config.syncLookbackDays): Promise<SyncRunSummary> {
    const athleteId = this.athletes.requireConnectedAthleteId();
    const scope = `incremental-sync:${athleteId}`;
    const checkpoint = this.state.get(scope);
    const page = parsePage(checkpoint?.cursorJson ?? null);
    const after = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    return this.runPaged(scope, athleteId, page, after);
  }

  async backfillStreams(limit = 10): Promise<{ selected: number; activitiesCompleted: number; streamsStored: number; failed: number }> {
    const athleteId = this.athletes.requireConnectedAthleteId();
    const ids = this.activities.nextActivitiesWithoutStreams(limit);
    const summary = { selected: ids.length, activitiesCompleted: 0, streamsStored: 0, failed: 0 };
    for (const id of ids) {
      try {
        const result = await this.client.getActivityStreams(athleteId, id);
        if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("Unexpected stream payload.");
        for (const [streamType, stream] of Object.entries(result)) {
          if (stream && typeof stream === "object" && !Array.isArray(stream)) {
            this.streams.upsert(id, streamType, stream as Record<string, unknown>);
            summary.streamsStored += 1;
          }
        }
        summary.activitiesCompleted += 1;
      } catch {
        summary.failed += 1;
        logger.warn("Optional stream backfill failed for one activity", { activityId: id });
      }
    }
    return summary;
  }

  async syncOneActivity(athleteId: number, activityId: number): Promise<void> {
    const raw = await this.client.getActivity(athleteId, activityId);
    this.activities.upsert(mapActivity(raw, athleteId));
  }

  softDeleteActivity(athleteId: number, activityId: number): void {
    this.activities.softDelete(athleteId, activityId);
  }

  deactivateAthlete(athleteId: number): void {
    this.athletes.deactivate(athleteId);
  }

  private async runPaged(scope: string, athleteId: number, initialPage: number, after?: number): Promise<SyncRunSummary> {
    const summary = blankSummary();
    let page = initialPage;
    try {
      while (true) {
        const pageItems = await this.client.listActivities(athleteId, page, after);
        if (pageItems.length === 0) break;
        for (const raw of pageItems) {
          summary.fetched += 1;
          try {
            const activity = mapActivity(raw, athleteId);
            const outcome = this.activities.upsert(activity);
            summary[outcome] += 1;
            addDate(summary, activity.startDate);
          } catch {
            // A malformed single activity must not prevent a resumable import
            // from progressing through the rest of the account history.
            summary.failed += 1;
            logger.warn("Skipped one malformed Strava activity during sync", {});
          }
        }
        page += 1;
        this.state.progress(scope, athleteId, JSON.stringify({ page }), after ?? null);
      }
      this.state.success(scope, athleteId, after ?? null, summary.inserted);
    } catch {
      summary.failed += 1;
      this.state.failure(scope, athleteId, "Strava import or sync failed");
      logger.warn("A Strava import or sync did not complete; resume state was retained", {});
    }
    return summary;
  }
}
