from dataclasses import dataclass

import gpxpy
import numpy as np


@dataclass
class Course:
    """A race course split into equal-length segments."""
    distance: np.ndarray   # start of each segment (m)
    elevation: np.ndarray  # smoothed elevation at each segment start (m)
    grade: np.ndarray      # slope of each segment (0.02 = 2% uphill)
    step: float            # segment length (m)

    @property
    def total_distance(self):
        return self.distance[-1] + self.step

    @property
    def total_climb(self):
        return np.clip(np.diff(self.elevation), 0, None).sum()


def load_points(path):
    """Read a GPX file and return cumulative distance (m) and elevation (m)."""
    with open(path) as f:
        gpx = gpxpy.parse(f)

    points = [p for t in gpx.tracks for s in t.segments for p in s.points]
    if not points:
        points = [p for r in gpx.routes for p in r.points]

    distance = [0.0]
    for a, b in zip(points, points[1:]):
        distance.append(distance[-1] + a.distance_2d(b))

    elevation = np.array([p.elevation or 0 for p in points])
    return np.array(distance), elevation


def smooth(values, window=5):
    """Moving-average smoothing that keeps the array the same length."""
    if window < 2:
        return values
    padded = np.pad(values, window // 2, mode="edge")
    kernel = np.ones(window) / window
    return np.convolve(padded, kernel, mode="valid")[: len(values)]


def build_course(path, step=100.0, window=5, official_distance=None):
    """Load a GPX file and turn it into evenly spaced, smoothed segments."""
    raw_dist, raw_elev = load_points(path)
    if official_distance:
        raw_dist = raw_dist * official_distance / raw_dist[-1]
        

    # Equal steps from 0 to the end of the course
    grid = np.arange(0, raw_dist[-1], step)
    # Estimate the elevation at each step from the nearest GPS points
    elev = np.interp(grid, raw_dist, raw_elev)
    elev = smooth(elev, window)

    # Grade of each segment = elevation change / segment length
    grade = np.diff(elev, append=elev[-1]) / step

    return Course(distance=grid, elevation=elev, grade=grade, step=step)


if __name__ == "__main__":
    course = build_course("sample_data/osaka.gpx")
    print(f"Segments: {len(course.distance)} x {course.step:.0f} m")
    print(f"Distance: {course.total_distance / 1000:.2f} km")
    print(f"Total climb (smoothed): {course.total_climb:.0f} m")
    print(f"Steepest uphill: {course.grade.max() * 100:.1f}%")
    print(f"Steepest downhill: {course.grade.min() * 100:.1f}%")