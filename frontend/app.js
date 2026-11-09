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

  $("results").hidden = false;
  $("results").scrollIntoView({ behavior: "smooth" });
}

loadCourses().catch(() => {
  $("status").textContent = "Could not load courses. Is the server running?";
});