from dataclasses import dataclass

import numpy as np

from engine.models import fatigue_factor, grade_factor, heat_factor
from engine.pacing import STRAIN_WEIGHT


@dataclass
class Uncertainty:
    """How much each race-day factor varies between simulated races.
    These are modeling assumptions, not measured values."""
    fitness_sd: float = 0.02     # true fitness vs. prediction (2%)
    form_sd: float = 0.015       # good day / bad day (1.5%)
    temp_sd: float = 2.0         # forecast error in temperature (°C)
    dew_sd: float = 2.0          # forecast error in dew point (°C)
    drift_median: float = 0.03   # typical late-race slowdown (3%)
    drift_spread: float = 0.5    # log-normal spread: occasionally "hitting the wall"


def simulate_many(course, base_paces, effort, temps, dews, drifts,
                  onset=0.7, strain_weight=STRAIN_WEIGHT):
    """Vectorized version of pacing.simulate.

    Simulates many races at once. Returns paces (s/km) with one row per race
    and one column per segment.
    """
    g = grade_factor(course.grade)
    total = course.total_distance
    # Shape of the fatigue curve (0 before onset, rising to 1 at the finish)
    curve = fatigue_factor(course.distance, total, onset, drift=1.0) - 1
    # Strain depends only on the effort plan, so it is the same for every race.
    # Each segment sees the strain built up by the segments before it.
    excess = np.maximum(0.0, effort - 1) * course.step / total
    strain = np.concatenate([[0.0], np.cumsum(excess)[:-1]])

    heat = heat_factor(temps, dews)
    late = drifts[:, None] * curve[None, :] * (1 + strain_weight * strain[None, :])
    return base_paces[:, None] / effort[None, :] * g[None, :] * heat[:, None] * (1 + late)


def run_monte_carlo(course, base_pace, effort, temp_c=12, dew_c=5, n=5000,
                    uncertainty=None, seed=None, onset=0.7):
    """Simulate `n` races with random race-day conditions. Returns finish times (s)."""
    u = uncertainty or Uncertainty()
    rng = np.random.default_rng(seed)

    base = base_pace * rng.normal(1, u.fitness_sd, n) * rng.normal(1, u.form_sd, n)
    temps = rng.normal(temp_c, u.temp_sd, n)
    dews = np.minimum(rng.normal(dew_c, u.dew_sd, n), temps)  # dew point can't exceed temperature
    drifts = u.drift_median * np.exp(rng.normal(0, u.drift_spread, n))

    paces = simulate_many(course, base, effort, temps, dews, drifts, onset)
    return paces.sum(axis=1) * course.step / 1000


def summarize(times, goal=None):
    """Key statistics of simulated finish times (s)."""
    summary = {
        "p10": float(np.percentile(times, 10)),
        "median": float(np.median(times)),
        "p90": float(np.percentile(times, 90)),
    }
    if goal is not None:
        summary["p_goal"] = float(np.mean(times < goal))
    return summary


def text_histogram(times, bin_minutes=2, width=40):
    """Simple text histogram of finish times, for the terminal."""
    from engine.fitness import format_time

    size = bin_minutes * 60
    edges = np.arange(np.floor(times.min() / size) * size, times.max() + size, size)
    counts, _ = np.histogram(times, edges)
    lines = []
    for lo, c in zip(edges, counts):
        bar = "#" * int(round(c / counts.max() * width))
        lines.append(f"  {format_time(lo)}  {bar:<{width}} {c / len(times) * 100:4.1f}%")
    return "\n".join(lines)


if __name__ == "__main__":
    from pathlib import Path

    from engine.course import build_course
    from engine.fitness import collect_best_efforts, fit_riegel_exponent, format_time, predict_time
    from engine.pacing import compare_strategies, effort_profile

    course = build_course("sample_data/osaka.gpx", official_distance=42195)

    # Fitness: from training runs if available, otherwise assume a 4:00 runner
    runs_dir = Path("sample_data/runs")
    runs = [p for p in runs_dir.iterdir() if p.is_file() and not p.name.startswith(".")] if runs_dir.exists() else []
    efforts, _ = collect_best_efforts(runs)
    if efforts:
        predicted = predict_time(efforts, 42195, fit_riegel_exponent(efforts))
        print(f"Fitness from {len(runs)} runs: predicted marathon {format_time(predicted)}")
    else:
        predicted = 4 * 3600
        print("No training runs found: assuming 4:00:00 fitness")
    base = predicted / 42.195

    # Pacing plan: the optimized strategy
    _, best = compare_strategies(course, base)
    effort = effort_profile(course, best["hill_response"], best["split"])

    goal = 4 * 3600
    for label, temp, dew in [("Cool (12°C)", 12, 5), ("Warm (22°C)", 22, 16)]:
        times = run_monte_carlo(course, base, effort, temp, dew, n=5000, seed=42)
        s = summarize(times, goal)
        print(f"\n{label}: 5000 simulated races")
        print(f"  Median finish:   {format_time(s['median'])}")
        print(f"  80% of races:    {format_time(s['p10'])} - {format_time(s['p90'])}")
        print(f"  Chance of sub-{format_time(goal)}: {s['p_goal'] * 100:.0f}%")
        print(text_histogram(times))