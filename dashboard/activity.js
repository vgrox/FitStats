/* global document, fetch, AbortController */
const node = (tag, value) => {
  const el = document.createElement(tag);
  if (value != null) el.textContent = value;
  return el;
};
const num = v => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const fmt = (v, digits = 2) => num(v)?.toLocaleString("en-IN", { maximumFractionDigits: digits }) ?? "—";
function duration(v) {
  if (num(v) == null || v < 0) return "—";
  const s = Math.round(v);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n, i) => i ? String(n).padStart(2, "0") : n).join(":");
}
function pace(speed, unit = 1000) {
  if (!(speed > 0)) return "—";
  const s = Math.round(unit / speed);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function stats(parent, pairs) {
  const dl = node("dl");
  dl.className = "activity-stats";
  for (const [label, value] of pairs) {
    const item = node("div");
    item.append(node("dt", label), node("dd", value));
    dl.append(item);
  }
  parent.append(dl);
}
function table(parent, title, columns, rows) {
  if (!rows.length) return;
  parent.append(node("h3", title));
  const wrap = node("div");
  wrap.className = "table-scroll";
  const el = node("table"), head = el.createTHead().insertRow(), body = el.createTBody();
  head.append(...columns.map(c => node("th", c)));
  for (const values of rows) body.insertRow().append(...values.map(v => node("td", v)));
  wrap.append(el);
  parent.append(wrap);
}
function polyline(encoded) {
  if (typeof encoded !== "string") return [];
  let offset = 0, lat = 0, lon = 0;
  const points = [];
  const read = () => {
    let result = 0;
    for (let shift = 0; shift <= 30 && offset < encoded.length; shift += 5) {
      const b = encoded.charCodeAt(offset++) - 63;
      if (b < 0 || b > 63) break;
      result |= (b & 31) << shift;
      if (b < 32) return result & 1 ? ~(result >> 1) : result >> 1;
    }
    throw new Error("Invalid route");
  };
  try {
    while (offset < encoded.length) {
      lat += read();
      lon += read();
      points.push([lat / 1e5, lon / 1e5]);
    }
  } catch { return []; }
  return points;
}
const coordinates = p => Array.isArray(p) && p.length >= 2 && num(p[0]) != null && num(p[1]) != null &&
  Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && (Number(p[0]) !== 0 || Number(p[1]) !== 0);
const distance = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin((b[0] - a[0]) * r / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
};
function sources(d) {
  const strava = Object.fromEntries(Object.entries(d.streams).filter(([, s]) => Array.isArray(s?.data)).map(([key, s]) => [key, s.data]));
  const recording = d.recording?.data?.find(group => group.fields.includes("latlng"));
  const segments = d.fit?.records?.length ? [d.fit.records] : d.gpx ?? d.tcx ?? (recording ? [recording.values.map(row => {
    const p = Object.fromEntries(recording.fields.map((field, i) => [field, row[i]]));
    return { time: p.time, position_lat: p.latlng?.[0], position_long: p.latlng?.[1], altitude: p.elevation,
      speed: p.speed, distance: p.distance };
  })] : []);
  const series = {};
  const tracks = [];
  let firstTime = null, accumulated = 0;
  for (const segment of segments) {
    let prev = null, previousTime = null, chartPoint = null;
    const track = [];
    for (const p of segment) {
      const coord = [num(p.position_lat), num(p.position_long)];
      const valid = coordinates(coord);
      const step = valid && prev ? distance(prev, coord) : null;
      if (valid) { track.push(coord); prev = coord; }
      if (step != null) accumulated += step;
      const timestamp = p.timestamp == null ? num(p.time) : num(Date.parse(p.timestamp) / 1000);
      if (timestamp == null) continue;
      firstTime ??= timestamp;
      const elapsed = timestamp - firstTime;
      const speed = num(p.enhanced_speed ?? p.speed) ?? (timestamp > previousTime && previousTime != null && step != null ? step / (timestamp - previousTime) : null);
      const fields = { altitude: p.enhanced_altitude ?? p.altitude, heartrate: p.heart_rate,
        cadence: p.cadence, watts: p.power, temp: p.temperature, velocity_smooth: speed,
        distance: p.distance ?? (valid ? accumulated : null) };
      if (d.fit?.records?.length) {
        fields.fit_gps_accuracy = p.gps_accuracy;
        fields.fit_speed = p.enhanced_speed ?? p.speed;
      }
      for (const [key, value] of Object.entries(fields)) {
        (series[key] ??= []).push([elapsed, num(value), chartPoint === null]);
      }
      previousTime = timestamp;
      chartPoint = elapsed;
    }
    if (track.length > 1) tracks.push(track);
  }
  for (const [key, values] of Object.entries(strava)) {
    if (key === "latlng" || key === "time" || key === "moving") continue;
    if (strava.time?.length === values.length && values.length > 1) {
      series[key] = values.map((value, i) => [strava.time[i], num(value), false]);
    }
  }
  return { series, tracks, strava };
}
function canvas(parent, label, klass = "") {
  const c = node("canvas");
  c.className = klass;
  c.setAttribute("role", "img");
  c.setAttribute("aria-label", label);
  parent.append(c);
  c.width = Math.max(280, Math.round(c.clientWidth * 2));
  c.height = Math.round(c.clientHeight * 2);
  return c;
}
function plotRoute(parent, tracks, label) {
  parent.append(node("h3", "GPS route"), node("p", label));
  if (!tracks.length) return;
  const c = canvas(parent, label + ". Green is the start and orange is the finish.", "route-canvas");
  const ctx = c.getContext("2d");
  const origin = tracks[0][0];
  const cos = Math.cos(origin[0] * Math.PI / 180);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const projected = tracks.map(track => track.map(([lat, lon]) => {
    const x = (((lon - origin[1] + 540) % 360) - 180) * cos, y = lat - origin[0];
    minX = Math.min(x, minX); maxX = Math.max(x, maxX); minY = Math.min(y, minY); maxY = Math.max(y, maxY);
    return [x, y];
  }));
  const scale = Math.min((c.width - 84) / Math.max(maxX - minX, .00001), (c.height - 84) / Math.max(maxY - minY, .00001));
  const xy = ([x, y]) => [c.width / 2 + (x - (minX + maxX) / 2) * scale, c.height / 2 - (y - (minY + maxY) / 2) * scale];
  ctx.strokeStyle = "#293634";
  ctx.lineWidth = 1;
  for (let x = 0; x < c.width; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke(); }
  for (let y = 0; y < c.height; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke(); }
  ctx.strokeStyle = "#a8dbff";
  ctx.lineWidth = 4;
  for (const track of projected) {
    ctx.beginPath();
    track.forEach((point, i) => i ? ctx.lineTo(...xy(point)) : ctx.moveTo(...xy(point)));
    ctx.stroke();
  }
  for (const [point, color] of [[projected[0][0], "#bdf875"], [projected.at(-1).at(-1), "#ffa772"]]) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(...xy(point), 7, 0, Math.PI * 2); ctx.fill();
  }
  parent.append(node("p", "North up · green start · orange finish · route drawn locally without street tiles"));
}
const chartLabels = {
  velocity_smooth: ["Speed", "km/h", v => v * 3.6], heartrate: ["Heart rate", "bpm"],
  cadence: ["Cadence (as recorded)", "rpm"], altitude: ["Elevation", "m"], watts: ["Power", "W"],
  fit_gps_accuracy: ["Device GPS accuracy", "m"],
  fit_speed: ["Device speed", "km/h", v => v * 3.6],
  temp: ["Temperature", "°C"], grade_smooth: ["Grade", "%"], distance: ["Distance", "km", v => v / 1000]
};
const healthChartLabels = {
  runningPower: ["Running power", "W"],
  strideLength: ["Running stride length", "m"],
  groundContactTime: ["Ground contact time", "ms"],
  verticalOscillation: ["Vertical oscillation", "cm"]
};
function charts(parent, series, paceUnit, labels = chartLabels, title = "Recorded time series") {
  const available = Object.entries(labels).filter(([key]) => series[key]?.some(([, v]) => v != null));
  if (!available.length) return;
  parent.append(node("h3", title));
  const grid = node("div");
  grid.className = "activity-charts";
  parent.append(grid);
  if (paceUnit) available.unshift(["velocity_smooth", ["Pace", paceUnit === 100 ? "min/100 m" : "min/km", v => v > 0 ? paceUnit / v : null, true]]);
  for (const [key, [label, unit, convert = v => v, isPace]] of available) {
    if (!series[key]) continue;
    const points = series[key].map(([t, v, gap]) => [t, v == null ? null : convert(v), gap]);
    let lo = Infinity, hi = -Infinity, finish = 0;
    for (const [t, v] of points) if (Number.isFinite(t) && Number.isFinite(v)) {
      lo = Math.min(lo, v); hi = Math.max(hi, v); finish = Math.max(finish, t);
    }
    if (!Number.isFinite(lo)) continue;
    const display = v => isPace ? pace(paceUnit / v, paceUnit) : fmt(v);
    const panel = node("section");
    grid.append(panel);
    panel.append(node("h4", label + " · " + unit));
    const c = canvas(panel, label + " over elapsed time");
    const ctx = c.getContext("2d");
    ctx.strokeStyle = "#bdf875";
    ctx.lineWidth = 3;
    ctx.beginPath();
    let previous = false;
    for (const [t, v, gap] of points) {
      if (!Number.isFinite(v) || !Number.isFinite(t)) { previous = false; continue; }
      const x = 8 + (c.width - 16) * t / Math.max(1, finish);
      const y = c.height - 16 - (c.height - 32) * (hi === lo ? .5 : (v - lo) / (hi - lo));
      if (previous && !gap) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      previous = true;
    }
    ctx.stroke();
    const readout = node("p", `${display(lo)}–${display(hi)} ${unit} · 0:00:00 to ${duration(finish)}`);
    c.addEventListener("pointermove", event => {
      const rect = c.getBoundingClientRect();
      const target = finish * (event.clientX - rect.left) / rect.width;
      let nearest;
      for (const point of points) if (Number.isFinite(point[1]) && (!nearest || Math.abs(target - point[0]) < Math.abs(target - nearest[0]))) nearest = point;
      if (nearest) readout.textContent = duration(nearest[0]) + " · " + display(nearest[1]) + " " + unit;
    });
    panel.append(readout);
  }
}
function distanceSplits(points, size = 1000) {
  const rows = [];
  let start = null, prev = null, target = size, index = 1;
  for (const [t, d] of points ?? []) {
    if (!Number.isFinite(t) || !Number.isFinite(d)) continue;
    if (!prev) {
      prev = [t, d];
      start = prev;
      target += d;
      continue;
    }
    if (d < prev[1] || t < prev[0]) continue;
    while (d >= target && d > prev[1]) {
      const end = prev[0] + (t - prev[0]) * (target - prev[1]) / (d - prev[1]);
      rows.push({ split: index++, distance: target - start[1], elapsed_time: end - start[0] });
      start = [end, target];
      target += size;
    }
    prev = [t, d];
  }
  if (prev && start && prev[1] - start[1] >= 1) rows.push({ split: index, distance: prev[1] - start[1], elapsed_time: prev[0] - start[0] });
  return rows;
}
function splitTable(parent, title, rows, unit, estimated = false, speedOnly = false) {
  const distanceUnit = unit === 1609.344 ? "mi" : unit === 100 ? "m" : "km";
  table(parent, title, ["Split", "Distance", "Moving / timer", "Elapsed", speedOnly ? "Avg speed (km/h)" : `Pace /${unit === 100 ? "100 m" : distanceUnit}`, "Avg HR (bpm)", "Avg cadence", "Avg power (W)", "Elevation Δ (m)"],
    rows.map((s, i) => {
      const metres = num(s.distance ?? s.total_distance);
      const moving = s.moving_time ?? s.total_timer_time;
      const elapsed = s.elapsed_time ?? s.total_elapsed_time;
      const seconds = estimated ? elapsed : moving;
      const speed = s.average_speed ?? s.avg_speed ?? (seconds > 0 && metres != null ? metres / seconds : null);
      return [s.split ?? i + 1, metres == null ? "—" : fmt(metres / (unit === 100 ? 1 : unit), 3) + " " + distanceUnit,
        duration(moving), duration(elapsed), speedOnly ? fmt(speed == null ? null : speed * 3.6) : pace(speed, unit),
        fmt(s.average_heartrate ?? s.avg_heart_rate), fmt(s.average_cadence ?? s.avg_cadence),
        fmt(s.average_watts ?? s.avg_power), fmt(s.elevation_difference)];
    }));
}
function fitDetails(parent, fit, unit, speedOnly) {
  if (!fit) return;
  const section = node("details");
  const session = fit.sessions?.[0] ?? {};
  const device = fit.device_infos?.find(info => info.device_model || info.device_manufacturer) ?? {};
  const recordingDevice = [device.device_manufacturer, device.device_model].filter(Boolean).join(" ");
  const elapsed = num(session.total_elapsed_time);
  const timer = num(session.total_timer_time);
  const cycles = num(session.total_cycles);
  const metres = num(session.total_distance);
  const paused = elapsed != null && timer != null && elapsed >= timer ? elapsed - timer : null;
  const rows = [
    ["Device elapsed time", elapsed == null ? null : duration(elapsed)],
    ["Device timer time", timer == null ? null : duration(timer)],
    ["Device elapsed minus timer", paused == null ? null : duration(paused)],
    ["Device distance", metres == null ? null : unit === 100 ? fmt(metres) + " m" : fmt(metres / 1000, 3) + " km"],
    ["Device total cycles", cycles == null ? null : fmt(cycles, 0)],
    ["Auto-pause", session.autopause_enabled == null ? null : session.autopause_enabled ? "On" : "Off"],
    ["Recording device", recordingDevice || null],
    ["Device OS version", device.device_os_version],
    ["Recording app version", device.mobile_app_version]
  ].filter(([, value]) => value != null && value !== "");
  section.append(node("summary", "Original FIT recording"));
  if (rows.length) stats(section, rows);
  if (cycles != null) section.append(node("p", "The device recorded a cycle total. FIT does not identify it here as steps or cadence."));
  splitTable(section, "Original FIT laps", fit.laps ?? [], unit, false, speedOnly);
  const events = (fit.events ?? []).flatMap(event => {
    if (event.event !== "timer" || !event.timestamp || !event.event_type) return [];
    return [[event.timestamp, event.event_type.replaceAll("_", " ")]];
  });
  table(section, "Device timer events", ["Time (UTC)", "Event"], events);
  parent.append(section);
}
function rawSection(parent, d) {
  const details = node("details");
  details.append(node("summary", "All imported fields and recording data"));
  table(details, "Strava export metrics", ["Field", "Value"], d.export ?? []);
  const data = node("details");
  data.append(node("summary", "Inspect full source data (JSON)"));
  data.addEventListener("toggle", () => {
    if (data.open && data.children.length === 1) data.append(node("pre", JSON.stringify(d, null, 2)));
  });
  details.append(data);
  parent.append(details);
}
function render(parent, d) {
  const s = d.summary, raw = d.detail ?? d.raw, fit = d.fit?.sessions?.[0] ?? {};
  const fields = new Map(d.export ?? []);
  const type = s.activity_type_override ?? s.sport_type ?? s.activity_type ?? "Activity";
  const swimming = /swim/i.test(type);
  const run = /run|walk|hike/i.test(type);
  const unit = swimming ? 100 : 1000;
  const speed = num(raw.average_speed ?? s.average_speed_mps) ?? (s.moving_time_s > 0 && num(s.distance_m) != null ? s.distance_m / s.moving_time_s : null);
  parent.append(node("p", [type, s.start_date_local?.replace("T", " ").replace(/Z$/, "") ?? s.start_date, s.timezone].filter(Boolean).join(" · ")));
  if (raw.description ?? s.description) parent.append(node("p", raw.description ?? s.description));
  const value = (v, label) => num(v) == null ? "—" : fmt(v) + " " + label;
  const measured = [
    ["Distance", value(s.distance_m == null ? null : s.distance_m / (swimming ? 1 : 1000), swimming ? "m" : "km")],
    ["Moving time", duration(s.moving_time_s)],
    ["Elapsed time", duration(s.elapsed_time_s)],
    ["Device timer time", duration(fields.get("Timer Time") ?? fit.total_timer_time ?? d.recording?.metadata?.timer_time)],
    ["Elapsed minus moving", s.elapsed_time_s != null && s.elapsed_time_s >= s.moving_time_s && s.moving_time_s != null ? duration(s.elapsed_time_s - s.moving_time_s) : "—"],
    ...(run || swimming ? [[`Average pace /${swimming ? "100 m" : "km"}`, pace(speed, unit)]] : []),
    ["Average speed", value(speed == null ? null : speed * 3.6, "km/h")],
    ["Max speed", value(s.max_speed_mps == null ? null : s.max_speed_mps * 3.6, "km/h")],
    ["Elevation gain", value(s.total_elevation_gain_m ?? fit.total_ascent, "m")],
    ["Elevation loss", value(fields.get("Elevation Loss") ?? fit.total_descent, "m")],
    ["Average heart rate", value(s.average_heartrate_bpm ?? fit.avg_heart_rate, "bpm")],
    ["Max heart rate", value(s.max_heartrate_bpm ?? fit.max_heart_rate, "bpm")],
    ["Average cadence (as recorded)", value(s.average_cadence_rpm ?? fit.avg_cadence, "rpm")],
    ["Max cadence (as recorded)", value(s.max_cadence_rpm ?? fields.get("Max Cadence") ?? fit.max_cadence, "rpm")],
    ["Steps", fmt(fields.get("Total Steps") ?? raw.steps ?? raw.total_steps ?? fit.total_steps ?? d.apple_health?.steps, 0)],
    ["Calories", value(raw.calories ?? s.calories_kcal ?? fields.get("Calories") ?? fit.total_calories, "kcal")],
    ["Average power", value(s.average_watts ?? fit.avg_power, "W")],
    ["Weighted power", value(s.weighted_average_watts ?? fields.get("Weighted Average Power") ?? fit.normalized_power, "W")],
    ["Max power", value(s.max_watts ?? fit.max_power, "W")],
    ["Energy output", value(s.kilojoules ?? (fit.total_work == null ? null : fit.total_work / 1000), "kJ")],
    ["Relative effort", fmt(raw.suffer_score ?? fields.get("Relative Effort"))],
    ["Device", raw.device_name ?? "—"]
  ];
  stats(parent, measured);
  const health = d.apple_health;
  if (health || d.apple_health_series) {
    const rows = [];
    if (health?.steps != null) rows.push(["Workout steps", fmt(health?.steps, 0)]);
    if (health?.sampledSteps != null) {
      rows.push(["Steps in watch samples (partial)", fmt(health.sampledSteps, 0)]);
      rows.push(["Workout time covered by step samples", fmt(health.stepSampleCoverage * 100, 1) + "%"]);
    }
    if (health?.estimatedStepCadence != null) {
      rows.push(["Estimated average step rate", fmt(health.estimatedStepCadence) + " steps/min"]);
      rows.push(["Estimate based on", health.cadenceMethod]);
    }
    const labels = {
      runningPower: "Running power",
      strideLength: "Running stride length",
      groundContactTime: "Ground contact time",
      verticalOscillation: "Vertical oscillation",
      swimmingStrokeCount: "Swimming strokes"
    };
    const workoutMetrics = Object.entries(health?.workoutMetrics ?? {}).filter(([key]) => labels[key]);
    if (rows.length || workoutMetrics.length) {
      parent.append(node("h3", "Apple Health"));
      if (rows.length) stats(parent, rows);
      table(parent, "Workout statistics", ["Metric", "Average", "Min", "Max", "Total"],
        workoutMetrics.map(([key, metric]) => [labels[key], ...["average", "minimum", "maximum", "sum"]
          .map(field => metric[field] == null ? "—" : fmt(metric[field], 2) + " " + metric.unit)]));
    }
  }
  if (d.apple_health_series) {
    charts(parent, d.apple_health_series, null, healthChartLabels, "Apple Health running charts");
  }
  const { series, tracks, strava } = sources(d);
  const apiTrack = (strava.latlng ?? []).filter(coordinates);
  const encoded = polyline(raw.map?.polyline ?? raw.map?.summary_polyline ?? s.summary_polyline).filter(coordinates);
  const route = tracks.length ? tracks : apiTrack.length > 1 ? [apiTrack] : encoded.length > 1 ? [encoded] : [];
  plotRoute(parent, route, tracks.length ? "Original recording" : apiTrack.length > 1 ? "Strava GPS stream" :
    route.length ? (raw.map?.polyline ? "Strava route" : "Strava summary route") : "No GPS route available.");
  if (raw.splits_metric?.length) splitTable(parent, "Strava kilometre splits", raw.splits_metric, 1000);
  else if (run || swimming) {
    const splits = distanceSplits(series.distance, unit);
    if (splits.length) splitTable(parent, "Estimated distance splits · elapsed pace includes stops", splits, unit, true);
    else parent.append(node("p", "No distance splits available."));
  }
  if (raw.splits_standard?.length) splitTable(parent, "Strava mile splits", raw.splits_standard, 1609.344);
  splitTable(parent, "Strava laps", raw.laps ?? [], unit, false, !run && !swimming);
  fitDetails(parent, d.fit, unit, !run && !swimming);
  charts(parent, series, run || swimming ? unit : null);
  const zones = Array.isArray(d.zones) ? d.zones : [];
  for (const zone of zones) {
    const rows = zone.distribution_buckets ?? [];
    table(parent, zone.type === "heartrate" ? "Strava heart rate zones" : "Strava " + zone.type + " zones", ["Zone", "Range", "Time", "Share"],
      rows.map((z, i) => {
        const total = rows.reduce((sum, row) => sum + (row.time ?? 0), 0);
        return [i + 1, `${z.max < 0 ? z.min + "+" : z.min + "–" + z.max} ${zone.type === "heartrate" ? "bpm" : "W"}`, duration(z.time),
          total > 0 ? fmt(z.time / total * 100, 1) + "%" : "—"];
      }));
  }
  if (!zones.some(z => z.type === "heartrate" && z.distribution_buckets?.length)) {
    parent.append(node("h3", "Heart rate zones"), node("p", "No verified Strava zone breakdown stored for this activity."));
  }
  rawSection(parent, d);
  if (s.strava_activity_id == null) return;
  const link = node("a", "View activity on Strava");
  link.href = "https://www.strava.com/activities/" + s.strava_activity_id;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  parent.append(link);
}
let dialog, body, title, request;
async function fetchActivity(id, signal) {
  const response = await fetch("/api/activities/" + id, { signal });
  if (!response.ok) throw new Error("Activity details could not be loaded.");
  return response.json();
}

export async function openActivity(id, loadActivity = fetchActivity) {
  if (!dialog) {
    dialog = node("dialog");
    dialog.className = "activity-dialog";
    title = node("h2", "Activity details");
    title.id = "activity-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const header = node("header"), close = node("button", "Close");
    close.addEventListener("click", () => dialog.close());
    header.append(title, close);
    body = node("div");
    body.className = "activity-body";
    dialog.append(header, body);
    document.body.append(dialog);
    dialog.addEventListener("close", () => request?.abort());
  }
  request?.abort();
  const current = new AbortController();
  request = current;
  body.replaceChildren(node("p", "Loading activity…"));
  title.textContent = "Activity details";
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  try {
    const d = await loadActivity(id, current.signal);
    if (current.signal.aborted) return;
    title.textContent = d.summary.name;
    body.replaceChildren();
    render(body, d);
  } catch (error) {
    if (!current.signal.aborted) body.replaceChildren(node("p", error.message));
  }
}
