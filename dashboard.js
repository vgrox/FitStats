/* global document, fetch, ResizeObserver, window */
import { openActivity } from "./activity.js";
import { metrics, prepareActivity, filterActivities, sortActivities, milestones, rankMilestone, comparePeriods } from "./activity-filters.js";
const get = id => document.getElementById(id);
const isDemo = document.documentElement.hasAttribute("data-demo");
const isSnapshot = document.documentElement.hasAttribute("data-snapshot");
const isStatic = isDemo || isSnapshot;
const datasetLabel = isDemo ? "Synthetic workout data" : "Frozen Strava export";
const demo = isDemo ? import("./demo-data.js") : null;
async function readSnapshot(path, signal) {
  const response = await fetch(new window.URL(path, import.meta.url), { signal });
  if (!response.ok) throw new Error("Snapshot data could not be loaded.");
  return response.json();
}
const loadStaticActivity = isSnapshot
  ? (id, signal) => readSnapshot("./workouts/" + id + ".json", signal)
  : demo ? async id => (await demo).demoDetail(id) : undefined;
const staticRanking = isStatic ? new window.URLSearchParams(window.location.search).get("ranking") : null;
const milestone = milestones.find(({ slug }) => isStatic
  ? staticRanking === slug
  : window.location.pathname.replace(/\/$/, "") === "/milestones/" + slug);
let datasetEndDay;
if (isStatic) {
  get("sync-status").hidden = true;
  get("ranking-description").textContent = datasetLabel;
  get("ranking-description").hidden = false;
  get("page-title").textContent = isDemo ? "Sample workouts" : "Workout archive";
}
let ranks = new Map();
if (milestone) {
  document.title = "FitStats · " + milestone.title;
  for (const id of ["stats", "training-panels", "milestones"]) get(id).hidden = true;
  for (const id of ["dashboard-back", "ranking-description", "rank-column"]) get(id).hidden = false;
  get("page-title").textContent = milestone.title;
  get("ranking-description").textContent = isStatic ? milestone.description + " · " + datasetLabel : milestone.description;
  get("log-title").textContent = "Activity rankings";
}
const type = get("type");
const period = get("period");
const comparisonLength = get("comparison-length");
const metric = get("metric");
const search = get("search");
const canvas = get("trend");
const labels = { count: "Workouts", hours: "Moving hours", km: "Distance (km)" };
const format = (value, digits = 0) => value.toLocaleString("en-IN", { maximumFractionDigits: digits });
const monthLabel = (key, options) => new Date(key + "-01T00:00:00Z").toLocaleDateString("en", { timeZone: "UTC", ...options });
const pageSize = 15;
let activities = [];
let filtered = [];
let buckets = [];
let page = 0;
let selectedComparison = null;
let comparisonPeriods;

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

