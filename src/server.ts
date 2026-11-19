import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { configurationStatus, getOAuthSettings, getWebhookVerifyToken, ConfigurationError, loadConfig, type AppConfig } from "./config.js";
import { mapAthlete } from "./activity-mapper.js";
import { createDashboardHandler, isMilestonePath } from "./dashboard-routes.js";
import { openDatabase } from "./db.js";
import { logger } from "./logger.js";
import { AthleteRepository, TokenRepository, WebhookRepository, WebhookSubscriptionRepository } from "./repositories.js";
import { StravaClient } from "./strava-client.js";
import { validateWebhookPayload, verifyWebhookChallenge, WebhookWorker } from "./webhooks.js";

interface OAuthState {
  expiresAt: number;
}

const oauthStates = new Map<string, OAuthState>();

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function safeStateMatches(state: string | null): boolean {
  if (!state) return false;
  const current = oauthStates.get(state);
  oauthStates.delete(state);
  return Boolean(current && current.expiresAt > Date.now());
}

function homepage(config: AppConfig, db: Database.Database): string {
  const connection = new AthleteRepository(db).connectionStatus();
  const status = configurationStatus(config);
  const connect = status.oauthReady
    ? `<p><a href="/connect/strava">Connect Strava</a></p>`
    : "<p>Configuration is incomplete. Copy <code>.env.example</code> to <code>.env</code>, then add the required values.</p>";
  const connectionText = connection ? "A Strava account is connected." : "No Strava account is connected yet.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>FitStats sync</title></head><body><h1>FitStats sync service</h1><p>${connectionText}</p>${connect}<p><a href="/health">Health status</a> · <a href="/strava/status">Strava status</a></p></body></html>`;
}

function requiredScopeWasGranted(scope: string | null): boolean {
  return Boolean(scope?.split(/[ ,]+/).includes("activity:read_all"));
}

