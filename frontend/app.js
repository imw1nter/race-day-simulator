const $ = (id) => document.getElementById(id);

// Read a color from the CSS variables, so charts match light and dark mode
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- Formatting ----------------------------------------------------------------------

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

function fmtDuration(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtClock(seconds) {
  const m = Math.floor(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function distanceLabel(meters) {
  if (Math.abs(meters - 21097.5) < 1) return "Half marathon";
  if (Math.abs(meters - 42195) < 1) return "Marathon";
  return `${(meters / 1000).toFixed(meters % 1000 === 0 ? 0 : 1)} km`;
}

function kmLabel(km) {
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

// --- Safe DOM helpers (textContent only, never innerHTML with user data, to prevent XSS)

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fillTable(table, headers, rows) {
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const h of headers) head.appendChild(el("th", "", h));
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) tr.insertCell().textContent = value;
  }
}

function fillList(list, items) {
  list.replaceChildren(...items.map((text) => el("li", "", text)));
}

// --- Step 1: course ----------------------------------------------------------------------

async function loadCourses() {
  const res = await fetch("/api/courses");
  const courses = await res.json();
  const container = $("course-options");
  const uploadCard = container.querySelector(".upload-card");
  courses.forEach((c, i) => {
    const card = el("label", "option-card");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "course";
    input.value = c.id;
    input.checked = i === 0;
    card.append(input, el("span", "option-title", c.name), el("span", "option-sub", `${(c.distance_m / 1000).toFixed(1)} km`));
    container.insertBefore(card, uploadCard);
  });
  updateCourseChoice();
}

function selectedCourse() {
  const checked = document.querySelector('input[name="course"]:checked');
  return checked ? checked.value : null;
}

function updateCourseChoice() {
  $("upload-fields").hidden = selectedCourse() !== "upload";
}

$("course-options").addEventListener("change", updateCourseChoice);

// --- Step 2: fitness -----------------------------------------------------------------------

let fitnessMethod = "times";

function setMethod(method) {
  fitnessMethod = method;
  document.querySelectorAll("[data-method]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.method === method));
  });
  document.querySelectorAll(".method-panel").forEach((p) => {
    p.hidden = p.dataset.panel !== method;
  });
}

document.querySelectorAll("[data-method]").forEach((b) => {
  b.addEventListener("click", () => setMethod(b.dataset.method));
});

$("runs").addEventListener("change", () => {
  const n = $("runs").files.length;
  $("runs-label").textContent = n
    ? `${n} file${n === 1 ? "" : "s"} selected`
    : "Choose or drop GPX, FIT, or TCX files";
});

const RECORD_DISTANCES = [
  ["1 km", 1], ["3 km", 3], ["5 km", 5], ["10 km", 10],
  ["Half marathon", 21.0975], ["Marathon", 42.195],
];

function addRecordRow(distanceKm = 5, time = "") {
  const row = el("div", "record-row");

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Race distance");
  for (const [label, km] of RECORD_DISTANCES) {
    const option = el("option", "", label);
    option.value = km;
    option.selected = km === distanceKm;
    select.appendChild(option);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.placeholder = "21:47";
  input.value = time;
  input.setAttribute("aria-label", "Race time");

  const remove = el("button", "icon-button", "✕");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove this race");
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

$("add-record").addEventListener("click", () => addRecordRow());
addRecordRow(5);

// --- Step 3: weather presets -----------------------------------------------------------------

const WEATHER = { cool: [12, 5], mild: [18, 12], warm: [22, 16], hot: [27, 20] };

document.querySelectorAll('input[name="weather"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const [temp, dew] = WEATHER[radio.value];
    $("temp_c").value = temp;
    $("dew_c").value = dew;
  });
});

// Editing the exact values selects the matching preset, or none ("custom")
for (const id of ["temp_c", "dew_c"]) {
  $(id).addEventListener("input", () => {
    const match = Object.entries(WEATHER).find(
      ([, [t, d]]) => Number($("temp_c").value) === t && Number($("dew_c").value) === d,
    );
    document.querySelectorAll('input[name="weather"]').forEach((r) => {
      r.checked = match ? r.value === match[0] : false;
    });
  });
}