const sort = get("sort");
const direction = get("direction");
const form = get("filters");
const weekday = get("weekday");
const categoryDefinitions = [
  ["gear", "Gear ID"], ["visibility", "Visibility"], ["workoutType", "Workout classification (source code)"],
  ["trainer", "Indoor trainer"], ["commute", "Commute"], ["manual", "Manual entry"]
];
function addOption(select, value, label) {
  const option = element("option", label);
  option.value = value;
  select.append(option);
}
addOption(weekday, "", "Any day");
["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  .forEach((day, index) => addOption(weekday, index, day));
const sortMetrics = milestone?.key === "duration" ? [...metrics, ["duration", "Milestone duration", "min"]] : metrics;
const metricLabels = new Map(sortMetrics.map(([key, label, unit]) => [key, [label, unit]]));
for (const [key, label] of [["date", "Date"], ["name", "Workout name"], ["type", "Activity type"], ...sortMetrics]) {
  addOption(sort, key, label);
}
if (milestone) {
  for (const [select, value] of [[sort, milestone.key], [direction, milestone.direction]]) {
    [...select.options].find(option => option.value === value).defaultSelected = true;
    select.value = value;
  }
}
const categoryInputs = categoryDefinitions.map(([key, name]) => {
  const label = element("label", name);
  const select = element("select", "");
  addOption(select, "", "Any");
  if (["trainer", "commute", "manual"].includes(key)) {
    addOption(select, "1", "Yes");
    addOption(select, "0", "No");
  }
  label.append(select);
  get("categories").append(label);
  return [key, select];
});
const rangeInputs = metrics.map(([key, name, unit]) => {
  const group = element("fieldset", "");
  group.className = "ranges-pair";
  group.append(element("legend", name + " (" + unit + ")"));
  const inputs = ["Min", "Max"].map(bound => {
    const label = element("label", bound);
    const input = element("input", "");
    input.type = "number";
    input.min = "0";
    input.step = "any";
    input.setAttribute("aria-label", name + " " + bound + " (" + unit + ")");
    label.append(input);
    group.append(label);
    return input;
  });
  get("ranges").append(group);
  return [key, ...inputs];
});

function displayMetric(activity, key) {
  const value = activity[key];
  if (value == null) return "—";
  if (key === "duration") {
    const seconds = activity.seconds > 0 ? activity.seconds : activity.elapsed;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor(seconds % 3600 / 60);
    const secs = Math.floor(seconds % 60);
    return [hours ? hours + " h" : "", mins ? mins + " min" : "", secs ? secs + " s" : ""].filter(Boolean).join(" ");
  }
  if (key === "pace") {
    const seconds = Math.round(value * 60);
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + " /km";
  }
  return format(value, 2) + " " + metricLabels.get(key)[1];
}

function renderMilestones(allActivities) {
  get("milestone-cards").replaceChildren(...milestones.map(definition => {
    const [best] = rankMilestone(allActivities, definition);
    const link = element("a", "");
    link.className = "panel milestone-card";
    link.href = isStatic ? "?ranking=" + definition.slug : "/milestones/" + definition.slug;
    link.append(element("span", definition.title));
    link.firstChild.className = "milestone-kind";
    if (best) {
      const basis = definition.key === "duration" ? (best.seconds > 0 ? " moving" : " elapsed") : "";
      const meta = element("p", [best.type, best.day].filter(Boolean).join(" · "));
      meta.className = "subtle";
      link.append(element("strong", displayMetric(best, definition.key) + basis), element("span", best.name), meta);
    } else {
      link.append(element("span", "No qualifying workouts yet"));
    }
    const action = element("span", "View rankings →");
    action.className = "milestone-action";
    link.append(action);
    return link;
  }));
}

function renderChart() {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.font = "11px system-ui";
  const left = 49;
  const bottom = height - 32;
  const plotHeight = bottom - 12;
  const plotWidth = width - left - 8;
  const values = buckets.map(bucket => bucket[metric.value]);
  const step = Math.max(1, Math.ceil(Math.max(0, ...values) / 4));
  for (let i = 0; i <= 4; i++) {
    const y = bottom - plotHeight * i / 4;
    ctx.fillStyle = "#a1afab";
    ctx.textAlign = "right";
    ctx.fillText(format(step * i), left - 8, y + 4);
    ctx.strokeStyle = "#293634";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - 8, y);
    ctx.stroke();
  }
  if (!buckets.length) return;
  const spacing = plotWidth / buckets.length;
  const barWidth = Math.min(48, spacing * 0.68);
  const labelInterval = Math.max(1, Math.ceil(62 / spacing));
  buckets.forEach((bucket, i) => {
    const x = left + spacing * (i + .5);
    const barHeight = values[i] / (step * 4) * plotHeight;
    if (barHeight > 0) {
      const fill = ctx.createLinearGradient(0, bottom, 0, bottom - plotHeight);
      fill.addColorStop(0, "#6ca54e");
      fill.addColorStop(1, "#d6ff9e");
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(x - barWidth / 2, bottom - barHeight, barWidth, barHeight, [4, 4, 0, 0]);
      ctx.fill();
    }
    if (i % labelInterval === 0) {
      ctx.fillStyle = "#a1afab";
      ctx.textAlign = "center";
      ctx.fillText(monthLabel(bucket.key, { month: "short", year: "2-digit" }), x, bottom + 22);
    }
  });
}

const mixColors = ["#bdf875", "#65dac1", "#91baff", "#b9a5ff", "#ffb88a", "#f58caa", "#a1afab"];

