import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { openDatabase } from "./db.js";
import { loadConfig } from "./config.js";
import { createDashboardHandler } from "./dashboard-routes.js";

const db = openDatabase(loadConfig());
const port = Number(process.env.FITSTATS_DASHBOARD_PORT ?? 8788);
const dashboard = createDashboardHandler(db, { manualSync: process.platform === "darwin" });
createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/api/strava/sync" || process.platform !== "darwin") {
    dashboard(request, response);
    return;
  }
  if (request.headers.origin !== `http://127.0.0.1:${port}` || request.headers["x-fitstats-sync"] !== "1") {
    response.writeHead(403).end();
    return;
  }
  // Use the scheduled job so a manual request cannot start a second sync.
  execFile("/bin/launchctl", ["kickstart", `gui/${process.getuid?.()}/com.fitstats.strava-sync`], error => {
    response.writeHead(error ? 503 : 202).end();
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`FitStats dashboard: http://127.0.0.1:${port}`);
});
