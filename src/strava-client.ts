import type { OAuthSettings } from "./config.js";
import { logger } from "./logger.js";
import type { TokenRepository } from "./repositories.js";
import type { TokenInput, UnknownRecord } from "./types.js";

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

export class StravaHttpError extends Error {
  constructor(public readonly status: number, message = `Strava API request failed with HTTP ${status}.`) {
    super(message);
    this.name = "StravaHttpError";
  }
}

function asRecord(value: unknown): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Strava returned an unexpected response.");
  }
  return value as UnknownRecord;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Strava response did not include ${name}.`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Strava response did not include ${name}.`);
  return value;
}

function parseTokenResponse(value: unknown, fallbackScope = ""): TokenInput {
  const response = asRecord(value);
  return {
    accessToken: requireString(response.access_token, "access token"),
    refreshToken: requireString(response.refresh_token, "refresh token"),
    expiresAt: requireNumber(response.expires_at, "token expiration"),
    scope: typeof response.scope === "string" ? response.scope : fallbackScope,
    tokenType: typeof response.token_type === "string" ? response.token_type : null
  };
}

function parseHeaderCount(value: string | null): [number, number] | null {
  if (!value) return null;
  const [shortTerm, daily] = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
  return Number.isFinite(shortTerm) && Number.isFinite(daily) ? [shortTerm, daily] : null;
}

function rateLimitDelay(headers: Headers): number | null {
  const retryAfter = Number.parseInt(headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const limit = parseHeaderCount(headers.get("x-readratelimit-limit") ?? headers.get("x-ratelimit-limit"));
  const usage = parseHeaderCount(headers.get("x-readratelimit-usage") ?? headers.get("x-ratelimit-usage"));
  if (!limit || !usage) return null;

  const current = new Date();
  if (usage[1] >= limit[1]) {
    const nextDay = new Date(current);
    nextDay.setUTCHours(24, 0, 1, 0);
    return Math.max(1000, nextDay.getTime() - current.getTime());
  }
  if (usage[0] < limit[0]) return null;

  const next = new Date(current);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(Math.floor(current.getUTCMinutes() / 15) * 15 + 15);
  return Math.max(1000, next.getTime() - current.getTime() + 1000);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new StravaHttpError(response.status, "Strava returned a non-JSON response.");
  }
}

export interface AuthorizationExchange {
  token: TokenInput;
  athlete: unknown;
}

export class StravaClient {
  constructor(
    private readonly settings: OAuthSettings,
    private readonly tokens: TokenRepository
  ) {}

  async exchangeAuthorizationCode(code: string, grantedScope: string): Promise<AuthorizationExchange> {
    const response = await fetch(STRAVA_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        code,
        grant_type: "authorization_code"
      })
    });
    if (!response.ok) throw new StravaHttpError(response.status, "Strava rejected the OAuth authorization exchange.");
    const payload = asRecord(await responseJson(response));
    return { token: parseTokenResponse(payload, grantedScope), athlete: payload.athlete };
  }

  async listActivities(athleteId: number, page: number, after?: number): Promise<unknown[]> {
    const query = new URLSearchParams({ per_page: "200", page: String(page) });
    if (after) query.set("after", String(after));
    const payload = await this.authorizedRequest(athleteId, `/athlete/activities?${query.toString()}`);
    if (!Array.isArray(payload)) throw new Error("Strava activity list response was not an array.");
    return payload;
  }

  async getActivity(athleteId: number, activityId: number): Promise<unknown> {
    return this.authorizedRequest(athleteId, `/activities/${activityId}`);
  }

  async getActivityZones(athleteId: number, activityId: number): Promise<unknown> {
    return this.authorizedRequest(athleteId, `/activities/${activityId}/zones`);
  }

  async getActivityStreams(athleteId: number, activityId: number): Promise<unknown> {
    const query = new URLSearchParams({
      keys: "time,distance,latlng,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth",
      key_by_type: "true"
    });
    return this.authorizedRequest(athleteId, `/activities/${activityId}/streams?${query.toString()}`);
  }

  private async accessToken(athleteId: number, forceRefresh = false): Promise<string> {
    const current = this.tokens.get(athleteId);
    if (!current) throw new Error("No active Strava token exists for this athlete.");
    const expiresSoon = current.expiresAt <= Math.floor(Date.now() / 1000) + 3600;
    if (!forceRefresh && !expiresSoon) return current.accessToken;

    const response = await fetch(STRAVA_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken
      })
    });
    if (!response.ok) throw new StravaHttpError(response.status, "Strava token refresh failed.");
    const refreshed = parseTokenResponse(await responseJson(response), current.scope);
    this.tokens.save(athleteId, refreshed);
    return refreshed.accessToken;
  }

  private async authorizedRequest(athleteId: number, endpoint: string): Promise<unknown> {
    let refreshAfterUnauthorized = true;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = await this.accessToken(athleteId, !refreshAfterUnauthorized);
      const response = await fetch(`${this.settings.apiBaseUrl}${endpoint}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" }
      });

      if (response.status === 401 && refreshAfterUnauthorized) {
        refreshAfterUnauthorized = false;
        continue;
      }
      if (response.status === 429 && attempt < 3) {
        const delay = rateLimitDelay(response.headers) ?? 15 * 60 * 1000;
        logger.warn("Strava read rate limit reached; waiting before retry", { waitSeconds: Math.ceil(delay / 1000) });
        await sleep(delay);
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await sleep(500 * (2 ** attempt));
        continue;
      }
      if (!response.ok) throw new StravaHttpError(response.status);

      const body = await responseJson(response);
      const wait = rateLimitDelay(response.headers);
      if (wait) {
        logger.warn("Strava read rate limit reached; waiting before the next request", { waitSeconds: Math.ceil(wait / 1000) });
        await sleep(wait);
      }
      return body;
    }
    throw new Error("Strava request retry limit reached.");
  }
}

export async function createWebhookSubscription(settings: {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  callbackUrl: string;
  verifyToken: string;
}): Promise<number> {
  const form = new FormData();
  form.set("client_id", settings.clientId);
  form.set("client_secret", settings.clientSecret);
  form.set("callback_url", settings.callbackUrl);
  form.set("verify_token", settings.verifyToken);
  const response = await fetch(`${settings.apiBaseUrl}/push_subscriptions`, { method: "POST", body: form });
  if (!response.ok) throw new StravaHttpError(response.status, "Strava webhook subscription creation failed.");
  const payload = asRecord(await responseJson(response));
  return requireNumber(payload.id, "webhook subscription ID");
}

type WebhookSubscriptionSettings = {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  callbackUrl: string;
  verifyToken: string;
};

export async function getWebhookSubscription(settings: WebhookSubscriptionSettings): Promise<{ id: number; callbackUrl: string | null } | null> {
  const query = new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret });
  const response = await fetch(`${settings.apiBaseUrl}/push_subscriptions?${query.toString()}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new StravaHttpError(response.status, "Strava webhook subscription lookup failed.");
  const payload = asRecord(await responseJson(response));
  return {
    id: requireNumber(payload.id, "webhook subscription ID"),
    callbackUrl: typeof payload.callback_url === "string" ? payload.callback_url : null
  };
}

export async function deleteWebhookSubscription(settings: WebhookSubscriptionSettings, subscriptionId: number): Promise<void> {
  const query = new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret });
  const response = await fetch(`${settings.apiBaseUrl}/push_subscriptions/${subscriptionId}?${query.toString()}`, { method: "DELETE" });
  if (response.status !== 204) throw new StravaHttpError(response.status, "Strava webhook subscription deletion failed.");
}
