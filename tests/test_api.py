import json

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.main import app, parse_time

client = TestClient(app)


def make_tcx(km=6, pace=300, step_s=30):
    """Small fake TCX run for upload tests."""
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    pts = "".join(
        f"<Trackpoint><Time>{(start + timedelta(seconds=i * step_s)).strftime('%Y-%m-%dT%H:%M:%SZ')}</Time>"
        f"<DistanceMeters>{i * step_s * 1000 / pace:.1f}</DistanceMeters></Trackpoint>"
        for i in range(int(km * pace / step_s) + 1)
    )
    return (
        '<?xml version="1.0"?><TrainingCenterDatabase '
        'xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">'
        f"<Activities><Activity Sport=\"Running\"><Lap><Track>{pts}</Track></Lap></Activity></Activities>"
        "</TrainingCenterDatabase>"
    )


def test_parse_time():
    assert parse_time("4:00:00") == 14400
    assert parse_time("25:30") == 1530


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_courses_include_osaka():
    ids = [c["id"] for c in client.get("/api/courses").json()]
    assert "osaka" in ids


def test_simulate_with_manual_fitness():
    r = client.post("/api/simulate", data={"fitness_time": "3:55:00", "simulations": "200"})
    assert r.status_code == 200
    body = r.json()
    assert body["fitness"]["source"] == "manual"
    assert len(body["strategies"]) == 3
    assert 0 <= body["monte_carlo"]["p_goal"] <= 1
    assert len(body["course"]["lat"]) == len(body["course"]["elevation"])


def test_simulate_with_uploaded_run():
    files = [("runs", ("run.tcx", make_tcx(), "application/xml"))]
    r = client.post("/api/simulate", data={"simulations": "200"}, files=files)
    assert r.status_code == 200
    assert r.json()["fitness"]["source"] == "runs"

def test_simulate_with_records_only():
    records = json.dumps([{"distance_km": 5, "time": "21:47"}, {"distance_km": 10, "time": "45:30"}])
    r = client.post("/api/simulate", data={"records": records, "simulations": "200"})
    assert r.status_code == 200
    body = r.json()
    assert body["fitness"]["source"] == "records"
    assert len(body["fitness"]["best_efforts"]) == 2

def test_missing_fitness_is_rejected():
    r = client.post("/api/simulate", data={"simulations": "200"})
    assert r.status_code == 400


def test_invalid_goal_time_is_rejected():
    r = client.post("/api/simulate", data={"fitness_time": "3:55:00", "goal_time": "abc"})
    assert r.status_code == 400


def test_dew_point_above_temperature_is_rejected():
    r = client.post("/api/simulate", data={"fitness_time": "3:55:00", "temp_c": "10", "dew_c": "15"})
    assert r.status_code == 400

def test_invalid_records_json_is_rejected():
    r = client.post("/api/simulate", data={"records": "not json"})
    assert r.status_code == 400


def test_impossible_record_is_rejected():
    records = json.dumps([{"distance_km": 10, "time": "10:00"}])
    r = client.post("/api/simulate", data={"records": records})
    assert r.status_code == 400