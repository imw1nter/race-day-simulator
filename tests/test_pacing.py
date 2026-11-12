import numpy as np

from engine.course import Course
from engine.models import finish_time
from engine.pacing import compare_strategies, effort_profile, simulate

BASE = 340.0  # s/km


def make_course(hilly=True, km=42, step=100.0):
    d = np.arange(0, km * 1000, step)
    elev = 40 * np.sin(d / 1000) if hilly else np.zeros_like(d)
    grade = np.diff(elev, append=elev[-1]) / step
    return Course(distance=d, elevation=elev, grade=grade, step=step)


def test_effort_profile_averages_to_one():
    course = make_course()
    assert np.isclose(effort_profile(course, 0.5, 0.03).mean(), 1.0)


def test_flat_course_even_pace_equals_even_effort():
    course = make_course(hilly=False)
    a = finish_time(course, simulate(course, BASE, effort_profile(course, 0, 0)))
    b = finish_time(course, simulate(course, BASE, effort_profile(course, 1, 0)))
    assert np.isclose(a, b)


def test_hilly_course_even_effort_beats_even_pace():
    course = make_course()
    even_pace = finish_time(course, simulate(course, BASE, effort_profile(course, 0, 0)))
    even_effort = finish_time(course, simulate(course, BASE, effort_profile(course, 1, 0)))
    assert even_effort < even_pace


def test_fast_start_is_slower_than_even():
    course = make_course(hilly=False)
    even = finish_time(course, simulate(course, BASE, effort_profile(course, 1, 0)))
    fast_start = finish_time(course, simulate(course, BASE, effort_profile(course, 1, -0.05)))
    assert fast_start > even


def test_optimized_is_never_worse():
    course = make_course(km=10)
    results, best = compare_strategies(course, BASE)
    for name in ("Even pace", "Even effort"):
        assert best["time"] <= finish_time(course, results[name]) + 1e-6

def test_breakdown_adds_up():
    course = make_course()
    effort = effort_profile(course, 1, 0)
    b = time_breakdown(course, BASE, effort, temp_c=25, dew_c=18)
    assert b["flat_fitness_s"] + b["hills_s"] + b["heat_s"] + b["fatigue_s"] == b["planned_s"]
    assert b["heat_s"] > 0
    assert b["fatigue_s"] > 0


def test_breakdown_flat_and_cool_course():
    course = make_course(hilly=False)
    effort = effort_profile(course, 1, 0)
    b = time_breakdown(course, BASE, effort, temp_c=10, dew_c=2)
    assert b["hills_s"] == 0
    assert b["heat_s"] == 0