function renderBreakdowns(mix) {
  const types = [...mix].sort(([a], [b]) => a.localeCompare(b));
  const total = filtered.length;
  let offset = 0;
  const stops = [];
  const rows = types.map(([label, count], i) => {
    const end = offset + count / total * 100;
    const color = mixColors[i % mixColors.length];
    stops.push(color + " " + offset + "% " + (i === types.length - 1 ? 100 : end) + "%");
    offset = end;
    const row = element("li", "");
    const name = element("span", label);
    name.style.setProperty("--swatch", color);
    row.append(name, element("strong", format(count) + " · " + format(count / total * 100, 1) + "%"));
    return row;
  });
  get("mix-ring").style.background = stops.length ? "conic-gradient(" + stops.join(",") + ")" : "";
  get("mix-total").textContent = format(total);
  get("mix").replaceChildren(...(rows.length ? rows : [element("li", "No matching workouts")]));

  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(label => [label, 0]);
  const durations = ["Under 30 min", "30–59 min", "60–89 min", "90+ min"].map(label => [label, 0]);
  let dated = 0;
  let timed = 0;
  for (const { day, minutes } of filtered) {
    if (day) {
      const index = new Date(day + "T00:00:00Z").getUTCDay();
      if (Number.isFinite(index)) {
        weekdays[(index + 6) % 7][1]++;
        dated++;
      }
    }
    if (Number.isFinite(minutes) && minutes > 0) {
      durations[Math.min(3, Math.floor(minutes / 30))][1]++;
      timed++;
    }
  }
  get("weekday-note").textContent = dated ? format(dated) + " workouts with a local or recorded date" : "No dated workouts in this selection";
  get("duration-note").textContent = timed ? format(timed) + " workouts with recorded moving time" : "No moving times in this selection";
  drawBars("weekday-bars", weekdays);
  drawBars("duration-bars", durations);
}

function drawBars(id, values) {
  const max = Math.max(1, ...values.map(([, value]) => value));
  get(id).replaceChildren(...values.map(([label, value]) => {
    const row = element("li", "");
    const track = element("div", "");
    track.className = "bar-track";
    track.setAttribute("aria-hidden", "true");
    const bar = element("span", "");
    bar.style.setProperty("--fill", value / max * 100 + "%");
    track.append(bar);
    row.append(element("span", label), track, element("strong", format(value)));
    return row;
  }));
}

function updateMetric() {
  get("chart-label").textContent = buckets.length ? labels[metric.value] + " per month · activity dates" : "No dated workouts in this selection";
  get("trend-values").replaceChildren(...buckets.map(bucket => element("li",
    monthLabel(bucket.key, { month: "short", year: "numeric" }) + " · " + format(bucket[metric.value], 1))));
  renderChart();
}

function updateTable() {
  const selection = comparisonPeriods?.[selectedComparison];
  get("log-period").hidden = !selection;
  const rowsInPeriod = selection ? filtered.filter(({ day }) =>
    day && day >= selection.from && day <= selection.through) : filtered;
  if (selection) {
    get("log-period-label").textContent = selection.label + " · " + selection.dates;
  }
  const matches = sortActivities(rowsInPeriod, sort.value, direction.value);
  const baseMetrics = ["km", "minutes", "pace", "speed", "heartRate"];
  const extra = [...new Set([milestone?.key, sort.value])]
    .filter(key => metricLabels.has(key) && !baseMetrics.includes(key));
  const header = get("table-head");
  for (const column of header.querySelectorAll(".extra-metric")) column.remove();
  for (const key of extra) {
    const column = element("th", metricLabels.get(key)[0]);
    column.className = "extra-metric";
    header.append(column);
  }
  page = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const start = page * pageSize;
  const rows = matches.slice(start, start + pageSize).map(activity => {
    const row = element("tr", "");
    const values = [activity.day ?? "—", activity.name, activity.type,
      ...baseMetrics.map(key => displayMetric(activity, key)),
      ...extra.map(key => displayMetric(activity, key) +
        (key === "duration" ? (activity.seconds > 0 ? " moving" : " elapsed") : ""))];
    row.append(...values.map(value => element("td", value)));
    const button = element("button", activity.name);
    button.className = "activity-link";
    button.addEventListener("click", () => void openActivity(activity.id, loadStaticActivity));
    row.children[1].replaceChildren(button);
    if (milestone) row.prepend(element("td", ranks.get(activity.id)));
    return row;
  });
  get("rows").replaceChildren(...rows);
  get("results").textContent = matches.length ? (start + 1) + "–" + Math.min(start + pageSize, matches.length) + " of " + matches.length : "No matching workouts";
  get("prev").disabled = page === 0;
  get("next").disabled = start + pageSize >= matches.length;
}

