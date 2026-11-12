import json
import tempfile
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles

from engine.course import build_course
from engine.fitness import collect_best_efforts, fit_riegel_exponent, format_time, merge_efforts, predict_time
from engine.models import finish_time, heat_factor
from engine.montecarlo import run_monte_carlo, summarize
from engine.pacing import compare_strategies, effort_profile, half_splits, km_splits, time_breakdown

ROOT = Path(__file__).resolve().parent.parent
COURSES = {
    "osaka": {"name": "Osaka Marathon", "file": ROOT / "sample_data" / "osaka.gpx", "distance": 42195},
    "seoul": {"name": "Seoul Marathon", "file": ROOT / "sample_data" / "Seoul_marathon.gpx", "distance": 42195},
    "JTBC seoul": {"name": "JTBC Seoul Marathon", "file": ROOT / "sample_data" / "JTBC_Seoul_marathon.gpx", "distance": 42195},
    "chuncheon": {"name": "Chuncheon Marathon", "file": ROOT / "sample_data" / "Chuncheon_marathon.gpx", "distance": 42195},
    "gyeongju": {"name": "Gyeongju Marathon", "file": ROOT / "sample_data" / "gyeongju_marathon.gpx", "distance": 42195},
    "gongju": {"name": "Gongju Marathon", "file": ROOT / "sample_data" / "gongju_marathon.gpx", "distance": 42195}
    
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

MAX_SPEED = 8.0  # m/s (~2:05/km): faster than any world record pace for these distances


def parse_records(text):
    """Parse personal records sent as JSON: [{"distance_km": 5, "time": "21:47"}, ...].
    Returns a dict of distance (m) -> time (s). Raises ValueError if invalid."""
    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("personal records must be valid JSON")
    if not isinstance(items, list) or len(items) > 20:
        raise ValueError("personal records must be a list of at most 20 items")

    records = {}
    for item in items:
        try:
            distance = round(float(item["distance_km"]) * 1000, 1)
            seconds = parse_time(str(item["time"]))
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"invalid personal record: {item}")
        if not 800 <= distance <= 50000:
            raise ValueError("personal record distances must be between 0.8 and 50 km")
        if distance / seconds > MAX_SPEED:
            raise ValueError(f"{item['time']} for {distance / 1000:g} km is unrealistically fast")
        records[distance] = min(seconds, records.get(distance, seconds))
    return records


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

def build_insights(course, best_paces, effort, base_pace, temp_c, dew_c, goal, simulations):
    """Plain-language facts for the results page: the biggest climb and the effect of weather."""
    # Biggest climb: the 3 km stretch with the most elevation gain
    km_index = (course.distance // 1000).astype(int)
    gain = np.clip(np.diff(course.elevation, append=course.elevation[-1]), 0, None)
    gain_per_km = np.bincount(km_index, weights=gain)
    window = min(3, len(gain_per_km))
    sums = np.convolve(gain_per_km, np.ones(window), mode="valid")
    start = int(np.argmax(sums))
    splits = km_splits(course, best_paces)
    climb = {
        "start_km": start,
        "end_km": start + window,
        "gain_m": round(float(sums[start]), 1),
        "slowest_pace_s": round(float(np.max(splits[start:start + window]))),
    }

    # Weather: compare with a warm day if it's cool, or with a cool day if it's warm
    hot = bool(heat_factor(temp_c, dew_c) > 1.0)
    compare_temp, compare_dew = (12.0, 5.0) if hot else (22.0, 16.0)
    compare_times = run_monte_carlo(course, base_pace, effort, compare_temp, compare_dew, n=simulations, seed=1)
    compare = summarize(compare_times, goal)
    weather = {
        "hot": hot,
        "compare_temp_c": compare_temp,
        "compare_dew_c": compare_dew,
        "compare_median_s": round(compare["median"]),
        "compare_p_goal": round(compare["p_goal"], 3),
    }
    return {"climb": climb, "weather": weather}

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
    records: Optional[str] = Form(None, description='Personal records as JSON, e.g [{"distance_km": 5, "time": "21:47"}]'),
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
        records_efforts = parse_records(records) if records else {}
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
        run_efforts, skipped = collect_best_efforts(run_paths)
        efforts, sources = merge_efforts(run_efforts, records_efforts)
        exponent = None
        if manual_fitness:
            predicted, source = manual_fitness, "manual"
        elif efforts:
            exponent = fit_riegel_exponent(efforts)
            predicted, source = predict_time(efforts, course.total_distance, exponent), "runs"
            kinds = set(sources.values())
            source = "runs+records" if len(kinds) == 2 else ("records" if kinds == {"record"} else "runs")
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
    times = run_monte_carlo(course, base_pace, effort, temp_c, dew_c, n=simulations, seed=1)
    stats = summarize(times, goal)
    insights = build_insights(course, best["paces"], effort, base_pace, temp_c, dew_c, goal, simulations)
    breakdown = time_breakdown(course, base_pace, effort, temp_c, dew_c)
    breakdown["temp_c"] = temp_c
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
                {"distance_m": d, "time_s": round(t), "time_text": format_time(t), "source": sources[d]}
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
        "insights": insights,
    }


# Serve the web page from the frontend folder (registered last so /api routes win)
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")