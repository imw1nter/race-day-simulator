import numpy as np

from engine.models import fatigue_factor, finish_time, grade_factor, heat_factor
from dataclasses import replace

STRAIN_WEIGHT = 40.0  # modeling assumption: how much over-exertion worsens late fatigue


def effort_profile(course, hill_response, split):
    """Planned effort for each segment (1.0 = sustainable effort).

    hill_response: 0 = even pace, 1 = even effort.
    split: > 0 means effort rises during the race (negative split).
    The profile is scaled so its average is exactly 1.0.
    """
    g = grade_factor(course.grade)
    x = course.distance / course.total_distance
    effort = g ** (1 - hill_response) * (1 + split * (x - 0.5))
    return effort / effort.mean()


def simulate(course, base_pace, effort, temp_c=12, dew_c=5,
             onset=0.7, drift=0.03, strain_weight=STRAIN_WEIGHT):
    """Run the race segment by segment. Returns pace (s/km) for each segment."""
    g = grade_factor(course.grade)
    heat = heat_factor(temp_c, dew_c)
    total = course.total_distance
    paces = np.empty(len(course.distance))
    strain = 0.0

    for i, d in enumerate(course.distance):
        base_drift = fatigue_factor(d, total, onset, drift) - 1
        late_drift = base_drift * (1 + strain_weight * strain)
        paces[i] = base_pace / effort[i] * g[i] * heat * (1 + late_drift)
        # Running above sustainable effort builds strain for later segments
        strain += max(0.0, effort[i] - 1) * course.step / total

    return paces


def compare_strategies(course, base_pace, **conditions):
    """Simulate even pace, even effort, and the best strategy found by search."""
    results = {
        "Even pace": simulate(course, base_pace, effort_profile(course, 0, 0), **conditions),
        "Even effort": simulate(course, base_pace, effort_profile(course, 1, 0), **conditions),
    }

    best = None
    for h in np.linspace(0, 1.5, 16):        # hill response 0.0, 0.1, ..., 1.5
        for s in np.linspace(-0.06, 0.06, 13):  # split -6% ... +6%
            paces = simulate(course, base_pace, effort_profile(course, h, s), **conditions)
            t = finish_time(course, paces)
            if best is None or t < best["time"]:
                best = {"time": t, "hill_response": h, "split": s, "paces": paces}

    results["Optimized"] = best["paces"]
    return results, best

def time_breakdown(course, base_pace, effort, temp_c=12, dew_c=5):
    """Split the planned finish time into what each factor adds.

    Factors are added one at a time (flat and cool with no fatigue, then hills,
    then heat, then late-race fatigue), so the parts add up exactly to the
    planned finish. Returns whole seconds.
    """
    flat = replace(course, grade=np.zeros_like(course.grade))
    cool = {"temp_c": 0.0, "dew_c": 0.0}  # cold enough that the heat model adds nothing

    t_base = finish_time(course, simulate(flat, base_pace, effort, drift=0, **cool))
    t_hills = finish_time(course, simulate(course, base_pace, effort, drift=0, **cool))
    t_heat = finish_time(course, simulate(course, base_pace, effort, temp_c, dew_c, drift=0))
    t_full = finish_time(course, simulate(course, base_pace, effort, temp_c, dew_c))

    # Round the running totals, not the parts, so the parts still add up exactly
    t = [round(x) for x in (t_base, t_hills, t_heat, t_full)]
    return {
        "flat_fitness_s": t[0],
        "hills_s": t[1] - t[0],
        "heat_s": t[2] - t[1],
        "fatigue_s": t[3] - t[2],
        "planned_s": t[3],
    }

def half_splits(course, paces):
    """Time (s) for the first and second half of the race."""
    seg_times = paces * course.step / 1000
    first = course.distance < course.total_distance / 2
    return seg_times[first].sum(), seg_times[~first].sum()


def km_splits(course, paces):
    """Time (s) for each kilometre."""
    seg_times = paces * course.step / 1000
    km = (course.distance // 1000).astype(int)
    return np.bincount(km, weights=seg_times)


if __name__ == "__main__":
    from engine.course import build_course
    from engine.fitness import format_time

    course = build_course("sample_data/osaka.gpx", official_distance=42195)
    base = 4 * 3600 / 42.195  # sustainable flat pace for a 4:00 effort

    results, best = compare_strategies(course, base, temp_c=12, dew_c=5)

    print(f"{'Strategy':<12} {'Finish':>8} {'1st half':>9} {'2nd half':>9}")
    for name, paces in results.items():
        first, second = half_splits(course, paces)
        print(f"{name:<12} {format_time(finish_time(course, paces)):>8} "
              f"{format_time(first):>9} {format_time(second):>9}")

    print(f"\nOptimized settings: hill response {best['hill_response']:.1f}, "
          f"split {best['split'] * 100:+.0f}%")
    print("Optimized splits every 5 km:")
    splits = np.cumsum(km_splits(course, best["paces"]))
    for km in range(5, 45, 5):
        if km <= len(splits):
            print(f"  {km:>2} km: {format_time(splits[km - 1])}")