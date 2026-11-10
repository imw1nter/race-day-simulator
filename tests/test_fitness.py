from datetime import datetime, timedelta, timezone

import numpy as np

from engine.fitness import (
    best_effort,
    collect_best_efforts,
    fit_riegel_exponent,
    predict_time,
    split_samples,
    merge_efforts,
)


def make_run(pace_s_per_km, km):
    """Fake run at a constant pace, with a point every 10 seconds."""
    speed = 1000 / pace_s_per_km
    times = np.arange(0, pace_s_per_km * km + 1, 10.0)
    return times, times * speed


def make_tcx(km, pace=300, step_s=30):
    """Fake indoor TCX run: distance from the watch, no GPS positions."""
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    points = []
    for i in range(int(km * pace / step_s) + 1):
        t = (start + timedelta(seconds=i * step_s)).strftime("%Y-%m-%dT%H:%M:%SZ")
        d = i * step_s * 1000 / pace
        points.append(f"<Trackpoint><Time>{t}</Time><DistanceMeters>{d:.1f}</DistanceMeters></Trackpoint>")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">'
        '<Activities><Activity Sport="Running"><Lap><Track>'
        + "".join(points)
        + "</Track></Lap></Activity></Activities></TrainingCenterDatabase>"
    )


TREADMILL_GPX = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
<trk><trkseg>
<trkpt lat="34.0" lon="135.0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="34.0" lon="135.0"><time>2026-01-01T00:10:00Z</time></trkpt>
<trkpt lat="34.0" lon="135.0"><time>2026-01-01T00:20:00Z</time></trkpt>
</trkseg></trk>
</gpx>"""


# --- Best efforts and predictions --------------------------------------------

def test_best_effort_constant_pace():
    times, dist = make_run(300, 12)
    assert abs(best_effort(times, dist, 5000) - 1500) < 1


def test_best_effort_too_short_returns_none():
    times, dist = make_run(300, 3)
    assert best_effort(times, dist, 5000) is None


def test_slightly_short_run_still_counts():
    times, dist = make_run(300, 5)
    dist = dist * 0.99  # GPS measured the 5 km as 4.95 km
    assert best_effort(times, dist, 5000) is not None


def test_fit_exponent():
    efforts = {5000: 1500, 10000: 1500 * 2 ** 1.07}
    assert abs(fit_riegel_exponent(efforts) - 1.07) < 0.001


def test_exponent_defaults_with_one_effort():
    assert fit_riegel_exponent({5000: 1500}) == 1.06


def test_marathon_slower_than_half():
    efforts = {5000: 1500, 10000: 3150}
    k = fit_riegel_exponent(efforts)
    assert predict_time(efforts, 42195, k) > 2 * predict_time(efforts, 21097.5, k)

def test_merge_keeps_faster_time():
    runs = {5000: 1500}
    records = {5000: 1400.0, 10000: 3000.0}
    efforts, sources = merge_efforts(runs, records)
    assert efforts[5000] == 1400
    assert sources[5000] == "record"
    assert sources[10000] == "record"


def test_merge_keeps_run_when_faster():
    efforts, sources = merge_efforts({5000: 1300}, {5000: 1400.0})
    assert efforts[5000] == 1300
    assert sources[5000] == "run"

# --- Cleaning samples ----------------------------------------------------------

def test_split_samples_skips_duplicates():
    samples = [(0, 0), (10, 30), (10, 30), (20, 60)]
    pieces = split_samples(samples)
    assert len(pieces) == 1
    assert len(pieces[0][0]) == 3


def test_split_samples_splits_on_distance_reset():
    samples = [(0, 0), (10, 30), (20, 60), (30, 0), (40, 30)]
    assert len(split_samples(samples)) == 2


# --- Files ---------------------------------------------------------------------

def test_indoor_tcx_run_is_used(tmp_path):
    f = tmp_path / "treadmill.tcx"
    f.write_text(make_tcx(km=6))
    efforts, skipped = collect_best_efforts([f])
    assert skipped == []
    assert abs(efforts[5000] - 1500) < 1


def test_indoor_gpx_is_skipped_with_advice(tmp_path):
    f = tmp_path / "treadmill.gpx"
    f.write_text(TREADMILL_GPX)
    efforts, skipped = collect_best_efforts([f])
    assert efforts == {}
    assert "FIT or TCX" in skipped[0][1]


def test_broken_file_does_not_crash(tmp_path):
    f = tmp_path / "broken.gpx"
    f.write_text("this is not a gpx file")
    efforts, skipped = collect_best_efforts([f])
    assert efforts == {}
    assert len(skipped) == 1


def test_unsupported_format_is_skipped(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("hello")
    efforts, skipped = collect_best_efforts([f])
    assert "unsupported" in skipped[0][1]