export function createFitStatsServer(config = loadConfig(), dashboardPassword?: string) {
  const db = openDatabase(config);
  new WebhookRepository(db).resetStaleProcessing();
  let retryTimer: NodeJS.Timeout | undefined;
  let webhookWorker: WebhookWorker | null = null;

  const enqueue = (id: number): void => {
    try {
      webhookWorker ??= new WebhookWorker(db, config, getOAuthSettings(config));
      void webhookWorker.enqueue(id);
    } catch {
      // The event has already been durably recorded. It will be picked up
      // after configuration is completed and the service is restarted.
    }
  };

  const dashboard = dashboardPassword ? createDashboardHandler(db) : undefined;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  const expectedAuth = dashboardPassword
    ? digest("Basic " + Buffer.from("fitstats:" + dashboardPassword).toString("base64"))
    : undefined;

  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (dashboard && expectedAuth) {
      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (path !== "/webhooks/strava") {
        if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expectedAuth)) {
          response.setHeader("WWW-Authenticate", 'Basic realm="FitStats", charset="UTF-8"');
          sendJson(response, 401, { error: "Sign in to FitStats." });
          return;
        }
        if (["/", "/api/activities", "/style.css", "/fitstats-icon.png", "/dashboard.js", "/activity.js", "/activity-filters.js"].includes(path) || isMilestonePath(path) || /^\/api\/activities\/\d+$/.test(path)) {
          dashboard(request, response);
          return;
        }
      }
    }
    void handleRequest(request, response, config, db, enqueue);
  });

  return {
    server,
    db,
    start(): Promise<void> {
      try {
        webhookWorker = new WebhookWorker(db, config, getOAuthSettings(config));
        void webhookWorker.enqueueRetryable();
        retryTimer = setInterval(() => void webhookWorker?.enqueueRetryable(), 30_000);
      } catch {
        // Starting without credentials is supported for setup and schema verification.
      }
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("error", onError);
          reject(error);
        };
        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      if (retryTimer) clearInterval(retryTimer);
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  db: Database.Database,
  enqueueWebhook: (id: number) => void
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";
  try {
    if (method === "GET" && url.pathname === "/") {
      sendHtml(response, 200, homepage(config, db));
      return;
    }
    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/strava/status")) {
      const connection = new AthleteRepository(db).connectionStatus();
      sendJson(response, 200, {
        ok: true,
        configuration: configurationStatus(config),
        connected: Boolean(connection),
        athleteId: connection?.athleteId ?? null,
        tokenExpiresAt: connection?.expiresAt ?? null
      });
      return;
    }
    if (method === "GET" && url.pathname === "/connect/strava") {
      const settings = getOAuthSettings(config);
      const state = randomBytes(32).toString("hex");
      oauthStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 });
      const authorize = new URL("https://www.strava.com/oauth/authorize");
      authorize.search = new URLSearchParams({
        client_id: settings.clientId,
        redirect_uri: settings.redirectUri,
        response_type: "code",
        approval_prompt: "auto",
        scope: "activity:read_all",
        state
      }).toString();
      response.writeHead(302, { location: authorize.toString(), "cache-control": "no-store" });
      response.end();
      return;
    }
    if (method === "GET" && url.pathname === "/oauth/strava/callback") {
      const error = url.searchParams.get("error");
      if (error) {
        sendHtml(response, 400, "<h1>Strava connection was not approved.</h1><p>You can close this tab and try again.</p>");
        return;
      }
      if (!safeStateMatches(url.searchParams.get("state"))) {
        sendHtml(response, 400, "<h1>Invalid or expired OAuth state.</h1><p>Return to the local service and start the connection again.</p>");
        return;
      }
      const code = url.searchParams.get("code");
      const scope = url.searchParams.get("scope");
      if (!code || !scope || !requiredScopeWasGranted(scope)) {
        sendHtml(response, 400, "<h1>Required Strava permission was not granted.</h1><p>FitStats needs activity:read_all to sync all of your activities, including Only You activities.</p>");
        return;
      }
      const settings = getOAuthSettings(config);
      const client = new StravaClient(settings, new TokenRepository(db, settings.tokenEncryptionKey));
      const exchange = await client.exchangeAuthorizationCode(code, scope);
      const athlete = mapAthlete(exchange.athlete);
      db.transaction(() => {
        new AthleteRepository(db).saveAthlete(athlete);
        new TokenRepository(db, settings.tokenEncryptionKey).save(athlete.athleteId, exchange.token);
      })();
      sendHtml(response, 200, "<h1>Strava connected.</h1><p>You can close this tab and run <code>npm run strava:import</code>.</p>");
      return;
    }
    if (method === "GET" && url.pathname === "/webhooks/strava") {
      const verified = verifyWebhookChallenge(
        config,
        url.searchParams.get("hub.mode"),
        url.searchParams.get("hub.verify_token")
      );
      if (!verified) {
        sendJson(response, 403, { error: "Webhook verification failed." });
        return;
      }
      sendJson(response, 200, { "hub.challenge": url.searchParams.get("hub.challenge") });
      return;
    }
    if (method === "POST" && url.pathname === "/webhooks/strava") {
      // Strava's POST event payload does not contain the verification token or a
      // signature. The token is verified during the GET subscription challenge.
      getOAuthSettings(config);
      getWebhookVerifyToken(config);
      const event = validateWebhookPayload(await readJson(request));
      if (!event) {
        sendJson(response, 400, { error: "Invalid webhook event." });
        return;
      }
      const recorded = new WebhookRepository(db).record(event);
      const expectedSubscriptionId = new WebhookSubscriptionRepository(db).activeSubscriptionId();
      const subscriptionMatches = expectedSubscriptionId !== null && event.subscriptionId === expectedSubscriptionId;
      if (!subscriptionMatches) {
        // Strava does not sign POST events. Keep this audit record, but never
        // let an event from an unknown subscription modify local activity data.
        if (!recorded.duplicate) new WebhookRepository(db).markProcessed(recorded.id, "ignored");
        sendJson(response, 200, { received: true, duplicate: recorded.duplicate, ignored: true });
        return;
      }
      sendJson(response, 200, { received: true, duplicate: recorded.duplicate, ignored: false });
      if (!recorded.duplicate) enqueueWebhook(recorded.id);
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      sendJson(response, 503, { error: error.message });
      return;
    }
    logger.error("Local service request failed", { path: url.pathname });
    sendJson(response, 500, { error: "The local service could not complete this request." });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hosted = process.argv.includes("--hosted");
  const password = process.env.FITSTATS_DASHBOARD_PASSWORD;
  if (hosted && (!password || password.length < 24)) {
    throw new ConfigurationError("Hosted FitStats requires a dashboard password of at least 24 characters.");
  }
  const config = loadConfig(hosted
    ? { ...process.env, FITSTATS_HOST: "0.0.0.0", FITSTATS_PORT: process.env.PORT }
    : process.env);
  const runtime = createFitStatsServer(config, hosted ? password : undefined);
  runtime.start().then(() => {
    const status = configurationStatus(config);
    logger.info("FitStats local service started", { host: config.host, port: config.port, oauthReady: status.oauthReady });
    if (!status.oauthReady) logger.warn("Strava configuration is incomplete; the service remains available for setup", {});
  }).catch(() => {
    logger.error("FitStats local service could not start", {});
    process.exitCode = 1;
  });
}
