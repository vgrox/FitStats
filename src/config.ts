import "dotenv/config";
import path from "node:path";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface AppConfig {
  databasePath: string;
  host: string;
  port: number;
  syncLookbackDays: number;
  strava: {
    clientId?: string;
    clientSecret?: string;
    apiBaseUrl: string;
    redirectUri: string;
    tokenEncryptionKey?: string;
    webhookVerifyToken?: string;
    webhookCallbackUrl?: string;
  };
}

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  redirectUri: string;
  tokenEncryptionKey: string;
}

export interface WebhookSubscriptionSettings {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  verifyToken: string;
  callbackUrl: string;
}

function requiredPositiveInt(value: string | undefined, fallback: number, variable: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${variable} must be a positive integer.`);
  }
  return parsed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function apiBaseUrl(value: string | undefined): string {
  const candidate = optional(value) ?? "https://www.strava.com/api/v3";
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ConfigurationError("STRAVA_API_BASE_URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigurationError("STRAVA_API_BASE_URL must be a valid HTTPS URL.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = requiredPositiveInt(env.FITSTATS_PORT, 8787, "FITSTATS_PORT");
  const databasePath = path.resolve(process.cwd(), env.FITSTATS_DB_PATH ?? "data/fitstats.db");
  const syncLookbackDays = requiredPositiveInt(
    env.STRAVA_SYNC_LOOKBACK_DAYS,
    30,
    "STRAVA_SYNC_LOOKBACK_DAYS"
  );

  return {
    databasePath,
    host: env.FITSTATS_HOST ?? "127.0.0.1",
    port,
    syncLookbackDays,
    strava: {
      clientId: optional(env.STRAVA_CLIENT_ID),
      clientSecret: optional(env.STRAVA_CLIENT_SECRET),
      apiBaseUrl: apiBaseUrl(env.STRAVA_API_BASE_URL),
      redirectUri: optional(env.STRAVA_REDIRECT_URI) ?? `http://127.0.0.1:${port}/oauth/strava/callback`,
      tokenEncryptionKey: optional(env.TOKEN_ENCRYPTION_KEY),
      webhookVerifyToken: optional(env.STRAVA_WEBHOOK_VERIFY_TOKEN),
      webhookCallbackUrl: optional(env.STRAVA_WEBHOOK_CALLBACK_URL)
    }
  };
}

function requireValues(values: Record<string, string | undefined>): Record<string, string> {
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigurationError(`Missing required configuration: ${missing.join(", ")}. Copy .env.example to .env and fill only those values.`);
  }
  return values as Record<string, string>;
}

export function getOAuthSettings(config: AppConfig): OAuthSettings {
  const values = requireValues({
    STRAVA_CLIENT_ID: config.strava.clientId,
    STRAVA_CLIENT_SECRET: config.strava.clientSecret,
    TOKEN_ENCRYPTION_KEY: config.strava.tokenEncryptionKey
  });
  if (!/^[a-fA-F0-9]{64}$/.test(values.TOKEN_ENCRYPTION_KEY)) {
    throw new ConfigurationError("TOKEN_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters (32 bytes).");
  }
  return {
    clientId: values.STRAVA_CLIENT_ID,
    clientSecret: values.STRAVA_CLIENT_SECRET,
    apiBaseUrl: config.strava.apiBaseUrl,
    redirectUri: config.strava.redirectUri,
    tokenEncryptionKey: values.TOKEN_ENCRYPTION_KEY
  };
}

export function getWebhookVerifyToken(config: AppConfig): string {
  const values = requireValues({ STRAVA_WEBHOOK_VERIFY_TOKEN: config.strava.webhookVerifyToken });
  return values.STRAVA_WEBHOOK_VERIFY_TOKEN;
}

export function getWebhookSubscriptionSettings(config: AppConfig): WebhookSubscriptionSettings {
  const values = requireValues({
    STRAVA_CLIENT_ID: config.strava.clientId,
    STRAVA_CLIENT_SECRET: config.strava.clientSecret,
    STRAVA_WEBHOOK_VERIFY_TOKEN: config.strava.webhookVerifyToken,
    STRAVA_WEBHOOK_CALLBACK_URL: config.strava.webhookCallbackUrl
  });
  let callback: URL;
  try {
    callback = new URL(values.STRAVA_WEBHOOK_CALLBACK_URL);
  } catch {
    throw new ConfigurationError("STRAVA_WEBHOOK_CALLBACK_URL must be a valid public HTTPS URL.");
  }
  if (callback.protocol !== "https:" || !callback.pathname.endsWith("/webhooks/strava")) {
    throw new ConfigurationError("STRAVA_WEBHOOK_CALLBACK_URL must be an HTTPS URL ending in /webhooks/strava.");
  }
  return {
    clientId: values.STRAVA_CLIENT_ID,
    clientSecret: values.STRAVA_CLIENT_SECRET,
    apiBaseUrl: config.strava.apiBaseUrl,
    verifyToken: values.STRAVA_WEBHOOK_VERIFY_TOKEN,
    callbackUrl: callback.toString()
  };
}

export function configurationStatus(config: AppConfig): { oauthReady: boolean; webhookVerificationReady: boolean } {
  try {
    getOAuthSettings(config);
    return { oauthReady: true, webhookVerificationReady: Boolean(config.strava.webhookVerifyToken) };
  } catch {
    return { oauthReady: false, webhookVerificationReady: Boolean(config.strava.webhookVerifyToken) };
  }
}
