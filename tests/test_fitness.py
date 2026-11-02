import numpy as np

from engine.fitness import best_effort, fit_riegel_exponent, predict_time


def make_run(pace_s_per_km, km):
    """Fake run at a constant pace, with a GPS point every 10 seconds."""
    speed = 1000 / pace_s_per_km
    times = np.arange(0, pace_s_per_km * km + 1, 10.0)
    return times, times * speed


def test_best_effort_constant_pace():
    times, dist = make_run(300, 12)  # 5:00/km for 12 km
    assert abs(best_effort(times, dist, 5000) - 1500) < 1


def test_best_effort_too_short_returns_none():
    times, dist = make_run(300, 3)
    assert best_effort(times, dist, 5000) is None


def test_fit_exponent():
    efforts = {5000: 1500, 10000: 1500 * 2 ** 1.07}
    assert abs(fit_riegel_exponent(efforts) - 1.07) < 0.001


def test_exponent_defaults_with_one_effort():
    assert fit_riegel_exponent({5000: 1500}) == 1.06


def test_marathon_slower_than_half():
    efforts = {5000: 1500, 10000: 3150}
    k = fit_riegel_exponent(efforts)
    assert predict_time(efforts, 42195, k) > 2 * predict_time(efforts, 21097.5, k)