function localToday() {
  if (datasetEndDay) return datasetEndDay;
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
}

function renderComparison(endDay, error) {
  const section = get("period-comparison");
  comparisonPeriods = undefined;
  section.hidden = lastPayload === undefined;
  if (section.hidden) return;

  const grid = get("comparison-cards");
  if (error) {
    get("comparison-dates").textContent = "Fix the filter error to see the comparison.";
    grid.replaceChildren();
    return;
  }

  const days = Number(comparisonLength.value);
  const { current, previous } = comparePeriods(filtered, endDay, days);
  const currentLabel = "Last " + days + " days";
  const previousLabel = "Previous " + days + " days";
  const dateLabel = new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  });
  const rangeLabel = ({ from, through }) => dateLabel.formatRange(
    new Date(from + "T00:00:00Z"), new Date(through + "T00:00:00Z")
  );
  comparisonPeriods = {
    current: { ...current, label: currentLabel, dates: rangeLabel(current) },
    previous: { ...previous, label: previousLabel, dates: rangeLabel(previous) }
  };
  get("comparison-dates").textContent =
    currentLabel + ": " + rangeLabel(current) + " · " + previousLabel + ": " + rangeLabel(previous) +
    " · Select a bar to view its workouts.";

  grid.replaceChildren(...[
    ["Workouts", "count", value => format(value)],
    ["Moving time", "seconds", value => {
      const minutes = Math.round(value / 60);
      if (value > 0 && minutes === 0) return "<1 min";
      return minutes >= 60 ? format(Math.floor(minutes / 60)) + " h " + minutes % 60 + " min" : minutes + " min";
    }],
    ["Distance", "km", value => value > 0 && value < 0.1 ? "<0.1 km" : format(value, 1) + " km"]
  ].map(([title, key, display]) => {
    const card = element("div", "");
    card.className = "comparison-card";
    const heading = element("div", "");
    heading.className = "comparison-card-heading";
    const difference = current[key] - previous[key];
    const change = element("span", "0% change");
    change.className = "comparison-change";
    if (previous[key] === 0 && current[key] > 0) {
      change.textContent = "Up from zero";
      change.title = "Percentage change is unavailable when the previous period is zero.";
      change.classList.add("increase");
    } else if (difference !== 0) {
      const percent = Math.abs(difference / previous[key]) * 100;
      const increase = difference > 0;
      change.textContent = (increase ? "+" : "−") + (percent < 0.1 ? "<0.1" : format(percent, 1)) + "%";
      change.classList.add(increase ? "increase" : "decrease");
    }
    heading.append(element("h3", title), change);
    card.append(heading);
    const max = Math.max(current[key], previous[key]);
    for (const [label, value, style] of [
      [currentLabel, current[key], "current"], [previousLabel, previous[key], "previous"]
    ]) {
      const row = element("button", "");
      row.type = "button";
      row.className = "comparison-row";
      row.setAttribute("aria-label", label + " · " + title + ": " + display(value) + ". View workouts.");
      row.setAttribute("aria-pressed", String(selectedComparison === style));
      row.dataset.comparisonPeriod = style;
      row.addEventListener("click", () => {
        selectComparison(style);
        get("log-title").focus();
      });
      const bar = element("progress", "");
      bar.className = style;
      bar.max = max || 1;
      bar.value = value;
      bar.setAttribute("aria-hidden", "true");
      row.append(element("span", label), element("strong", display(value)), bar);
      card.append(row);
    }
    return card;
  }));
}

