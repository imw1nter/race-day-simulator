import warnings
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

import fitdecode
import gpxpy
import numpy as np

TARGET_DISTANCES = [1000, 3000, 5000, 10000, 21097.5]
DEFAULT_EXPONENT = 1.06
MAX_SPEED = 10.0          # m/s (~1:40/km); anything faster is a glitch
MAX_GAP = 600             # s; a pause longer than 10 minutes starts a new piece
MIN_RUN_DISTANCE = 500    # m; less than this means no usable distance data
SUPPORTED_FORMATS = {".gpx", ".fit", ".tcx"}
TCX_NS = "{http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2}"


# --- Reading files -----------------------------------------------------------

def read_fit(path):
    """Read (timestamp, distance) samples from a FIT file.

    FIT files store the distance measured by the watch, so this works for
    indoor/treadmill runs as well as outdoor runs.
    """
    samples = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with fitdecode.FitReader(path) as fit:
         for frame in fit:
                if frame.frame_type != fitdecode.FIT_FRAME_DATA or frame.name != "record":
                    continue
                if frame.has_field("timestamp") and frame.has_field("distance"):
                    t, d = frame.get_value("timestamp"), frame.get_value("distance")
                    if t is not None and d is not None:
                        samples.append((t.timestamp(), float(d)))
    return samples


def read_tcx(path):
    """Read (timestamp, distance) samples from a TCX file."""
    samples = []
    for tp in ET.parse(path).getroot().iter(f"{TCX_NS}Trackpoint"):
        t = tp.find(f"{TCX_NS}Time")
        d = tp.find(f"{TCX_NS}DistanceMeters")
        if t is None or d is None:
            continue
        ts = datetime.fromisoformat(t.text.replace("Z", "+00:00")).timestamp()
        samples.append((ts, float(d.text)))
    return samples


def split_samples(samples):
    """Turn (timestamp, cumulative distance) samples into clean pieces.

    A new piece starts when time goes backwards, there is a long pause, or the
    distance counter resets. Duplicate timestamps and impossible speeds are skipped.
    """
    pieces, times, dist = [], [], []
    prev_t = prev_d = None
    for ts, d in samples:
        if prev_t is not None:
            dt, dd = ts - prev_t, d - prev_d
            if dt == 0:
                continue
            if dt < 0 or dt > MAX_GAP or dd < 0:
                if len(times) >= 2:
                    pieces.append((np.array(times) - times[0], np.array(dist) - dist[0]))
                times, dist = [], []
            elif dd / dt > MAX_SPEED:
                continue
        times.append(ts)
        dist.append(d)
        prev_t, prev_d = ts, d
    if len(times) >= 2:
        pieces.append((np.array(times) - times[0], np.array(dist) - dist[0]))
    return pieces


def load_gpx(path):
    """Read a GPX run, computing distance from GPS positions."""
    with open(path) as f:
        gpx = gpxpy.parse(f)

    pieces = []
    for track in gpx.tracks:
        for segment in track.segments:
            times, dist, prev = [], [], None
            for p in segment.points:
                if p.time is None:
                    continue
                ts = p.time.timestamp()
                if prev is not None:
                    dt = ts - prev.time.timestamp()
                    if dt == 0:
                        continue
                    if dt < 0 or dt > MAX_GAP:
                        if len(times) >= 2:
                            pieces.append((np.array(times) - times[0], np.array(dist)))
                        times, dist, prev = [], [], None
                    else:
                        dd = p.distance_2d(prev) or 0.0
                        if dd / dt > MAX_SPEED:
                            continue
                        times.append(ts)
                        dist.append(dist[-1] + dd)
                        prev = p
                        continue
                times.append(ts)
                dist.append(0.0)
                prev = p
            if len(times) >= 2:
                pieces.append((np.array(times) - times[0], np.array(dist)))
    return pieces


def load_run(path):
    """Load a run from GPX, FIT, or TCX. Returns a list of (time, distance) pieces."""
    suffix = Path(path).suffix.lower()
    if suffix == ".fit":
        return split_samples(read_fit(path))
    if suffix == ".tcx":
        return split_samples(read_tcx(path))
    return load_gpx(path)


# --- Analysis ----------------------------------------------------------------

def best_effort(times, dist, target):
    """Fastest time (s) to cover `target` metres anywhere in the run."""
    if dist[-1] < target:
        # GPS often measures a race slightly short. If the run is within 2%
        # of the target, scale its time up to the full distance.
        if dist[-1] >= target * 0.98:
            return times[-1] * target / dist[-1]
        return None
    best = np.inf
    j = 0
    for i in range(len(dist)):
        while j < len(dist) and dist[j] - dist[i] < target:
            j += 1
        if j == len(dist):
            break
        d0, d1 = dist[j - 1] - dist[i], dist[j] - dist[i]
        frac = (target - d0) / (d1 - d0)
        t_end = times[j - 1] + frac * (times[j] - times[j - 1])
        best = min(best, t_end - times[i])
    return best


def collect_best_efforts(run_paths):
    """Best time for each target distance across all runs.

    Returns (efforts, skipped), where skipped is a list of (file name, reason).
    """
    efforts, skipped = {}, []
    for path in run_paths:
        path = Path(path)
        if path.suffix.lower() not in SUPPORTED_FORMATS:
            skipped.append((path.name, "unsupported file type (use GPX, FIT, or TCX)"))
            continue
        try:
            pieces = load_run(path)
        except Exception as e:  # any unreadable file should be reported, not crash the app
            skipped.append((path.name, f"could not read file ({e})"))
            continue

        if sum(d[-1] for _, d in pieces) < MIN_RUN_DISTANCE:
            if path.suffix.lower() == ".gpx":
                reason = "no GPS distance (treadmill or indoor run? export it as FIT or TCX instead)"
            else:
                reason = "no distance data in file"
            skipped.append((path.name, reason))
            continue

        for times, dist in pieces:
            for target in TARGET_DISTANCES:
                t = best_effort(times, dist, target)
                if t is not None and (target not in efforts or t < efforts[target]):
                    efforts[target] = t
    return efforts, skipped


def fit_riegel_exponent(efforts):
    """Estimate the personal fatigue exponent k from best efforts."""
    if len(efforts) < 2:
        return DEFAULT_EXPONENT
    d = np.log(list(efforts.keys()))
    t = np.log(list(efforts.values()))
    k = np.polyfit(d, t, 1)[0]
    return float(np.clip(k, 1.03, 1.15))


def predict_time(efforts, target, exponent):
    """Predicted time (s) for `target` metres, using the most optimistic effort."""
    return min(t * (target / d) ** exponent for d, t in efforts.items())


def format_time(seconds):
    h, rem = divmod(int(round(seconds)), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


if __name__ == "__main__":
    runs = sorted(
        p for p in Path("sample_data/runs").iterdir()
        if p.is_file() and not p.name.startswith(".")
    )
    efforts, skipped = collect_best_efforts(runs)

    print(f"Files found: {len(runs)}, used: {len(runs) - len(skipped)}")
    for name, reason in skipped:
        print(f"  Skipped {name}: {reason}")
    for d, t in sorted(efforts.items()):
        print(f"  Best {d / 1000:>5.1f} km: {format_time(t)}")

    k = fit_riegel_exponent(efforts)
    print(f"Fatigue exponent k: {k:.3f}")
    print(f"Predicted half:     {format_time(predict_time(efforts, 21097.5, k))}")
    print(f"Predicted marathon: {format_time(predict_time(efforts, 42195, k))}")