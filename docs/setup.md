# FitStats setup guide

Build a synthetic demo, create a static snapshot from a Strava export, or run the local dashboard with your own data.

[Back to the project overview](../README.md)

## Try the dashboard demo

Build a static demo and serve it locally. You need Node.js 20+ and Python 3 to run the commands below. The demo build uses only Node.js built-ins.

```sh
npm run demo:build
python3 -m http.server 8789 --bind 127.0.0.1 --directory dist/demo
```

Open [the demo on localhost](http://127.0.0.1:8789). It includes 78 synthetic runs, rides, and walks with generated workout details. To explore a sample finding, select **Run** under **Activity types** and **Distance (km)** under **Training trends**. Running volume rose from 33.4 km in January to 61.3 km in June 2025 in the sample.

The build writes a standalone static site to `dist/demo/`. Publish that folder to a static host to get a shareable demo URL for a CV. Relative asset links support hosting under a repository subpath.

## Frozen workout archive

The portfolio archive is built from a one-time Strava account export. It includes workout summaries and the GPS and sensor recordings available in that export. The static dashboard reads JSON files from the site. It has no Strava connection or scheduled refresh.

To build a snapshot from your own export, first install dependencies with `npm ci`:

```sh
npm run snapshot:build -- /path/to/strava-export.zip
python3 -m http.server 8789 --bind 127.0.0.1 --directory dist/snapshot
```

The build imports the archive into a temporary database and generates `dist/snapshot/`. Publishing that folder shares its workout dates, names, routes, and sensor data with everyone who can access the site. Keep the original ZIP and the live SQLite database outside the published folder.

## Privacy

The synthetic demo uses generated workouts. It runs in the browser without your Strava profile URL, access tokens, API credentials, or OAuth callback. For the optional personal dashboard, each person imports their own export or connects their own Strava account locally. Keep exports in `outputs/` and the database in `data/`. Both paths and the local `.env` are excluded from Git. The repository includes a blank credential template in `.env.example`.

## Run the dashboard with your own data

After installing dependencies and importing data, run `npm run dashboard` and open [http://127.0.0.1:8788](http://127.0.0.1:8788). Filter by activity type and time period, switch the monthly chart between count, moving time and distance, or search the workout log. Recent periods end at the latest month in the database. The dashboard reads SQLite directly through its own loopback server.

## Import a Strava export without API access

Request a bulk archive from [Strava](https://www.strava.com/athlete/delete_your_account) using **Request Download**. After downloading and unzipping the archive, run this from the project folder:

```bash
npm install
npm run strava:import-export -- "/path/to/activities.csv"
```

The command creates or migrates the local database and imports activity summaries from the CSV. It reports the number of rows, inserts, and skips. Existing Strava activity IDs are skipped, so later exports can add new activities without duplicating existing ones. Dates without a timezone are interpreted as UTC. The archive's FIT, GPX, and TCX files are outside the scope of this summary import. This workflow needs neither API credentials nor a running server.

## Prerequisites

- Node.js 20 or newer (Node 24 is currently used for development)
- npm
- A Strava account with the Strava subscription/API access required by Strava, and a Strava API application
- `sqlite3` command-line tool only if you want the optional database inspection commands below
- For webhooks during local development: Cloudflare Tunnel (`cloudflared`) or an equivalent public HTTPS tunnel

Install project packages after cloning/opening this folder:

```bash
npm install
```

## One-time setup for API sync

1. Create a Strava API application at [Strava API Settings](https://www.strava.com/settings/api). This is a one-athlete private project, so Strava's Single Player Mode is appropriate.

2. In the Strava app settings, set **Authorization Callback Domain** to `127.0.0.1`. This must match the host in the local redirect URI below. Do not add a protocol, port, or path to that Strava field. The default local redirect URI is already allowed by Strava's localhost/loopback rules, but set it explicitly so the app configuration stays clear.

3. Create your local configuration file and fill it privately:

```bash
cp .env.example .env
```

Set the following values in `.env`—never in source files, issue comments, or messages:

| Variable | What to enter |
| --- | --- |
| `STRAVA_CLIENT_ID` | Client ID from Strava API Settings |
| `STRAVA_CLIENT_SECRET` | Client Secret from Strava API Settings |
| `STRAVA_API_BASE_URL` | Leave at `https://www.strava.com/api/v3`. Strava has announced an API hostname change for January 2027; change only this value when their migration guidance says to do so. |
| `STRAVA_REDIRECT_URI` | Keep `http://127.0.0.1:8787/oauth/strava/callback` unless you intentionally change the local port/host |
| `TOKEN_ENCRYPTION_KEY` | A unique securely generated 32-byte key encoded as **64 hexadecimal characters**. Save a backup in a password manager; changing it makes existing local token ciphertext unreadable. |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | A second unique random value you choose. It is not an OAuth token. |
| `STRAVA_WEBHOOK_CALLBACK_URL` | Leave blank until the tunnel step; then set its public HTTPS URL plus `/webhooks/strava` |

`FITSTATS_PORT`, `FITSTATS_HOST`, `FITSTATS_DB_PATH`, and `STRAVA_SYNC_LOOKBACK_DAYS` have safe local defaults. `.env`, database files, WAL files, and lock files are excluded by `.gitignore`.

4. Create the schema and start the local service:

```bash
npm run db:migrate
npm start
```

Open [http://127.0.0.1:8787/connect/strava](http://127.0.0.1:8787/connect/strava) in the same browser where you are logged in to Strava. Approve the requested `activity:read_all` scope. It is the only scope requested and is needed to import activity data that is visible only to you. The callback saves the athlete profile and encrypted token metadata locally.

5. Confirm that the connection succeeded, then import history:

```bash
npm run strava:status
npm run strava:import
```

The importer requests 200 activities per page and records its next page after every completed page. Re-running it is safe: existing activity IDs are upserted rather than duplicated. It reports `fetched`, `inserted`, `updated`, `skipped`, `failed`, and oldest/newest activity dates. The initial history import deliberately uses the list response only; it does **not** make one detailed-stream request for every historical activity.

## Webhooks: automatic activity updates

Your laptop cannot receive a public Strava webhook directly. During development, run the local service and a secure HTTPS tunnel in separate terminals. Cloudflare's quick tunnel does not require a paid account for development:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

Cloudflare prints a temporary `https://…trycloudflare.com` forwarding URL. Put this exact value plus `/webhooks/strava` into `STRAVA_WEBHOOK_CALLBACK_URL` in `.env`, for example:

```dotenv
STRAVA_WEBHOOK_CALLBACK_URL=https://your-temporary-tunnel.trycloudflare.com/webhooks/strava
```

Restart `npm start` after changing `.env`, keep both processes running, then subscribe from a third terminal:

```bash
npm run strava:webhook:subscribe
```

That command sends the client secret directly to Strava from process memory; it does not put the secret into a pasted `curl` command or terminal output. Strava immediately performs a GET validation request. FitStats compares `hub.verify_token` against `STRAVA_WEBHOOK_VERIFY_TOKEN` and replies within the required two seconds with the `hub.challenge` JSON.

Each Strava application supports one webhook subscription. FitStats saves the resulting subscription ID locally and requires incoming POST events to match it before they can affect activity data. Check its current destination without exposing credentials (this also records an existing subscription created outside FitStats):

```bash
npm run strava:webhook:status
```

A quick-tunnel URL changes whenever its process restarts. After setting the new value in `.env`, restarting FitStats, and confirming the tunnel is live, replace the app's one existing subscription:

```bash
npm run strava:webhook:replace
```

Strava permits only one subscription, so this command deletes the old destination immediately before creating the new one. There is a brief gap; run a manual recovery sync afterward if you are concerned an activity changed during it. For a stable deployment later, point `STRAVA_WEBHOOK_CALLBACK_URL` at the production HTTPS service and use the same endpoint path.

For activity `create` and `update` events, FitStats records the event first, returns an immediate success to Strava, then fetches the current activity and upserts it. For `delete`, it soft-deletes the row (`is_deleted = 1` with `deleted_at`) so a future dashboard can exclude it while retaining an audit trail. Duplicate webhook deliveries are deduplicated. Failed processing is retained and retried by the running service; you can also invoke:

```bash
npm run strava:webhook:retry
```

Important: Strava uses the verification token in the GET challenge, but does not include that value (or a request signature) in its POST event payloads. POSTs are therefore shape-validated, stored before handling, and processed only when `owner_id` matches the connected local athlete. This is the strongest validation supported by Strava's webhook format.

## Recovery sync and optional streams

Use this if a webhook was missed while your laptop/tunnel was offline:

```bash
npm run strava:sync
```

It re-reads a rolling 30-day activity-start-date window by default and safely upserts the results. To temporarily use another overlap:

```bash
npm run strava:sync -- --days=90
```

Strava's activity-list API filters by activity **start time**, not update time. Therefore, a manual sync catches new/recently started activities but cannot guarantee discovery of an edit to a much older activity if its webhook was missed. Re-run `npm run strava:import` for a full reconciliation when needed. The corresponding `sync_state` rows record page cursors, checkpoints, last success, and non-sensitive failure state.

Detailed time-series streams are intentionally separate because they cost an additional Strava request per activity. Backfill a small number first:

```bash
npm run strava:streams:backfill -- --limit=10
```

It stores available `time`, `distance`, `latlng`, `altitude`, `velocity_smooth`, `heartrate`, `cadence`, and `watts` streams in the `activity_streams` table. Increase the limit carefully; the client applies bounded retry/backoff and waits at Strava rate-limit boundaries rather than polling aggressively.

## Local service endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Minimal local setup page; this is not the future dashboard |
| `GET /health` | Service/configuration readiness without exposing secrets |
| `GET /strava/status` | Connection status and token expiration metadata |
| `GET /connect/strava` | Starts local Strava OAuth consent |
| `GET /oauth/strava/callback` | Handles the OAuth callback |
| `GET /webhooks/strava` | Strava webhook validation challenge |
| `POST /webhooks/strava` | Receives activity/athlete webhook events |

If you run `npm start` before configuring credentials, it intentionally stays up and logs that configuration is incomplete. `/health` remains available; protected OAuth/webhook routes return a clear configuration error instead of crashing.

## Data dictionary and units

All measurements preserve Strava's API base units. A future dashboard should convert units at display time rather than mutate stored values.

| Table | Purpose |
| --- | --- |
| `athletes` | One Strava athlete identity/profile record for this private installation. |
| `strava_tokens` | AES-256-GCM ciphertext plus expiry/scope metadata. Plain access and refresh tokens are never stored here. |
| `activities` | One row per Strava activity ID. Primary metrics are metres (`distance_m`, `total_elevation_gain_m`), seconds (`moving_time_s`, `elapsed_time_s`, `pace_seconds_per_km`), metres/second (`*_speed_mps`), beats/minute, RPM, watts, and kcal (`calories_kcal`). It includes the original Strava JSON for forward compatibility. |
| `activity_streams` | Optional ordered time-series arrays, one row per activity/stream type. `data_json` keeps Strava's native series values. |
| `sync_state` | Resumable import page cursor, incremental checkpoint, last successful attempt, and non-sensitive failure counts. |
| `webhook_events` | Incoming webhook metadata, canonical-payload dedupe key, processing status, attempts, and retry timing. |
| `webhook_subscriptions` | The active Strava push-subscription ID and callback URL; used to ignore POSTs from an unknown subscription. |
| `schema_migrations` | Checksummed record of schema migrations already applied. |

`activities.is_deleted = 0` is the normal dashboard filter. `pace_seconds_per_km` is calculated only for running/walking/hiking-like sport types where pace is meaningful; it is otherwise `NULL`. Fields absent from Strava responses remain `NULL`, while `raw_json` keeps the complete response supplied by the relevant endpoint.

## Inspecting the database

After the first migration/import:

```bash
sqlite3 data/fitstats.db ".tables"
sqlite3 data/fitstats.db "SELECT sport_type, COUNT(*) FROM activities WHERE is_deleted = 0 GROUP BY sport_type ORDER BY COUNT(*) DESC;"
sqlite3 data/fitstats.db "SELECT scope, last_successful_sync_at, consecutive_failures FROM sync_state;"
```

Do not share `data/fitstats.db`; activity metadata and raw Strava responses are private even though token plaintext is encrypted.

## Known limitations

- “Near real time” means an activity is synced after Strava has processed it and delivered its webhook. It is not live GPS tracking during an activity.
- The normal source of updates is webhooks, not polling. Manual sync is a recovery mechanism with an intentional overlapping window.
- A running local computer plus active tunnel is required for immediate development webhook delivery. History remains recoverable with the manual commands.
- Strava can deliver several events for one save and can deliver activity fields asynchronously; idempotent upserts and webhook deduplication handle that safely.
- If you lose `TOKEN_ENCRYPTION_KEY`, you must reconnect Strava after choosing a new key. Keep a secure backup outside this repository.

### Activity details

Click any workout name in the dashboard. Choose **All time** to access the
full history. FitStats shows the recorded GPS route, time and sensor charts,
Strava splits and zone distributions when supplied, device laps, and the
original export fields. When official splits are unavailable, the dashboard
can estimate distance splits from the recording; these use elapsed time,
including stops.

```sh
npm run strava:import
npm run strava:import-archive -- /path/to/strava-export.zip
npm run strava:enrich
npm run dashboard
```

The archive command supplements existing activities using CSV, FIT, GPX, TCX
and Strava recording JSON. The enrichment command stores API results as they
arrive and skips completed requests on restart. Strava rate limits can stretch
the job across multiple quota windows. Data that was never recorded or that
Strava does not expose (including some step and zone values) is left blank.
GPS routes are drawn locally without sending coordinates to a tile provider.
