const $ = (id) => document.getElementById(id);

// --- Formatting ------------------------------------------------------------

function fmtTime(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtPace(secondsPerKm) {
  const s = Math.round(secondsPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}

function fmtClock(seconds) {
  const m = Math.floor(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

// Read a color from the CSS variables, so charts match light and dark mode
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --- Map -----------------------------------------------------------------------

let map = null;
let routeLayer = null;

function drawMap(course) {
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  }
  map.invalidateSize(); // the map was hidden until now, so let Leaflet re-measure it
  if (routeLayer) routeLayer.remove();

  const points = course.lat.map((lat, i) => [lat, course.lon[i]]);
  const route = L.polyline(points, { color: cssVar("--accent"), weight: 4 });
  const layers = [
    route,
    L.circleMarker(points[0], { radius: 7, color: "#16a34a", fillOpacity: 1 }).bindTooltip("Start"),
    L.circleMarker(points.at(-1), { radius: 7, color: "#dc2626", fillOpacity: 1 }).bindTooltip("Finish"),
  ];
  for (let km = 5; km * 1000 < course.distance_m; km += 5) {
    const i = course.distance.findIndex((d) => d >= km * 1000);
    if (i >= 0) {
      layers.push(L.circleMarker(points[i], { radius: 4, color: cssVar("--text"), fillOpacity: 1 })
        .bindTooltip(`${km} km`));
    }
  }
  routeLayer = L.layerGroup(layers).addTo(map);
  map.fitBounds(route.getBounds(), { padding: [20, 20] });
}

// --- Charts --------------------------------------------------------------------

const charts = {};

function makeChart(id, config) {
  if (charts[id]) charts[id].destroy(); // replace the old chart on a new simulation
  charts[id] = new Chart(document.getElementById(id), config);
}

function drawProfile(course, paces) {
  const km = course.distance.map((d) => d / 1000);
  makeChart("profile-chart", {
    type: "line",
    plugins: [replayCursor],
    data: {
      datasets: [
        {
          label: "Elevation (m)",
          data: km.map((x, i) => ({ x, y: course.elevation[i] })),
          yAxisID: "elev",
          borderColor: cssVar("--muted"),
          backgroundColor: "rgba(127, 127, 127, 0.2)",
          fill: true,
          pointRadius: 0,
          borderWidth: 1,
        },
        {
          label: "Planned pace",
          data: km.map((x, i) => ({ x, y: paces[i] })),
          yAxisID: "pace",
          borderColor: cssVar("--accent"),
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "linear", max: course.distance_m / 1000, ticks: { stepSize: 5}, title: { display: true, text: "Distance (km)" } },
        elev: { position: "left", title: { display: true, text: "Elevation (m)" } },
        pace: {
          position: "right",
          reverse: true, // faster pace plotted higher
          grid: { drawOnChartArea: false },
          title: { display: true, text: "Pace (min/km)" },
          ticks: { callback: (v) => fmtPace(v).replace("/km", "") },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => `${items[0].parsed.x.toFixed(1)} km`,
            label: (ctx) => ctx.dataset.yAxisID === "pace"
              ? `Pace: ${fmtPace(ctx.parsed.y)}`
              : `Elevation: ${ctx.parsed.y.toFixed(1)} m`,
          },
        },
      },
    },
  });
}

function drawHistogram(mc) {
  const { edges, counts } = mc.histogram;
  const total = counts.reduce((a, b) => a + b, 0);
  makeChart("histogram-chart", {
    type: "bar",
    data: {
      labels: counts.map((_, i) => fmtClock(edges[i])),
      datasets: [{
        data: counts.map((c) => (c / total) * 100),
        backgroundColor: counts.map((_, i) => (edges[i + 1] <= mc.goal_s ? cssVar("--accent") : cssVar("--muted"))),
        barPercentage: 1,
        categoryPercentage: 1,
      }],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { title: { display: true, text: "Finish time" } },
        y: { title: { display: true, text: "% of simulated races" } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${fmtTime(edges[items[0].dataIndex])} – ${fmtTime(edges[items[0].dataIndex + 1])}`,
            label: (ctx) => `${ctx.parsed.y.toFixed(1)}% of races`,
          },
        },
      },
    },
  });
}

// --- Splits ----------------------------------------------------------------------

function groupSplits(kmSplits, totalKm, size) {
  // Combine 1 km splits into blocks of `size` km. The last block may be shorter.
  const rows = [];
  let elapsed = 0;
  for (let start = 0; start < kmSplits.length; start += size) {
    const time = kmSplits.slice(start, start + size).reduce((a, b) => a + b, 0);
    const endKm = Math.min(start + size, totalKm);
    elapsed += time;
    rows.push({ endKm, time, pace: time / (endKm - start), elapsed });
  }
  return rows;
}

function kmLabel(km) {
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

function renderSplits() {
  if (!lastResult) return;
  const size = Number($("split-interval").value);
  const rows = groupSplits(lastResult.optimized.km_splits, lastResult.course.distance_m / 1000, size);
  fillTable(
    $("splits"),
    ["Km", "Split", "Avg pace", "Elapsed"],
    rows.map((r) => [kmLabel(r.endKm), fmtDuration(r.time), fmtPace(r.pace), fmtTime(r.elapsed)]),
  );
}

$("split-interval").addEventListener("change", renderSplits);

// --- Ghost-runner replay -----------------------------------------------------

function fmtDuration(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let lastResult = null;
const replay = {
  course: null, paces: null, cum: null, step: 100, finish: 0, goal: 0,
  t: 0, distance: 0, playing: false, last: null, runner: null, ghost: null,
};

// Draws a dashed line on the elevation chart at the runner's current distance
const replayCursor = {
  id: "replayCursor",
  afterDatasetsDraw(chart) {
    if (!replay.course) return;
    const x = chart.scales.x.getPixelForValue(replay.distance / 1000);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--accent");
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function latLngAt(d) {
  // Position on the map at distance d (m), interpolated between segment points
  const { course, step } = replay;
  const last = course.lat.length - 1;
  const x = Math.min(d / step, last);
  const i = Math.floor(x);
  const j = Math.min(i + 1, last);
  const f = x - i;
  return [
    course.lat[i] + f * (course.lat[j] - course.lat[i]),
    course.lon[i] + f * (course.lon[j] - course.lon[i]),
  ];
}

function distanceAt(t) {
  // Distance (m) reached at race time t (s), using binary search on the time table
  const { cum, step, course } = replay;
  if (t >= replay.finish) return course.distance_m;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= t) lo = mid;
    else hi = mid;
  }
  return course.distance[lo] + ((t - cum[lo]) / (cum[lo + 1] - cum[lo])) * step;
}

function setupReplay(course, paces, goalSeconds) {
  const step = course.distance[1] - course.distance[0];
  const cum = [0];
  for (const p of paces) cum.push(cum.at(-1) + (p * step) / 1000);

  Object.assign(replay, {
    course, paces, cum, step, finish: cum.at(-1), goal: goalSeconds,
    t: 0, playing: false, last: null,
  });
  $("scrub").max = Math.round(replay.finish);
  $("play").textContent = "▶ Play";

  if (replay.runner) replay.runner.remove();
  if (replay.ghost) replay.ghost.remove();
  replay.ghost = L.circleMarker(latLngAt(0), { radius: 7, color: cssVar("--muted"), fillOpacity: 0.6 })
    .bindTooltip(`Goal pace (${fmtTime(goalSeconds)})`).addTo(map);
  replay.runner = L.circleMarker(latLngAt(0), { radius: 8, color: cssVar("--accent"), fillOpacity: 1 })
    .bindTooltip("You (optimized plan)").addTo(map);
  updateReplay();
}

function updateReplay() {
  const { t, course, goal, step } = replay;
  const total = course.distance_m;
  const d = distanceAt(t);
  replay.distance = d;

  replay.runner.setLatLng(latLngAt(d));
  replay.ghost.setLatLng(latLngAt(Math.min(total, (t / goal) * total)));
  $("scrub").value = Math.round(t);

  const seg = Math.min(Math.floor(d / step), replay.paces.length - 1);
  const gap = (d / total) * goal - t; // positive = ahead of goal pace
  const gapText = Math.abs(gap) < 1
    ? "on goal pace"
    : `${fmtDuration(Math.abs(gap))} ${gap > 0 ? "ahead of" : "behind"} goal pace`;
  $("replay-info").textContent =
    `${fmtTime(t)} · ${(d / 1000).toFixed(2)} km · ${fmtPace(replay.paces[seg])} · ${gapText}`;

  if (charts["profile-chart"]) charts["profile-chart"].draw();
}

function tick(now) {
  if (!replay.playing) return;
  if (replay.last !== null) {
    const speed = Number($("speed").value);
    replay.t = Math.min(replay.finish, replay.t + ((now - replay.last) / 1000) * speed);
  }
  replay.last = now;
  updateReplay();
  if (replay.t >= replay.finish) {
    replay.playing = false;
    $("play").textContent = "↺ Replay";
    return;
  }
  requestAnimationFrame(tick);
}

$("play").addEventListener("click", () => {
  if (!replay.course) return;
  if (replay.t >= replay.finish) replay.t = 0;
  replay.playing = !replay.playing;
  replay.last = null;
  $("play").textContent = replay.playing ? "❚❚ Pause" : "▶ Play";
  if (replay.playing) requestAnimationFrame(tick);
});

$("scrub").addEventListener("input", (event) => {
  if (!replay.course) return;
  replay.t = Number(event.target.value);
  updateReplay();
});

// --- Pace band download --------------------------------------------------------

function downloadPaceBand() {
  if (!lastResult) return;
  const { course, optimized, strategies } = lastResult;
  const totalKm = course.distance_m / 1000;
  const size = Number($("split-interval").value);
  const rows = groupSplits(optimized.km_splits, totalKm, size);
  const finish = strategies.find((s) => s.name === "Optimized").finish_text;

  const width = 320;
  const rowH = 26;
  const top = 104;
  const height = top + rows.length * rowH + 16;
  const scale = 2; // draw at double resolution for a sharp print

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e4572e";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillText("Race Day Simulator", 16, 28);
  ctx.fillStyle = "#1c2430";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText(course.name, 16, 48);
  ctx.fillText(`Optimized plan · finish ${finish}`, 16, 66);

  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.fillStyle = "#5d6878";
  ctx.fillText("KM", 16, 94);
  ctx.fillText("SPLIT", 110, 94);
  ctx.fillText("ELAPSED", 210, 94);

  ctx.font = "15px ui-monospace, Menlo, monospace";
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const isLast = i === rows.length - 1;
    if (isLast || (size === 1 && r.endKm % 5 === 0)) {
      ctx.fillStyle = "#fde7df"; // highlight every 5 km and the finish
      ctx.fillRect(8, y, width - 16, rowH);
    }
    ctx.fillStyle = "#1c2430";
    ctx.fillText(kmLabel(r.endKm), 16, y + 18);
    ctx.fillText(fmtDuration(r.time), 110, y + 18);
    ctx.fillText(fmtTime(r.elapsed), 210, y + 18);
  });

  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "pace-band.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

$("download-band").addEventListener("click", downloadPaceBand);

// --- Safe DOM helpers (textContent only, never innerHTML, to prevent XSS) ----

function fillTable(table, headers, rows) {
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) tr.insertCell().textContent = value;
  }
}

function fillList(list, items) {
  list.replaceChildren(...items.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
}

// --- Courses -----------------------------------------------------------------

async function loadCourses() {
  const res = await fetch("/api/courses");
  const courses = await res.json();
  $("course_id").replaceChildren(...courses.map((c) => {
    const option = document.createElement("option");
    option.value = c.id;
    option.textContent = `${c.name} (${(c.distance_m / 1000).toFixed(1)} km)`;
    return option;
  }));
}

// --- Personal records --------------------------------------------------------

const RECORD_DISTANCES = [
  ["1 km", 1], ["3 km", 3], ["5 km", 5], ["10 km", 10],
  ["Half marathon", 21.0975], ["Marathon", 42.195],
];

function addRecordRow(distanceKm = 5, time = "") {
  const row = document.createElement("div");
  row.className = "record-row";

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Record distance");
  for (const [label, km] of RECORD_DISTANCES) {
    const option = document.createElement("option");
    option.value = km;
    option.textContent = label;
    option.selected = km === distanceKm;
    select.appendChild(option);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "e.g. 21:47";
  input.value = time;
  input.setAttribute("aria-label", "Record time");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary remove";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Remove record");
  remove.addEventListener("click", () => row.remove());

  row.append(select, input, remove);
  $("records").appendChild(row);
}

function collectRecords() {
  return [...document.querySelectorAll(".record-row")]
    .map((row) => ({
      distance_km: Number(row.querySelector("select").value),
      time: row.querySelector("input").value.trim(),
    }))
    .filter((r) => r.time); // ignore rows left empty
}

function distanceLabel(meters) {
  if (Math.abs(meters - 21097.5) < 1) return "Half marathon";
  if (Math.abs(meters - 42195) < 1) return "Marathon";
  return `${(meters / 1000).toFixed(meters % 1000 === 0 ? 0 : 1)} km`;
}

$("add-record").addEventListener("click", () => addRecordRow());

// --- Form --------------------------------------------------------------------

function buildFormData() {
  const fd = new FormData();
  fd.append("course_id", $("course_id").value);

  const courseFile = $("course_file").files[0];
  if (courseFile) fd.append("course_file", courseFile);
  if ($("course_distance_km").value) fd.append("course_distance_km", $("course_distance_km").value);

  for (const file of $("runs").files) fd.append("runs", file);
  const records = collectRecords();
  if (records.length) fd.append("records", JSON.stringify(records));
  const fitness = $("fitness_time").value.trim();
  if (fitness) fd.append("fitness_time", fitness);

  for (const id of ["goal_time", "temp_c", "dew_c", "simulations"]) {
    fd.append(id, $(id).value);
  }
  return fd;
}

function errorMessage(body) {
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) {
    return body.detail.map((d) => `${d.loc.at(-1)}: ${d.msg}`).join("; ");
  }
  return "Something went wrong on the server.";
}

$("sim-form").addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the browser from reloading the page
  $("submit").disabled = true;
  $("status").textContent = "Simulating your race... this takes a few seconds.";

  try {
    const res = await fetch("/api/simulate", { method: "POST", body: buildFormData() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessage(body));
    showResults(body);
    $("status").textContent = "";
  } catch (err) {
    $("status").textContent = `Error: ${err.message}`;
  } finally {
    $("submit").disabled = false;
  }
});

// --- Results -----------------------------------------------------------------

function showResults(data) {
  const mc = data.monte_carlo;
  $("p-goal-label").textContent = `Chance of sub-${fmtTime(mc.goal_s)}`;
  $("p-goal").textContent = `${Math.round(mc.p_goal * 100)}%`;
  $("median").textContent = mc.median_text;
  $("range").textContent = mc.range_text;
  $("predicted").textContent = data.fitness.predicted_text;

  // Strategies
  fillTable(
    $("strategies"),
    ["Strategy", "Finish", "1st half", "2nd half"],
    data.strategies.map((s) => [s.name, s.finish_text, fmtTime(s.first_half_s), fmtTime(s.second_half_s)]),
  );
  const opt = data.optimized;
  $("optimized-note").textContent =
    `Optimized plan: hill response ${opt.hill_response.toFixed(1)} ` +
    `(0 = even pace, 1 = even effort), effort change over the race ${(opt.split * 100).toFixed(0)}%.`;

  // Fitness
  const sourceText = {
    manual: "Using the fitness time you entered.",
    runs: "Estimated from your training runs",
    records: "Estimated from your personal records",
    "runs+records": "Estimated from your training runs and personal records",
  }[data.fitness.source];
  $("fitness-source").textContent = data.fitness.exponent
    ? `${sourceText} (fatigue exponent ${data.fitness.exponent}).`
    : sourceText;
  fillList($("efforts"), data.fitness.best_efforts.map(
    (e) => `${distanceLabel(e.distance_m)}: ${e.time_text} (${e.source === "record" ? "personal record" : "from runs"})`,
  ));

  // Splits (grouped by the interval chosen in the dropdown)
  lastResult = data;
  renderSplits();

    // Text for the new cards
  $("course-info").textContent =
    `${data.course.name}: ${(data.course.distance_m / 1000).toFixed(1)} km, ` +
    `${data.course.total_climb_m} m total climb.`;
  $("histogram-note").textContent =
    `${mc.simulations} simulated races. Orange bars finish under your goal of ${fmtTime(mc.goal_s)}.`;

  // Show the section first: the map and charts need to be visible to measure their size
  $("results").hidden = false;
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--border");
  drawMap(data.course);
  drawProfile(data.course, opt.segment_paces);
  drawHistogram(mc);
  lastResult = data;
  setupReplay(data.course, opt.segment_paces, mc.goal_s);
  $("results").scrollIntoView({ behavior: "smooth" });
}

loadCourses().catch(() => {
  $("status").textContent = "Could not load courses. Is the server running?";
});