function update() {
  const latest = activities.reduce((last, { day }) => day && day > last ? day : last, "");
  const months = Number(period.value);
  const quickStart = latest && months ? new Date(Date.UTC(Number(latest.slice(0, 4)),
    Number(latest.slice(5, 7)) - months, 1)).toISOString().slice(0, 10) : "";
  const from = get("from").value;
  const through = get("through").value;
  const start = from > quickStart ? from : quickStart;
  const ranges = rangeInputs.filter(([, min, max]) => min.value !== "" || max.value !== "" || min.validity.badInput || max.validity.badInput)
    .map(([key, min, max]) => [key, min.value === "" ? -Infinity : min.valueAsNumber,
      max.value === "" ? Infinity : max.valueAsNumber, min.validity.valid && max.validity.valid]);
  const invalidRange = ranges.find(([, min, max, valid]) => !valid || min > max);
  const error = (from && through && from > through) ? "From date must be on or before Through date."
    : invalidRange ? metricLabels.get(invalidRange[0])[0] + ": enter valid bounds with Min at or below Max." : "";
  get("filter-error").textContent = error;
  get("filter-error").hidden = !error;
  filtered = error ? [] : filterActivities(activities, {
    types: new Set([...type.selectedOptions].map(option => option.value)),
    term: search.value.trim().toLowerCase(), from: start, through, weekday: weekday.value, ranges,
    categories: categoryInputs.map(([key, select]) => [key, select.value])
  });
  if (milestone) { updateTable(); return; }
  renderComparison(localToday(), error);
  const typical = { count: 0, hours: 0, km: 0 };
  const totals = { ...typical, elevation: 0 };
  const mix = new Map();
  const monthsByKey = new Map();
  const [first, last] = filtered.reduce(([earliest, latest], { day }) => {
    const month = day?.slice(0, 7);
    return month ? [!earliest || month < earliest ? month : earliest, !latest || month > latest ? month : latest] : [earliest, latest];
  }, ["", ""]);
  if (first && last) {
    const cursor = new Date(first + "-01T00:00:00Z");
    for (let key = first; key <= last; key = cursor.toISOString().slice(0, 7)) {
      monthsByKey.set(key, { key, ...typical });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  for (const activity of filtered) {
    const km = activity.km ?? 0;
    const hours = (activity.seconds ?? 0) / 3600;
    totals.count++;
    totals.km += km;
    totals.hours += hours;
    totals.elevation += activity.elevation ?? 0;
    mix.set(activity.type, (mix.get(activity.type) ?? 0) + 1);
    const bucket = monthsByKey.get(activity.day?.slice(0, 7));
    if (bucket) {
      bucket.count++;
      bucket.km += km;
      bucket.hours += hours;
    }
  }
  buckets = [...monthsByKey.values()];
  get("stats").replaceChildren(...[
    ["Workouts", format(totals.count)], ["Moving time", format(totals.hours, 1) + " h"],
    ["Distance", format(totals.km, 1) + " km"], ["Elevation gain", format(totals.elevation) + " m"]
  ].map(([label, value]) => {
    const card = element("div", "");
    card.className = "stat";
    card.append(element("span", label), element("strong", value));
    return card;
  }));
  renderBreakdowns(mix);
  updateMetric();
  updateTable();
}

function selectComparison(selection) {
  selectedComparison = selection;
  page = 0;
  for (const bar of get("comparison-cards").querySelectorAll("[data-comparison-period]")) {
    bar.setAttribute("aria-pressed", String(bar.dataset.comparisonPeriod === selection));
  }
  updateTable();
}

get("clear-log-period").addEventListener("click", () => {
  selectComparison(null);
  get("log-title").focus();
});

function refreshSelection() { page = 0; update(); }
form.addEventListener("input", event => {
  if (event.target === sort || event.target === direction) {
    page = 0;
    updateTable();
  } else refreshSelection();
});
form.addEventListener("submit", event => event.preventDefault());
form.addEventListener("reset", () => window.setTimeout(() => {
  selectedComparison = null;
  refreshSelection();
}, 0));
metric.addEventListener("change", updateMetric);
comparisonLength.addEventListener("change", refreshSelection);
get("prev").addEventListener("click", () => { page--; updateTable(); });
get("next").addEventListener("click", () => { page++; updateTable(); });
if (!milestone) new ResizeObserver(renderChart).observe(canvas);

const lastStravaSync = get("last-strava-sync");
const syncTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const syncButton = get("sync-now");
const syncFeedback = get("sync-feedback");
let lastSyncFailure;
let lastSyncSuccess;
let manualSync;

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  syncFeedback.textContent = "Syncing…";
  const previousSync = { failure: lastSyncFailure, success: lastSyncSuccess };
  try {
    const response = await fetch("/api/strava/sync", {
      method: "POST",
      headers: { "X-FitStats-Sync": "1" }
    });
    if (!response.ok) throw new Error("Could not start sync");
    manualSync = { ...previousSync, deadline: Date.now() + 20 * 60_000 };
    window.clearTimeout(refreshTimer);
    if (!refreshing) void refreshActivities();
  } catch {
    syncFeedback.textContent = "Could not start the Strava sync.";
    syncButton.disabled = false;
  }
});

