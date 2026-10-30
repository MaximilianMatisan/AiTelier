from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def test_health_and_style_endpoint(settings, raw_input):
    client = TestClient(create_app(settings))
    health = client.get("/healthz")
    assert health.status_code == 200
    assert health.json()["ok"] is True

    response = client.post("/v1/style", json=raw_input)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "APPROVED"
    assert result["a2ui"]["valid"] is True
    assert len(result["outfits"]) == 2

    a2ui = client.get(f"/v1/style/{result['task_id']}/a2ui")
    assert a2ui.status_code == 200
    assert isinstance(a2ui.json(), list)
    assert len(a2ui.json()) == 3

    stored = client.get(f"/v1/style/{result['task_id']}")
    assert stored.status_code == 200
    assert stored.json()["task_id"] == result["task_id"]

    board = result["outfits"][0]["images"]["board"]
    assert (settings.artifact_dir / board).is_file()