// --- Submitting the form ---------------------------------------------------------------------

function buildFormData() {
  const fd = new FormData();
  const course = selectedCourse();
  if (!course) throw new Error("Choose a course first.");
  if (course === "upload") {
    const file = $("course_file").files[0];
    if (!file) throw new Error("Choose a GPX file for your course, or pick a built-in course.");
    fd.append("course_file", file);
    if ($("course_distance_km").value) fd.append("course_distance_km", $("course_distance_km").value);
  } else {
    fd.append("course_id", course);
  }

  // Race times and watch files are combined; the quick estimate overrides both
  const records = collectRecords();
  if (records.length) fd.append("records", JSON.stringify(records));
  for (const file of $("runs").files) fd.append("runs", file);
  if (fitnessMethod === "quick") {
    const fitness = $("fitness_time").value.trim();
    if (!fitness) throw new Error("Enter your current fitness time, or choose another method.");
    fd.append("fitness_time", fitness);
  }

  for (const id of ["goal_time", "temp_c", "dew_c", "simulations"]) fd.append(id, $(id).value);
  return fd;
}

function errorMessage(body) {
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) return body.detail.map((d) => `${d.loc.at(-1)}: ${d.msg}`).join("; ");
  return "Something went wrong on the server. Try again.";
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

$("sim-form").addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the browser from reloading the page
  $("submit").disabled = true;
  try {
    const body = buildFormData();
    setStatus("Simulating your race…");
    const res = await fetch("/api/simulate", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorMessage(data));
    setStatus("");
    showResults(data);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("submit").disabled = false;
  }
});

// --- Gantry clock ----------------------------------------------------------------------------

let clockFrame = null;

// Count the clock up to the projected finish, like a race clock stopping at the finish
function runClock(targetSeconds) {
  const clock = $("median");
  $("clock-ghost").textContent = fmtTime(targetSeconds).replace(/\d/g, "8"); // unlit segments
  cancelAnimationFrame(clockFrame);
  if (reduceMotion) {
    clock.textContent = fmtTime(targetSeconds);
    return;
  }
  const duration = 1400; // ms
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3); // fast start, gentle stop
    clock.textContent = fmtTime(targetSeconds * eased);
    if (progress < 1) clockFrame = requestAnimationFrame(step);
  };
  clockFrame = requestAnimationFrame(step);
}

// --- Takeaways --------------------------------------------------------------------------------

// Simple outline icons (static markup, no user data)
const ICONS = {
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  mountain: '<path d="M3 19l6-10 4 6 2-3 6 7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

function iconSvg(name) {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function minutesText(seconds) {
  if (seconds < 60) return "less than a minute";
  const m = Math.round(seconds / 60);
  return `about ${m} minute${m === 1 ? "" : "s"}`;
}

let lastTakeaways = [];
function renderTakeaways(data) {
  const { optimized: opt, insights, monte_carlo: mc } = data;
  const goalText = fmtTime(mc.goal_s);
  const items = [];

  // 1. How to pace it
  let title = "Run an even effort";
  let text = "Going out faster gained nothing in the simulation and raises the risk of fading after 30 km.";
  if (opt.split > 0.005) {
    title = "Start a little easier";
    text = "The best plan builds effort gradually and finishes stronger than it starts.";
  } else if (opt.split < -0.005) {
    title = "Start a little stronger";
    text = "On this course, the best plan uses a little more effort while you're fresh.";
  }
  if (opt.hill_response < 0.95) text += " Push a little on climbs and ease off on descents.";
  items.push(["gauge", title, text]);

  if (insights) {
    // 2. Where the course is hardest
    const c = insights.climb;
    if (c.gain_m >= 3) {
      items.push(["mountain", `Save energy for km ${c.start_km} to ${c.end_km}`,
        `The biggest climb of the course, about ${Math.round(c.gain_m)} m. Expect around ${fmtPace(c.slowest_pace_s)} there, then make it back on the descent.`]);
    } else {
      items.push(["mountain", "A flat course",
        "No stretch climbs more than a few meters, so keep your effort steady from start to finish."]);
    }

    // 3. What the weather does
    const w = insights.weather;
    const now = Math.round(mc.p_goal * 100);
    const other = Math.round(w.compare_p_goal * 100);
    const cost = minutesText(Math.abs(mc.median_s - w.compare_median_s));
    if (w.hot) {
      items.push(["sun", `This weather costs you ${cost}`,
        `On a cool ${w.compare_temp_c}°C day, your chance of breaking ${goalText} would be ${other}% instead of ${now}%.`]);
    } else {
      items.push(["sun", `Heat would cost you ${cost}`,
        `At ${w.compare_temp_c}°C, your chance of breaking ${goalText} drops from ${now}% to ${other}%.`]);
    }
  }

  lastTakeaways = items;
  $("takeaways").replaceChildren(...items.map(([icon, t, body]) => {
    const li = el("li");
    li.innerHTML = iconSvg(icon);
    const textBox = el("div");
    textBox.append(el("p", "takeaway-title", t), el("p", "takeaway-text", body));
    li.appendChild(textBox);
    return li;
  }));
}

// --- Tabs -------------------------------------------------------------------------------------

const TABS = ["course", "pacing", "finish", "splits"];

function selectTab(name) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute("aria-selected", String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  // Maps and charts drawn while hidden need to re-measure once visible
  if (name === "course" && map) map.invalidateSize();
  if (name === "pacing" && charts["profile-chart"]) charts["profile-chart"].resize();
  if (name === "finish" && charts["histogram-chart"]) charts["histogram-chart"].resize();
}

TABS.forEach((t, i) => {
  $(`tab-${t}`).addEventListener("click", () => selectTab(t));
  $(`tab-${t}`).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next);
    $(`tab-${next}`).focus();
  });
});

