import tempfile
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles

from engine.course import build_course
from engine.fitness import collect_best_efforts, fit_riegel_exponent, format_time, predict_time
from engine.models import finish_time
from engine.montecarlo import run_monte_carlo, summarize
from engine.pacing import compare_strategies, effort_profile, half_splits, km_splits

ROOT = Path(__file__).resolve().parent.parent
COURSES = {
    "osaka": {"name": "Osaka Marathon", "file": ROOT / "sample_data" / "osaka.gpx", "distance": 42195},
}
MAX_FILES = 30
MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB

app = FastAPI(title="Race Day Simulator", description="Data-driven marathon pacing engine")


# --- Helpers -------------------------------------------------------------------

def parse_time(text):
    """'4:00:00' or '25:30' -> seconds. Raises ValueError if invalid."""
    parts = text.strip().split(":")
    if not 2 <= len(parts) <= 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f"invalid time '{text}' (use h:mm:ss)")
    nums = [int(p) for p in parts]
    if len(nums) == 2:
        nums = [0] + nums
    h, m, s = nums
    if m >= 60 or s >= 60 or h * 3600 + m * 60 + s <= 0:
        raise ValueError(f"invalid time '{text}' (use h:mm:ss)")
    return h * 3600 + m * 60 + s


def save_upload(upload, folder, index):
    """Save an uploaded file into its own subfolder, keeping its original name."""
    data = upload.file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, f"{upload.filename} is larger than 20 MB")
    sub = folder / str(index)
    sub.mkdir()
    path = sub / Path(upload.filename or "upload").name  # .name blocks paths like ../../x
    path.write_bytes(data)
    return path


def rounded(values, digits=1):
    return [round(float(v), digits) for v in values]


# --- Endpoints -----------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/courses")
def list_courses():
    return [{"id": cid, "name": c["name"], "distance_m": c["distance"]} for cid, c in COURSES.items()]


@app.post("/api/simulate")
def simulate_race(
    course_id: str = Form("osaka", description="Built-in course id (ignored if course_file is given)"),
    course_file: Optional[UploadFile] = File(None, description="Your own course as GPX"),
    course_distance_km: Optional[float] = Form(None, description="Official distance of an uploaded course"),
    runs: Optional[List[UploadFile]] = File(None, description="Training runs (GPX, FIT, TCX)"),
    fitness_time: Optional[str] = Form(None, description="Manual fitness: your current time for this distance, e.g. 3:55:00"),
    goal_time: str = Form("4:00:00", description="Goal finish time"),
    temp_c: float = Form(12.0, description="Race temperature (°C)"),
    dew_c: float = Form(5.0, description="Race dew point (°C)"),
    simulations: int = Form(2000, description="Number of Monte Carlo races (100-10000)"),
):
    # Validate simple inputs first
    try:
        goal = parse_time(goal_time)
        manual_fitness = parse_time(fitness_time) if fitness_time else None
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not -10 <= temp_c <= 45:
        raise HTTPException(400, "temperature must be between -10 and 45 °C")
    if dew_c > temp_c:
        raise HTTPException(400, "dew point can't be higher than the temperature")
    runs = runs or []
    if len(runs) > MAX_FILES:
        raise HTTPException(400, f"upload at most {MAX_FILES} runs")
    simulations = int(np.clip(simulations, 100, 10000))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # Course
        if course_file is not None:
            course_path = save_upload(course_file, tmp, "course")
            official = course_distance_km * 1000 if course_distance_km else None
            course_name = Path(course_file.filename or "Uploaded course").stem
        elif course_id in COURSES:
            course_path = COURSES[course_id]["file"]
            official = COURSES[course_id]["distance"]
            course_name = COURSES[course_id]["name"]
        else:
            raise HTTPException(404, f"unknown course '{course_id}'")
        try:
            course = build_course(course_path, official_distance=official)
        except Exception:
            raise HTTPException(400, "could not read the course file (is it a valid GPX?)")

        # Fitness: manual time takes priority, otherwise training runs
        run_paths = [save_upload(u, tmp, i) for i, u in enumerate(runs)]
        efforts, skipped = collect_best_efforts(run_paths)
        exponent = None
        if manual_fitness:
            predicted, source = manual_fitness, "manual"
        elif efforts:
            exponent = fit_riegel_exponent(efforts)
            predicted, source = predict_time(efforts, course.total_distance, exponent), "runs"
        else:
            detail = "provide fitness_time or at least one usable training run"
            if skipped:
                detail += ". Skipped: " + "; ".join(f"{n}: {r}" for n, r in skipped)
            raise HTTPException(400, detail)

    # Simulation (files are no longer needed from here on)
    base_pace = predicted / (course.total_distance / 1000)
    conditions = {"temp_c": temp_c, "dew_c": dew_c}
    strategies, best = compare_strategies(course, base_pace, **conditions)
    effort = effort_profile(course, best["hill_response"], best["split"])
    times = run_monte_carlo(course, base_pace, effort, temp_c, dew_c, n=simulations)
    stats = summarize(times, goal)
    counts, edges = np.histogram(times, bins=30)

    return {
        "course": {
            "name": course_name,
            "distance_m": round(course.total_distance),
            "total_climb_m": round(float(course.total_climb)),
            "distance": rounded(course.distance, 0),
            "elevation": rounded(course.elevation),
            "lat": rounded(course.lat, 6),
            "lon": rounded(course.lon, 6),
        },
        "fitness": {
            "source": source,
            "predicted_s": round(predicted),
            "predicted_text": format_time(predicted),
            "exponent": round(exponent, 3) if exponent else None,
            "best_efforts": [
                {"distance_m": d, "time_s": round(t), "time_text": format_time(t)}
                for d, t in sorted(efforts.items())
            ],
            "skipped": [{"file": n, "reason": r} for n, r in skipped],
        },
        "strategies": [
            {
                "name": name,
                "finish_s": round(finish_time(course, paces)),
                "finish_text": format_time(finish_time(course, paces)),
                "first_half_s": round(half_splits(course, paces)[0]),
                "second_half_s": round(half_splits(course, paces)[1]),
            }
            for name, paces in strategies.items()
        ],
        "optimized": {
            "hill_response": round(float(best["hill_response"]), 2),
            "split": round(float(best["split"]), 3),
            "segment_paces": rounded(best["paces"]),
            "km_splits": rounded(km_splits(course, best["paces"])),
        },
        "monte_carlo": {
            "simulations": simulations,
            "goal_s": goal,
            "p_goal": round(stats["p_goal"], 3),
            "median_s": round(stats["median"]),
            "p10_s": round(stats["p10"]),
            "p90_s": round(stats["p90"]),
            "median_text": format_time(stats["median"]),
            "range_text": f"{format_time(stats['p10'])} - {format_time(stats['p90'])}",
            "histogram": {"edges": rounded(edges, 0), "counts": counts.tolist()},
        },
    }


# Serve the web page from the frontend folder (registered last so /api routes win)
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")