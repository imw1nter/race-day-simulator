import numpy as np

from engine.course import Course
from engine.models import finish_time
from engine.montecarlo import Uncertainty, run_monte_carlo, simulate_many, summarize
from engine.pacing import effort_profile, simulate

BASE = 340.0  # s/km
NO_RANDOMNESS = Uncertainty(fitness_sd=0, form_sd=0, temp_sd=0, dew_sd=0, drift_spread=0)


def make_course(km=42, step=100.0):
    d = np.arange(0, km * 1000, step)
    elev = 40 * np.sin(d / 1000)
    grade = np.diff(elev, append=elev[-1]) / step
    return Course(distance=d, elevation=elev, grade=grade, step=step)


def test_vectorized_matches_single_simulation():
    course = make_course()
    effort = effort_profile(course, 0.5, 0.03)  # uneven plan, so strain is tested too
    single = simulate(course, BASE, effort, temp_c=20, dew_c=15)
    many = simulate_many(course, np.array([BASE]), effort,
                         np.array([20.0]), np.array([15.0]), np.array([0.03]))
    assert np.allclose(many[0], single)


def test_no_randomness_gives_identical_races():
    course = make_course()
    effort = effort_profile(course, 1, 0)
    times = run_monte_carlo(course, BASE, effort, n=100, uncertainty=NO_RANDOMNESS)
    expected = finish_time(course, simulate(course, BASE, effort))
    assert np.allclose(times, expected)


def test_same_seed_gives_same_results():
    course = make_course(km=10)
    effort = effort_profile(course, 1, 0)
    a = run_monte_carlo(course, BASE, effort, n=200, seed=7)
    b = run_monte_carlo(course, BASE, effort, n=200, seed=7)
    assert np.array_equal(a, b)


def test_hotter_race_is_slower():
    course = make_course(km=10)
    effort = effort_profile(course, 1, 0)
    cool = run_monte_carlo(course, BASE, effort, temp_c=12, dew_c=5, n=500, seed=1)
    hot = run_monte_carlo(course, BASE, effort, temp_c=28, dew_c=22, n=500, seed=1)
    assert np.median(hot) > np.median(cool)


def test_goal_probability():
    times = np.array([3500.0, 3600.0, 3700.0])
    assert np.isclose(summarize(times, goal=3650)["p_goal"], 2 / 3)