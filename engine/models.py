import numpy as np

# --- Hills -------------------------------------------------------------
# Energy cost of running (J/kg/m) at gradient i, from:
# Minetti et al. (2002), "Energy cost of walking and running at extreme
# uphill and downhill slopes", Journal of Applied Physiology 93:1039-1046.
FLAT_COST = 3.6
DOWNHILL_BENEFIT = 0.5  # runners get only part of the theoretical downhill gain


def minetti_cost(grade):
    i = np.clip(grade, -0.45, 0.45)  # range covered by the study
    return 155.4 * i**5 - 30.4 * i**4 - 43.3 * i**3 + 46.3 * i**2 + 19.5 * i + 3.6


def grade_factor(grade):
    """Pace multiplier for a slope (0.05 = 5% uphill)."""
    ratio = minetti_cost(grade) / FLAT_COST
    return np.where(ratio < 1, 1 - (1 - ratio) * DOWNHILL_BENEFIT, ratio)


# --- Heat --------------------------------------------------------------
# Runner's rule of thumb: temperature + dew point (both in °F) -> slowdown %.
# A heuristic, not a peer-reviewed model.
HEAT_SUM_F = [100, 110, 120, 130, 140, 150, 160, 170, 180]
HEAT_PCT = [0, 0.5, 1, 2, 3, 4.5, 6, 8, 10]


def heat_factor(temp_c, dew_c):
    """Pace multiplier for air temperature and dew point (°C)."""
    combined_f = (temp_c * 9 / 5 + 32) + (dew_c * 9 / 5 + 32)
    return 1 + np.interp(combined_f, HEAT_SUM_F, HEAT_PCT) / 100


# --- Fatigue -----------------------------------------------------------
def fatigue_factor(distance, total, onset=0.7, drift=0.03):
    """Pace multiplier that rises after `onset` (fraction of the race),
    reaching 1 + drift at the finish."""
    frac = np.asarray(distance) / total
    x = np.clip((frac - onset) / (1 - onset), 0, 1)
    return 1 + drift * x**2


# --- Combined ----------------------------------------------------------
def segment_paces(course, base_pace, temp_c=12, dew_c=5, onset=0.7, drift=0.03):
    """Pace (s/km) for every segment of the course."""
    return (
        base_pace
        * grade_factor(course.grade)
        * heat_factor(temp_c, dew_c)
        * fatigue_factor(course.distance, course.total_distance, onset, drift)
    )


def finish_time(course, paces):
    """Total time (s) from per-segment paces."""
    return float(np.sum(paces * course.step / 1000))


if __name__ == "__main__":
    from engine.course import build_course
    from engine.fitness import format_time

    course = build_course("sample_data/osaka.gpx")
    base = 4 * 3600 / 42.195  # even pace for a 4:00 marathon on flat ground

    for label, temp, dew in [("Cool (12°C)", 12, 5), ("Mild (18°C)", 18, 12), ("Hot (26°C)", 26, 20)]:
        paces = segment_paces(course, base, temp, dew)
        print(f"{label:<12} finish: {format_time(finish_time(course, paces))}")