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

// --- Form --------------------------------------------------------------------

function buildFormData() {
  const fd = new FormData();
  fd.append("course_id", $("course_id").value);

  const courseFile = $("course_file").files[0];
  if (courseFile) fd.append("course_file", courseFile);
  if ($("course_distance_km").value) fd.append("course_distance_km", $("course_distance_km").value);

  for (const file of $("runs").files) fd.append("runs", file);
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
  $("fitness-source").textContent = data.fitness.source === "manual"
    ? "Using the fitness time you entered."
    : `Estimated from your training runs (fatigue exponent ${data.fitness.exponent}).`;
  fillList($("efforts"), data.fitness.best_efforts.map(
    (e) => `Best ${(e.distance_m / 1000).toFixed(1)} km: ${e.time_text}`,
  ));
  fillList($("skipped"), data.fitness.skipped.map((s) => `Skipped ${s.file}: ${s.reason}`));

  // Kilometre splits (the last one is usually a partial kilometre)
  const totalKm = data.course.distance_m / 1000;
  const splits = opt.km_splits;
  let elapsed = 0;
  const rows = splits.map((t, i) => {
    const length = i < splits.length - 1 ? 1 : totalKm - (splits.length - 1);
    elapsed += t;
    const label = i < splits.length - 1 ? `${i + 1}` : totalKm.toFixed(1);
    return [label, fmtPace(t / length), fmtTime(elapsed)];
  });
  fillTable($("splits"), ["Km", "Pace", "Elapsed"], rows);

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
  $("results").scrollIntoView({ behavior: "smooth" });
}

loadCourses().catch(() => {
  $("status").textContent = "Could not load courses. Is the server running?";
});