// --- Results ----------------------------------------------------------------------------------

let lastResult = null;

function showResults(data) {
  lastResult = data;
  const mc = data.monte_carlo;
  const totalKm = data.course.distance_m / 1000;

  // Gantry
  $("gantry-course").textContent = data.course.name;
  $("p-goal").textContent = `${Math.round(mc.p_goal * 100)}%`;
  $("p-goal-label").textContent = `chance of breaking ${fmtTime(mc.goal_s)}`;
  $("range").textContent = `${fmtClock(mc.p10_s)} to ${fmtClock(mc.p90_s)}`;
  $("avg-pace").textContent = fmtPace(mc.median_s / totalKm);

  renderTakeaways(data);

  // Course tab
  $("course-info").textContent =
    `${data.course.name}: ${totalKm.toFixed(1)} km, ${data.course.total_climb_m} m total climb.`;

  // Pacing tab
  fillTable(
    $("strategies"),
    ["Strategy", "Finish", "1st half", "2nd half"],
    data.strategies.map((s) => [s.name, s.finish_text, fmtTime(s.first_half_s), fmtTime(s.second_half_s)]),
  );
  const opt = data.optimized;
  $("optimized-note").textContent =
    `Optimized plan: hill response ${opt.hill_response.toFixed(1)} (0 = even pace, 1 = even effort), ` +
    `effort change over the race ${(opt.split * 100).toFixed(0)}%.`;

  // Finish times tab
  $("histogram-note").textContent =
    `${mc.simulations} simulated races. Amber bars finish under your goal of ${fmtTime(mc.goal_s)}.`;
  const sourceText = {
    manual: "Using the fitness time you entered.",
    runs: "Estimated from your watch files",
    records: "Estimated from your race times",
    "runs+records": "Estimated from your watch files and race times",
  }[data.fitness.source];
  $("fitness-source").textContent = data.fitness.exponent
    ? `${sourceText} (fatigue exponent ${data.fitness.exponent}).`
    : sourceText;
  fillList($("efforts"), data.fitness.best_efforts.map(
    (e) => `${distanceLabel(e.distance_m)}: ${e.time_text} (${e.source === "record" ? "race time" : "from watch files"})`,
  ));
  fillList($("skipped"), data.fitness.skipped.map((s) => `Skipped ${s.file}: ${s.reason}`));

  // Splits tab
  renderSplits();

  // Show the section first: the map and charts need to be visible to measure their size
  $("results").hidden = false;
  selectTab("course");
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--border");
  Chart.defaults.font.family = '"Work Sans", system-ui, sans-serif';
  drawMap(data.course);
  drawProfile(data.course, opt.segment_paces);
  drawHistogram(mc);
  setupReplay(data.course, opt.segment_paces, mc.goal_s);
  runClock(mc.median_s);
  $("results").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
}

