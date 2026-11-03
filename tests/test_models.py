import numpy as np

from engine.models import fatigue_factor, grade_factor, heat_factor


def test_flat_ground_has_no_effect():
    assert np.isclose(grade_factor(0.0), 1.0)


def test_uphill_slower_downhill_faster():
    assert grade_factor(0.03) > 1.0
    assert grade_factor(-0.03) < 1.0


def test_downhill_gain_smaller_than_uphill_cost():
    gain = 1 - grade_factor(-0.03)
    cost = grade_factor(0.03) - 1
    assert gain < cost


def test_cool_weather_no_slowdown():
    assert heat_factor(10, 2) == 1.0


def test_hot_humid_weather_slows_down():
    assert heat_factor(30, 24) > 1.05
    assert heat_factor(30, 24) > heat_factor(20, 12)


def test_fatigue_starts_late_and_peaks_at_finish():
    assert fatigue_factor(10000, 42195) == 1.0
    assert np.isclose(fatigue_factor(42195, 42195, drift=0.03), 1.03)