let lastPayload;
let lastComparisonDay;
let refreshTimer;
let refreshing = false;
function applyActivities(payload) {
  const today = localToday();
  if (payload === lastPayload) {
    if (!milestone && today !== lastComparisonDay) update();
    lastComparisonDay = today;
    return;
  }
  const allActivities = JSON.parse(payload).map(prepareActivity);
  if (milestone) {
    activities = rankMilestone(allActivities, milestone);
    ranks = new Map(activities.map(({ id }, index) => [id, index + 1]));
  } else {
    activities = allActivities;
    renderMilestones(activities);
  }
  lastPayload = payload;
  lastComparisonDay = today;
  const selectedTypes = new Set([...type.selectedOptions].map(option => option.value));
  const types = [...new Set(activities.map(activity => activity.type))].sort();
  type.replaceChildren();
  for (const label of types) {
    addOption(type, label, label);
    type.options[type.options.length - 1].selected = selectedTypes.has(label);
  }
  for (const [key, select] of categoryInputs.slice(0, 3)) {
    const selected = select.value;
    const values = [...new Set(activities.map(row => row[key]).filter(value => value != null).map(String))].sort();
    select.replaceChildren();
    addOption(select, "", "Any");
    for (const value of values) addOption(select, value, value);
    select.value = values.includes(selected) ? selected : "";
  }
  const dates = activities.map(activity => activity.day).filter(Boolean).sort();
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  get("coverage").textContent = format(activities.length) + (milestone ? " qualifying workouts" : " workouts in FitStats") +
    (firstDate && lastDate ? " · " + firstDate + " to " + lastDate : "");
  update();
}

async function refreshActivities() {
  refreshing = true;
  try {
    const response = await fetch("/api/activities", { cache: "no-store" });
    if (!response.ok) throw new Error("Activity request failed");
    const syncedAt = response.headers.get("X-Strava-Last-Successful-Sync");
    lastSyncSuccess = syncedAt;
    lastSyncFailure = response.headers.get("X-Strava-Last-Sync-Failure");
    syncButton.hidden = response.headers.get("X-FitStats-Manual-Sync") !== "1";
    if (manualSync && (lastSyncSuccess !== manualSync.success ||
        lastSyncFailure && lastSyncFailure !== manualSync.failure || Date.now() >= manualSync.deadline)) {
      const inserted = response.headers.get("X-Strava-New-Workouts");
      const successMessage = inserted === null ? "Sync complete."
        : inserted === "0" ? "No new workouts"
        : inserted === "1" ? "1 new workout" : `${format(Number(inserted))} new workouts`;
      syncFeedback.textContent = lastSyncSuccess !== manualSync.success
        ? successMessage
        : lastSyncFailure && lastSyncFailure !== manualSync.failure ? "Sync failed. Try again." : "Sync is taking longer than expected.";
      manualSync = undefined;
      syncButton.disabled = false;
    }
    if (syncedAt) {
      lastStravaSync.dateTime = syncedAt;
      lastStravaSync.textContent = syncTimeFormat.format(new Date(syncedAt));
    } else {
      lastStravaSync.removeAttribute("datetime");
      lastStravaSync.textContent = "No successful sync recorded";
    }
    const payload = await response.text();
    applyActivities(payload);
  } catch {
    if (lastPayload === undefined) {
      lastStravaSync.textContent = "Unavailable. Retrying automatically.";
      get("coverage").textContent = "Could not load activities. Retrying automatically.";
      update();
    }
  } finally {
    refreshing = false;
    refreshTimer = window.setTimeout(refreshActivities, manualSync ? 2_000 : 60_000);
  }
}
if (isStatic) {
  const rows = demo ? demo.then(({ demoActivities }) => demoActivities) : readSnapshot("./workouts.json");
  void rows.then(activities => {
    datasetEndDay = activities.reduce((day, activity) => {
      const date = (activity.localDate ?? activity.date)?.slice(0, 10) ?? "";
      return date > day ? date : day;
    }, "");
    applyActivities(JSON.stringify(activities));
  }).catch(() => {
    get("coverage").textContent = "Could not load the workouts.";
  });
} else {
  void refreshActivities();
}
