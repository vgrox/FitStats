import { URL } from "node:url";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

export async function buildStaticDashboard(mode, output) {
  const dashboard = new URL("../dashboard/", import.meta.url);
  const assets = ["activity-filters.js", "activity.js", "dashboard.js", "fitstats-icon.png", "style.css"];
  if (mode === "demo") assets.push("demo-data.js");

  await mkdir(output, { recursive: true });
  await Promise.all(assets.map(file => copyFile(new URL(file, dashboard), new URL(file, output))));
  const html = await readFile(new URL("index.html", dashboard), "utf8");
  const title = mode === "demo" ? "Synthetic workout demo" : "Workout archive";
  await writeFile(new URL("index.html", output), html
    .replace('<html lang="en">', '<html lang="en" data-' + mode + '>')
    .replace('<title>FitStats · Training dashboard</title>', '<title>FitStats · ' + title + '</title>')
    .replace(/(href|src)="\//g, '$1="./'));
}
