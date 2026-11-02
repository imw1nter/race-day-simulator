import gpxpy
import numpy as np


def load_course(path):
    """Read a GPX file and return cumulative distance (m) and elevation (m)."""
    with open(path) as f:
        gpx = gpxpy.parse(f)

    points = [p for t in gpx.tracks for s in t.segments for p in s.points]
    # Some GPX files store the course as a "route" instead of a "track"
    if not points:
        points = [p for r in gpx.routes for p in r.points]

    distance = [0.0]
    for a, b in zip(points, points[1:]):
        distance.append(distance[-1] + a.distance_2d(b))

    elevation = np.array([p.elevation or 0 for p in points])
    return np.array(distance), elevation


if __name__ == "__main__":
    dist, elev = load_course("sample_data/osaka.gpx")
    climb = np.clip(np.diff(elev), 0, None).sum()
    print(f"Points: {len(dist)}")
    print(f"Distance: {dist[-1] / 1000:.2f} km")
    print(f"Total climb: {climb:.0f} m")