// --- Map ----------------------------------------------------------------------------------------

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
  map.invalidateSize();
  if (routeLayer) routeLayer.remove();

  const points = course.lat.map((lat, i) => [lat, course.lon[i]]);
  const route = L.polyline(points, { color: "#C98400", weight: 5 });
  const layers = [
    route,
    L.circleMarker(points[0], { radius: 7, color: "#ffffff", weight: 2, fillColor: "#16a34a", fillOpacity: 1 }).bindTooltip("Start"),
    L.circleMarker(points.at(-1), { radius: 7, color: "#ffffff", weight: 2, fillColor: "#13203A", fillOpacity: 1 }).bindTooltip("Finish"),
  ];
  for (let km = 5; km * 1000 < course.distance_m; km += 5) {
    const i = course.distance.findIndex((d) => d >= km * 1000);
    if (i >= 0) {
      layers.push(L.circleMarker(points[i], { radius: 4, color: "#13203A", fillColor: "#ffffff", fillOpacity: 1, weight: 2 })
        .bindTooltip(`${km} km`));
    }
  }
  routeLayer = L.layerGroup(layers).addTo(map);
  map.fitBounds(route.getBounds(), { padding: [20, 20] });
}

// --- Charts -------------------------------------------------------------------------------------

const charts = {};

function makeChart(id, config) {
  if (charts[id]) charts[id].destroy(); // replace the old chart on a new simulation
  charts[id] = new Chart($(id), config);
}

