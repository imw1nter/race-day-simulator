from pathlib import Path

import gpxpy
import numpy as np

TARGET_DISTANCES = [1000, 3000, 5000, 10000, 21097.5]
DEFAULT_EXPONENT = 1.06
MAX_SPEED = 10.0  # m/s (~1:40/km); anything faster is a GPS glitch
MAX_GAP = 600     # s; a pause longer than 10 minutes starts a new piece


def load_run(path):
    """Read a GPX run and split it into clean pieces.

    Returns a list of (elapsed time (s), cumulative distance (m)) pairs.
    A new piece starts whenever time goes backwards or jumps by more than
    MAX_GAP. Points implying impossible speeds are skipped as GPS glitches.
    """
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
                    if dt <= 0 or dt > MAX_GAP:
                        if len(times) >= 2:
                            pieces.append((np.array(times) - times[0], np.array(dist)))
                        times, dist, prev = [], [], None
                    else:
                        dd = p.distance_2d(prev) or 0.0
                        if dd / dt > MAX_SPEED:
                            continue  # skip glitch point
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


def best_effort(times, dist, target):
    """Fastest time (s) to cover `target` metres anywhere in the run."""
    if dist[-1] < target:
        return None
    best = np.inf
    j = 0
    for i in range(len(dist)):
        while j < len(dist) and dist[j] - dist[i] < target:
            j += 1
        if j == len(dist):
            break
        # Interpolate to find the exact moment the target distance is reached
        d0, d1 = dist[j - 1] - dist[i], dist[j] - dist[i]
        frac = (target - d0) / (d1 - d0)
        t_end = times[j - 1] + frac * (times[j] - times[j - 1])
        best = min(best, t_end - times[i])
    return best


def collect_best_efforts(run_paths):
    """Best time for each target distance across all runs."""
    efforts = {}
    for path in run_paths:
        for times, dist in load_run(path):
            for target in TARGET_DISTANCES:
                t = best_effort(times, dist, target)
                if t is not None and (target not in efforts or t < efforts[target]):
                    efforts[target] = t
    return efforts


def fit_riegel_exponent(efforts):
    """Estimate the personal fatigue exponent k from best efforts."""
    if len(efforts) < 2:
        return DEFAULT_EXPONENT
    d = np.log(list(efforts.keys()))
    t = np.log(list(efforts.values()))
    k = np.polyfit(d, t, 1)[0]
    return float(np.clip(k, 1.03, 1.15))  # keep within realistic limits


def predict_time(efforts, target, exponent):
    """Predicted time (s) for `target` metres, using the most optimistic effort."""
    return min(t * (target / d) ** exponent for d, t in efforts.items())


def format_time(seconds):
    h, rem = divmod(int(round(seconds)), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


if __name__ == "__main__":
    runs = sorted(Path("sample_data/runs").glob("*.gpx"))
    for path in runs:
        pieces = load_run(path)
        km = sum(d[-1] for _, d in pieces) / 1000
        print(f"  {path.name}: {len(pieces)} piece(s), {km:.1f} km")
    efforts = collect_best_efforts(runs)
    print(f"Runs loaded: {len(runs)}")
    for d, t in sorted(efforts.items()):
        print(f"  Best {d / 1000:>5.1f} km: {format_time(t)}")

    k = fit_riegel_exponent(efforts)
    print(f"Fatigue exponent k: {k:.3f}")
    print(f"Predicted half:     {format_time(predict_time(efforts, 21097.5, k))}")
    print(f"Predicted marathon: {format_time(predict_time(efforts, 42195, k))}")