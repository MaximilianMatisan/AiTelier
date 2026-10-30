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


def test_web_ui_demo_catalogue_and_part_swap(settings, raw_input):
    client = TestClient(create_app(settings))

    home = client.get("/")
    assert home.status_code == 200
    assert "AiTelier Person 3 Studio" in home.text

    demo = client.get("/v1/demo/input")
    assert demo.status_code == 200
    assert len(demo.json()["items"]) == len(raw_input["items"])

    result = client.post("/v1/style", json=raw_input).json()
    task_id = result["task_id"]

    gallery = client.get(f"/gallery/{task_id}")
    assert gallery.status_code == 200
    assert "Catalogue images" in gallery.text

    catalogue = client.get(f"/v1/style/{task_id}/catalogue")
    assert catalogue.status_code == 200
    assert len(catalogue.json()["items"]) == len(raw_input["items"])
    assert all(item["image_url"] for item in catalogue.json()["items"])

    outfit = result["outfits"][0]
    outfit_id = outfit["outfit_id"]
    current = next(item for item in outfit["items"] if item["layer"] == "base")
    candidates = client.get(f"/v1/style/{task_id}/candidates?layer=base")
    assert candidates.status_code == 200
    alternative = next(
        item for item in candidates.json()["items"] if item["item_id"] != current["item_id"]
    )

    swapped = client.post(
        f"/v1/style/{task_id}/outfits/{outfit_id}/parts",
        json={"layer": "base", "item_id": alternative["item_id"], "size": alternative["sizes"][0]},
    )
    assert swapped.status_code == 200, swapped.text
    updated = swapped.json()
    changed = next(
        item for item in updated["outfits"][0]["items"] if item["layer"] == "base"
    )
    assert changed["item_id"] == alternative["item_id"]
    assert updated["a2ui"]["valid"] is True
    assert (settings.artifact_dir / updated["outfits"][0]["images"]["board"]).is_file()

    invalid = client.post(
        f"/v1/style/{task_id}/outfits/{outfit_id}/parts",
        json={"layer": "base", "item_id": alternative["item_id"], "size": "NOT-A-SIZE"},
    )
    assert invalid.status_code == 422
