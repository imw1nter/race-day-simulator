import numpy as np

from engine.course import build_course, smooth

COURSE = "sample_data/osaka.gpx"


def test_course_length_is_marathon():
    course = build_course(COURSE)
    assert 42.0 < course.total_distance / 1000 < 42.6


def test_segments_are_evenly_spaced():
    course = build_course(COURSE, step=100)
    assert np.allclose(np.diff(course.distance), 100)


def test_grades_are_realistic():
    course = build_course(COURSE)
    assert np.all(np.abs(course.grade) < 0.10)  # no road is steeper than 10%


def test_smooth_keeps_length_and_flattens_spikes():
    values = np.array([0, 0, 10, 0, 0], dtype=float)
    result = smooth(values, window=3)
    assert len(result) == len(values)
    assert result.max() < values.max()