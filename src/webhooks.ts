import { timingSafeEqual } from "node:crypto";
import type { AppConfig, OAuthSettings } from "./config.js";
import { getWebhookVerifyToken } from "./config.js";
import { logger } from "./logger.js";
import { AthleteRepository, WebhookRepository, webhookDedupeKey } from "./repositories.js";
import { SyncService } from "./sync.js";
import type { UnknownRecord, WebhookEventInput } from "./types.js";
import type Database from "better-sqlite3";

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as UnknownRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function validateWebhookPayload(payload: unknown): WebhookEventInput | null {
  const event = asRecord(payload);
  if (!event) return null;
  const objectType = event.object_type;
  const aspectType = event.aspect_type;
  const objectId = positiveInteger(event.object_id);
  const ownerId = positiveInteger(event.owner_id);
  const subscriptionId = positiveInteger(event.subscription_id);
  const eventTime = positiveInteger(event.event_time);
  if (
    (objectType !== "activity" && objectType !== "athlete") ||
    (aspectType !== "create" && aspectType !== "update" && aspectType !== "delete") ||
    !objectId ||
    !ownerId
  ) return null;

  const updates = asRecord(event.updates);
  const rawJson = canonicalJson(event);
  return {
    objectType,
    aspectType,
    objectId,
    ownerId,
    subscriptionId,
    eventTime,
    updatesJson: updates ? JSON.stringify(updates) : null,
    rawJson,
    dedupeKey: webhookDedupeKey(rawJson)
  };
}

export function verifyWebhookChallenge(config: AppConfig, mode: string | null, token: string | null): boolean {
  if (mode !== "subscribe" || !token) return false;
  const expected = getWebhookVerifyToken(config);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(token);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export class WebhookWorker {
  private scheduled = new Set<number>();
  private activeDrain: Promise<void> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly config: AppConfig,
    private readonly oauth: OAuthSettings
  ) {}

  enqueue(id: number): Promise<void> {
    this.scheduled.add(id);
    return this.drain();
  }

  enqueueRetryable(): Promise<void> {
    const repository = new WebhookRepository(this.db);
    for (const id of repository.retryable()) this.scheduled.add(id);
    return this.drain();
  }

  private drain(): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    this.activeDrain = this.drainQueue().finally(() => {
      this.activeDrain = null;
      // An event can arrive between the queue's final empty check and this
      // cleanup. Start another drain so that narrow race never strands it.
      if (this.scheduled.size > 0) void this.drain();
    });
    return this.activeDrain;
  }

  private async drainQueue(): Promise<void> {
    while (this.scheduled.size > 0) {
      const [id] = this.scheduled;
      if (id === undefined) break;
      this.scheduled.delete(id);
      await this.process(id);
    }
  }

  private async process(id: number): Promise<void> {
    const events = new WebhookRepository(this.db);
    if (!events.markProcessing(id)) return;
    const event = events.get(id);
    if (!event) return;
    try {
      const athleteId = event.ownerId;
      if (!athleteId) {
        events.markProcessed(id, "ignored");
        return;
      }
      const athletes = new AthleteRepository(this.db);
      // Do not call Strava for events belonging to an account that has not
      // connected to this private installation.
      try {
        const connectedAthleteId = athletes.requireConnectedAthleteId();
        if (connectedAthleteId !== athleteId) {
          events.markProcessed(id, "ignored");
          return;
        }
      } catch {
        events.markProcessed(id, "ignored");
        return;
      }

      const sync = new SyncService(this.db, this.oauth, this.config);
      if (event.objectType === "activity") {
        if (event.aspectType === "delete") sync.softDeleteActivity(athleteId, event.objectId);
        else await sync.syncOneActivity(athleteId, event.objectId);
      } else if (event.objectType === "athlete" && event.aspectType === "update") {
        const updates = event.updatesJson ? JSON.parse(event.updatesJson) as UnknownRecord : {};
        if (updates.authorized === "false" || updates.authorized === false) sync.deactivateAthlete(athleteId);
      }
      events.markProcessed(id);
    } catch {
      const latest = events.get(id);
      events.markFailed(id, latest?.attempts ?? 1);
      logger.warn("Webhook event processing failed; it will be retried", { eventId: id });
    }
  }
}