// Dashed line on the elevation chart at the replay runner's distance
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
          backgroundColor: "rgba(127, 140, 160, 0.2)",
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
        x: {
          type: "linear",
          max: course.distance_m / 1000,
          ticks: { stepSize: 5 },
          grid: { display: false },
          title: { display: true, text: "Distance (km)" },
        },
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
        legend: { labels: { boxWidth: 14 } },
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
        backgroundColor: counts.map((_, i) => (edges[i + 1] <= mc.goal_s ? cssVar("--accent") : cssVar("--chip"))),
        borderRadius: 3,
        barPercentage: 0.92,
        categoryPercentage: 1,
      }],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { grid: { display: false }, title: { display: true, text: "Finish time" } },
        y: { title: { display: true, text: "% of simulated races" } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${fmtTime(edges[items[0].dataIndex])} to ${fmtTime(edges[items[0].dataIndex + 1])}`,
            label: (ctx) => `${ctx.parsed.y.toFixed(1)}% of races`,
          },
        },
      },
    },
  });
}

// --- Splits -------------------------------------------------------------------------------------

let splitSize = 5;

function groupSplits(kmSplits, totalKm, size) {
  // Combine 1 km splits into blocks of `size` km. The last block may be shorter.
  const rows = [];
  let elapsed = 0;
  for (let start = 0; start < kmSplits.length; start += size) {
    const time = kmSplits.slice(start, start + size).reduce((a, b) => a + b, 0);
    const endKm = Math.min(start + size, totalKm);
    elapsed += time;
    rows.push({ startKm: start, endKm, time, pace: time / (endKm - start), elapsed });
  }
  return rows;
}

function renderSplits() {
  if (!lastResult) return;
  const rows = groupSplits(lastResult.optimized.km_splits, lastResult.course.distance_m / 1000, splitSize);
  fillTable(
    $("splits"),
    ["Km", "Split", "Avg pace", "Elapsed"],
    rows.map((r) => [kmLabel(r.endKm), fmtDuration(r.time), fmtPace(r.pace), fmtTime(r.elapsed)]),
  );
    $("band-hint").textContent =
    (splitSize === 1
      ? "Pace band: a detailed wrist strip with every kilometer. "
      : "Pace band: a wrist strip with big, easy-to-read checkpoints. ") +
    "Pace card: a pocket card with terrain notes and your key race tips. " +
    "Print both at 100% scale and cut along the dashed line.";
}

document.querySelectorAll("[data-interval]").forEach((b) => {
  b.addEventListener("click", () => {
    splitSize = Number(b.dataset.interval);
    document.querySelectorAll("[data-interval]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderSplits();
  });
});

// --- Ghost-runner replay ------------------------------------------------------------------------

const replay = {
  course: null, paces: null, cum: null, step: 100, finish: 0, goal: 0,
  t: 0, distance: 0, playing: false, last: null, runner: null, ghost: null,
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

function setPlayButton(playing) {
  $("play").textContent = playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
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
  setPlayButton(false);

  if (replay.runner) replay.runner.remove();
  if (replay.ghost) replay.ghost.remove();
  replay.ghost = L.circleMarker(latLngAt(0), { radius: 7, color: "#ffffff", weight: 2, fillColor: "#8A96AB", fillOpacity: 1 })
    .bindTooltip(`Goal pace (${fmtTime(goalSeconds)})`).addTo(map);
  replay.runner = L.circleMarker(latLngAt(0), { radius: 9, color: "#13203A", weight: 2.5, fillColor: "#FFB000", fillOpacity: 1 })
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

  if (t === 0) {
    $("replay-info").textContent = "Press play to watch your race against goal pace.";
  } else {
    const seg = Math.min(Math.floor(d / step), replay.paces.length - 1);
    const gap = (d / total) * goal - t; // positive = ahead of goal pace
    const gapText = Math.abs(gap) < 1
      ? "on goal pace"
      : `${fmtDuration(Math.abs(gap))} ${gap > 0 ? "ahead of" : "behind"} goal pace`;
    $("replay-info").textContent =
      `${(d / 1000).toFixed(1)} km in ${fmtTime(t)}, running ${fmtPace(replay.paces[seg])}, ${gapText}`;
  }

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
    setPlayButton(false);
    return;
  }
  requestAnimationFrame(tick);
}

$("play").addEventListener("click", () => {
  if (!replay.course) return;
  if (replay.t >= replay.finish) replay.t = 0;
  replay.playing = !replay.playing;
  replay.last = null;
  setPlayButton(replay.playing);
  if (replay.playing) requestAnimationFrame(tick);
});

$("scrub").addEventListener("input", (event) => {
  if (!replay.course) return;
  replay.t = Number(event.target.value);
  updateReplay();
});

// --- Pace band (printable wrist strip) -----------------------------------------------------------

function interpolate(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs.at(-1)) return ys.at(-1);
  let i = 1;
  while (xs[i] < x) i++;
  const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + f * (ys[i] - ys[i - 1]);
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

async function downloadPaceBand() {
  if (!lastResult) return;
  try {
    await document.fonts.load('500 24px "Oxanium"'); // canvas text needs the font loaded first
  } catch {
    // fall back to system fonts
  }

  const { course, optimized, strategies, monte_carlo: mc, insights } = lastResult;
  const totalKm = course.distance_m / 1000;
  const groups = groupSplits(optimized.km_splits, totalKm, splitSize);
  const finish = strategies.find((s) => s.name === "Optimized").finish_s;
  const dense = splitSize === 1;
  const rowCount = dense ? 2 : 1;
  const perRow = Math.ceil(groups.length / rowCount);
  const climb = insights && insights.climb.gain_m >= 3 ? insights.climb : null;

  // Layout (in CSS pixels; drawn at 2x for a sharp print)
  const W = 1000;
  const margin = 12;
  const headW = 150;
  const profH = dense ? 18 : 28;
  const cellH = dense ? 46 : 66;
  const rowH = profH + cellH;
  const H = margin * 2 + rowCount * rowH;
  const scale = 2;

  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  const DISPLAY = '"Oxanium", "Arial Narrow", sans-serif';
  const BODY = '"Work Sans", system-ui, sans-serif';

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Dashed cutting guide
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = "#9AA7BF";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(4, 4, W - 8, H - 8, 14);
  ctx.stroke();
  ctx.setLineDash([]);

  const bandX = margin;
  const bandY = margin;
  const bandH = H - margin * 2;

  // Navy plan block
  ctx.fillStyle = "#13203A";
  ctx.beginPath();
  ctx.roundRect(bandX, bandY, headW, bandH, [10, 0, 0, 10]);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.fillStyle = "#AEB9CC";
  ctx.font = `12px ${BODY}`;
  ctx.fillText(fitText(ctx, course.name, headW - 24), bandX + 12, bandY + 20);
  ctx.font = `11px ${BODY}`;
  ctx.fillText("Plan", bandX + 12, bandY + bandH / 2 - 10);
  ctx.fillText(`Goal ${fmtTime(mc.goal_s)}`, bandX + 12, bandY + bandH - 10);
  ctx.fillStyle = "#FFB000";
  ctx.font = `500 24px ${DISPLAY}`;
  ctx.fillText(fmtTime(finish), bandX + 12, bandY + bandH / 2 + 15);

  // Checkpoint cells, with an elevation strip lined up above them
  const cellsX = bandX + headW;
  const cellW = (W - margin - cellsX) / perRow;
  const minE = Math.min(...course.elevation);
  const maxE = Math.max(...course.elevation);
  const distKm = course.distance.map((d) => d / 1000);

  for (let r = 0; r < rowCount; r++) {
    const rowGroups = groups.slice(r * perRow, (r + 1) * perRow);
    const y0 = bandY + r * rowH;

    // Biggest climb highlight
    rowGroups.forEach((g, j) => {
      if (climb && g.endKm > climb.start_km && g.startKm < climb.end_km) {
        ctx.fillStyle = "rgba(255, 176, 0, 0.22)";
        ctx.fillRect(cellsX + j * cellW, y0, cellW, rowH);
      }
    });

    // Elevation strip: map each distance to its cell, so hills sit above the right checkpoint
    const xFor = (dKm) => {
      let k = rowGroups.findIndex((g) => dKm <= g.endKm);
      if (k < 0) k = rowGroups.length - 1;
      const g = rowGroups[k];
      const frac = (dKm - g.startKm) / (g.endKm - g.startKm);
      return cellsX + (k + Math.min(1, Math.max(0, frac))) * cellW;
    };
    const startKm = rowGroups[0].startKm;
    const endKm = rowGroups.at(-1).endKm;
    ctx.fillStyle = "#D7DDE7";
    ctx.beginPath();
    ctx.moveTo(xFor(startKm), y0 + profH);
    for (let d = startKm; d <= endKm; d += 0.1) {
      const e = interpolate(distKm, course.elevation, d);
      const y = y0 + profH - 2 - ((e - minE) / (maxE - minE || 1)) * (profH - 5);
      ctx.lineTo(xFor(d), y);
    }
    ctx.lineTo(xFor(endKm), y0 + profH);
    ctx.closePath();
    ctx.fill();

    // Cells
    rowGroups.forEach((g, j) => {
      const index = r * perRow + j;
      const isLast = index === groups.length - 1;
      const x = cellsX + j * cellW;
      const cy = y0 + profH;
      const mid = x + cellW / 2;

      if (isLast) {
        ctx.fillStyle = "#13203A";
        ctx.beginPath();
        const lastInBand = r === rowCount - 1 && j === rowGroups.length - 1 && j === perRow - 1;
        ctx.roundRect(x, cy, cellW, cellH, lastInBand ? [0, 0, 10, 0] : 0);
        ctx.fill();
      } else if (dense && g.endKm % 5 === 0) {
        ctx.fillStyle = "#FFF1CC";
        ctx.fillRect(x, cy, cellW, cellH);
      }

      ctx.strokeStyle = "#E1E5EC";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, cy + cellH);
      ctx.stroke();

      ctx.textAlign = "center";
      ctx.fillStyle = isLast ? "#AEB9CC" : "#5A6782";
      ctx.font = `11px ${BODY}`;
      const label = isLast ? (dense ? "Fin" : "Finish") : (dense ? kmLabel(g.endKm) : `${kmLabel(g.endKm)} km`);
      ctx.fillText(label, mid, cy + 14);

      ctx.fillStyle = isLast ? "#FFB000" : "#13203A";
      if (dense) {
        ctx.font = `500 14px ${DISPLAY}`;
        ctx.fillText(fmtClock(g.elapsed), mid, cy + 34);
      } else {
        ctx.font = `500 20px ${DISPLAY}`;
        ctx.fillText(fitText(ctx, fmtTime(g.elapsed), cellW - 6), mid, cy + 40);
        ctx.fillStyle = isLast ? "#AEB9CC" : "#5A6782";
        ctx.font = `11px ${BODY}`;
        ctx.fillText(`${isLast ? "+" : ""}${fmtDuration(g.time)}`, mid, cy + 57);
      }
    });

    if (r > 0) {
      ctx.strokeStyle = "#E1E5EC";
      ctx.beginPath();
      ctx.moveTo(cellsX, y0);
      ctx.lineTo(W - margin, y0);
      ctx.stroke();
    }
  }

  saveCanvas(canvas, `pace-band-${splitSize}km.png`);
}

function saveCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link); // Safari is more reliable when the link is on the page
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function sectionGain(course, startKm, endKm) {
  // Total uphill (m) between two distances
  let gain = 0;
  for (let i = 0; i < course.distance.length - 1; i++) {
    const d = course.distance[i] / 1000;
    if (d >= startKm && d < endKm) gain += Math.max(0, course.elevation[i + 1] - course.elevation[i]);
  }
  return gain;
}

function sectionTerrain(course, g, climb, isLast) {
  if (isLast) return "Finish";
  if (climb && g.endKm > climb.start_km && g.startKm < climb.end_km) return "Biggest climb";
  if (sectionGain(course, g.startKm, g.endKm) >= 8) return "Hilly";
  if (g.startKm >= 30) return "Stay strong";
  return "Steady";
}

async function downloadPaceCard() {
  if (!lastResult) return;
  try {
    await document.fonts.load('500 44px "Oxanium"'); // canvas text needs the font loaded first
  } catch {
    // fall back to system fonts
  }

  const { course, optimized, strategies, monte_carlo: mc, insights } = lastResult;
  const totalKm = course.distance_m / 1000;
  const groups = groupSplits(optimized.km_splits, totalKm, splitSize);
  const finish = strategies.find((s) => s.name === "Optimized").finish_s;
  const climb = insights && insights.climb.gain_m >= 3 ? insights.climb : null;
  const DISPLAY = '"Oxanium", "Arial Narrow", sans-serif';
  const BODY = '"Work Sans", system-ui, sans-serif';

  // Layout (CSS pixels; drawn at 3x for a sharp print)
  const W = 360;
  const pad = 16;
  const cardW = W - pad * 2;
  const headerH = 132;
  const colH = 28;
  const rowH = 26;

  // Measure the tips first so the card is exactly as tall as it needs to be
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `13px ${BODY}`;
  const tips = lastTakeaways.slice(0, 2).map(([, title]) => wrapLines(measure, title, cardW - 18));
  const tipsH = tips.reduce((h, lines) => h + lines.length * 18 + 6, 0);
  const H = pad + headerH + colH + groups.length * rowH + 16 + tipsH + 34;
  const scale = 3;

  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Dashed cutting guide
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = "#9AA7BF";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(4, 4, W - 8, H - 8, 14);
  ctx.stroke();
  ctx.setLineDash([]);

  // Navy gantry header
  ctx.fillStyle = "#13203A";
  ctx.beginPath();
  ctx.roundRect(pad, pad, cardW, headerH, [12, 12, 0, 0]);
  ctx.fill();

  ctx.font = `11px ${BODY}`;
  ctx.fillStyle = "#AEB9CC";
  ctx.textAlign = "left";
  ctx.fillText(fitText(ctx, course.name, cardW - 130), pad + 12, pad + 20);
  ctx.textAlign = "right";
  ctx.fillText("Optimized plan", pad + cardW - 12, pad + 20);

  // Clock screen with unlit segments behind the digits
  const screenY = pad + 30;
  ctx.fillStyle = "#0A1222";
  ctx.beginPath();
  ctx.roundRect(pad + 12, screenY, cardW - 24, 64, 8);
  ctx.fill();
  const timeText = fmtTime(finish);
  ctx.textAlign = "center";
  ctx.font = `500 44px ${DISPLAY}`;
  ctx.fillStyle = "#1A2338";
  ctx.fillText(timeText.replace(/\d/g, "8"), W / 2, screenY + 48);
  ctx.fillStyle = "#FFB000";
  ctx.fillText(timeText, W / 2, screenY + 48);

  ctx.font = `11px ${BODY}`;
  ctx.fillStyle = "#AEB9CC";
  ctx.textAlign = "left";
  ctx.fillText(`Goal ${fmtTime(mc.goal_s)}`, pad + 12, pad + headerH - 14);
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(mc.p_goal * 100)}% chance`, pad + cardW - 12, pad + headerH - 14);

  // Column headers
  let y = pad + headerH;
  const colKm = pad + 12;
  const colSplit = pad + 72;
  const colElapsed = pad + 142;
  const colTerrain = pad + cardW - 12;
  ctx.fillStyle = "#F1F4F9";
  ctx.fillRect(pad, y, cardW, colH);
  ctx.font = `11px ${BODY}`;
  ctx.fillStyle = "#5A6782";
  ctx.textAlign = "left";
  ctx.fillText("Km", colKm, y + 18);
  ctx.fillText("Split", colSplit, y + 18);
  ctx.fillText("Elapsed", colElapsed, y + 18);
  ctx.textAlign = "right";
  ctx.fillText("Terrain", colTerrain, y + 18);
  y += colH;

  // Checkpoint rows
  groups.forEach((g, i) => {
    const isLast = i === groups.length - 1;
    const terrain = sectionTerrain(course, g, climb, isLast);

    if (isLast) {
      ctx.fillStyle = "#13203A";
      ctx.fillRect(pad, y, cardW, rowH);
    } else if (terrain === "Biggest climb") {
      ctx.fillStyle = "#FFF1CC";
      ctx.fillRect(pad, y, cardW, rowH);
    }
    ctx.strokeStyle = "#E1E5EC";
    ctx.beginPath();
    ctx.moveTo(pad, y + rowH);
    ctx.lineTo(pad + cardW, y + rowH);
    ctx.stroke();

    const base = y + 17;
    ctx.textAlign = "left";
    ctx.fillStyle = isLast ? "#E8EDF5" : "#13203A";
    ctx.font = `500 13px ${DISPLAY}`;
    ctx.fillText(kmLabel(g.endKm), colKm, base);
    ctx.font = `13px ${BODY}`;
    ctx.fillStyle = isLast ? "#AEB9CC" : "#13203A";
    ctx.fillText(fmtDuration(g.time), colSplit, base);
    ctx.font = `500 14px ${DISPLAY}`;
    ctx.fillStyle = isLast ? "#FFB000" : "#13203A";
    ctx.fillText(fmtTime(g.elapsed), colElapsed, base);
    ctx.textAlign = "right";
    ctx.font = `11px ${BODY}`;
    ctx.fillStyle = isLast ? "#AEB9CC" : "#5A6782";
    ctx.fillText(terrain, colTerrain, base);
    y += rowH;
  });

  // Table outline
  ctx.strokeStyle = "#D3D9E4";
  ctx.strokeRect(pad + 0.5, pad + headerH, cardW - 1, y - (pad + headerH));

  // Race tips (the first two takeaways)
  y += 16;
  ctx.textAlign = "left";
  ctx.font = `13px ${BODY}`;
  tips.forEach((lines) => {
    ctx.fillStyle = "#FFB000";
    ctx.beginPath();
    ctx.arc(pad + 6, y + 8, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#13203A";
    lines.forEach((line, k) => ctx.fillText(line, pad + 18, y + 13 + k * 18));
    y += lines.length * 18 + 6;
  });

  ctx.textAlign = "center";
  ctx.font = `10px ${BODY}`;
  ctx.fillStyle = "#9AA7BF";
  ctx.fillText("Race Day Simulator", W / 2, H - 16);

  saveCanvas(canvas, `pace-card-${splitSize}km.png`);
}
$("download-band").addEventListener("click", downloadPaceBand);
$("download-card").addEventListener("click", downloadPaceCard);

// --- Start ---------------------------------------------------------------------------------------

loadCourses().catch(() => {
  setStatus("Couldn't load the course list. Check that the server is running.", true);
});