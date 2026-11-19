import { getOAuthSettings, getWebhookSubscriptionSettings, ConfigurationError, loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { AthleteRepository, WebhookSubscriptionRepository } from "./repositories.js";
import { createWebhookSubscription, deleteWebhookSubscription, getWebhookSubscription } from "./strava-client.js";
import { importActivityArchive, enrichActivities } from "./activity-details.js";
import { StravaClient } from "./strava-client.js";
import { TokenRepository } from "./repositories.js";
import { importStravaExport } from "./strava-export.js";
import { SyncService } from "./sync.js";
import { WebhookWorker } from "./webhooks.js";

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parsePositiveLimit(argument: string | undefined, fallback: number): number {
  if (!argument) return fallback;
  const match = argument.match(/^--(?:limit|days)=(\d+)$/);
  if (!match) throw new Error(`Unexpected argument: ${argument}`);
  const value = Number.parseInt(match[1], 10);
  if (value < 1) throw new Error("The supplied value must be a positive integer.");
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const option = process.argv[3];
  const config = loadConfig();
  const db = openDatabase(config);
  try {
    switch (command) {
      case "strava:import-archive":
        if (!option) throw new Error("Provide the Strava export ZIP path.");
        print(await importActivityArchive(db, option));
        break;
      case "strava:enrich": {
        const oauth = getOAuthSettings(config);
        const athleteId = new AthleteRepository(db).requireConnectedAthleteId();
        await enrichActivities(db, new StravaClient(oauth, new TokenRepository(db, oauth.tokenEncryptionKey)), athleteId);
        break;
      }
      case "db:migrate":
        print({ ok: true, databasePath: config.databasePath, message: "SQLite schema is current." });
        return;
      case "strava:status": {
        const connection = new AthleteRepository(db).connectionStatus();
        print({
          connected: Boolean(connection),
          athleteId: connection?.athleteId ?? null,
          tokenExpiresAt: connection?.expiresAt ?? null,
          databasePath: config.databasePath
        });
        return;
      }
      case "strava:import": {
        const oauth = getOAuthSettings(config);
        const summary = await new SyncService(db, oauth, config).importHistory();
        print({ mode: "historical-import", ...summary });
        if (summary.failed > 0) process.exitCode = 1;
        return;
      }
      case "strava:import-export": {
        if (!option || process.argv.length !== 4) {
          throw new Error("Usage: npm run strava:import-export -- /path/to/activities.csv");
        }
        print({ mode: "strava-export", ...importStravaExport(db, option), databasePath: config.databasePath });
        return;
      }
      case "strava:sync": {
        const oauth = getOAuthSettings(config);
        const days = parsePositiveLimit(option, config.syncLookbackDays);
        const summary = await new SyncService(db, oauth, config).incrementalSync(days);
        print({ mode: "incremental-sync", lookbackDays: days, ...summary });
        if (summary.failed > 0) process.exitCode = 1;
        return;
      }
      case "strava:streams:backfill": {
        const oauth = getOAuthSettings(config);
        const limit = parsePositiveLimit(option, 10);
        const summary = await new SyncService(db, oauth, config).backfillStreams(limit);
        print({ mode: "stream-backfill", limit, ...summary });
        if (summary.failed > 0) process.exitCode = 1;
        return;
      }
      case "strava:webhook:subscribe": {
        const settings = getWebhookSubscriptionSettings(config);
        const subscriptionId = await createWebhookSubscription(settings);
        new WebhookSubscriptionRepository(db).saveActive(subscriptionId, settings.callbackUrl);
        print({ ok: true, subscriptionId, callbackUrl: settings.callbackUrl });
        return;
      }
      case "strava:webhook:status": {
        const settings = getWebhookSubscriptionSettings(config);
        const subscription = await getWebhookSubscription(settings);
        if (subscription) {
          new WebhookSubscriptionRepository(db).saveActive(subscription.id, subscription.callbackUrl ?? settings.callbackUrl);
        } else {
          new WebhookSubscriptionRepository(db).deactivateAll();
        }
        print({ subscribed: Boolean(subscription), subscriptionId: subscription?.id ?? null, callbackUrl: subscription?.callbackUrl ?? null });
        return;
      }
      case "strava:webhook:replace": {
        const settings = getWebhookSubscriptionSettings(config);
        const existing = await getWebhookSubscription(settings);
        if (existing) {
          new WebhookSubscriptionRepository(db).deactivate(existing.id);
          await deleteWebhookSubscription(settings, existing.id);
        }
        const subscriptionId = await createWebhookSubscription(settings);
        new WebhookSubscriptionRepository(db).saveActive(subscriptionId, settings.callbackUrl);
        print({ ok: true, replacedSubscriptionId: existing?.id ?? null, subscriptionId, callbackUrl: settings.callbackUrl });
        return;
      }
      case "strava:webhook:retry": {
        const oauth = getOAuthSettings(config);
        const worker = new WebhookWorker(db, config, oauth);
        await worker.enqueueRetryable();
        print({ ok: true, message: "Queued and retryable webhook events were processed." });
        return;
      }
      default:
        throw new Error("Use one of: db:migrate, strava:status, strava:import, strava:import-export, strava:import-archive, strava:enrich, strava:sync, strava:streams:backfill, strava:webhook:subscribe, strava:webhook:status, strava:webhook:replace, strava:webhook:retry.");
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigurationError || error instanceof Error
    ? error.message
    : "FitStats command failed.";
  console.error(message);
  process.exitCode = 1;
});
