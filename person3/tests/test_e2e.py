from __future__ import annotations

from copy import deepcopy
from pathlib import Path

from PIL import Image

from app.graph import run_style
from .conftest import make_settings


def test_e2e_winter_pipeline_creates_gallery_and_boards(style_result):
    result, settings = style_result
    assert result["status"] == "APPROVED"
    assert result["decision"]["approved"] is True
    assert len(result["outfits"]) == 2
    assert all(len(outfit["layers"]) == 5 for outfit in result["outfits"])
    assert all(outfit["guarantees"]["ok"] for outfit in result["outfits"])

    for outfit in result["outfits"]:
        board = settings.artifact_dir / outfit["images"]["board"]
        assert board.is_file()
        with Image.open(board) as image:
            assert image.width > 500
            assert image.height > 500

    lookbook = settings.artifact_dir / result["lookbook"]
    assert lookbook.is_file()
    with Image.open(lookbook) as image:
        assert image.width > 500

    messages = result["a2ui"]["messages"]
    assert len(messages) == 3
    assert result["a2ui"]["valid"] is True
    assert result["markdown"].startswith("# AiTelier result")


def test_e2e_summer_uses_only_three_layers(tmp_path, raw_input):
    raw = deepcopy(raw_input)
    raw["customer"]["season"] = "summer"
    raw["customer"]["climate"] = "hot and dry"
    settings = make_settings(tmp_path)
    result = run_style(raw, settings)
    assert result["status"] == "APPROVED"
    assert result["outfits"]
    assert all(len(outfit["layers"]) == 3 for outfit in result["outfits"])
    assert all(
        [layer["layer"] for layer in outfit["layers"]]
        == ["base", "bottom", "shoes"]
        for outfit in result["outfits"]
    )
    assert all(len(tab["tabs"]) == 3 for tab in _tabs(result))


def test_e2e_refund_when_no_outfit_passes(tmp_path, raw_input):
    raw = deepcopy(raw_input)
    raw["options"]["strict_guarantees"] = True
    raw["options"]["max_selection_retries"] = 0
    for item in raw["items"]:
        item["shipping"] = {"amount": 4.9, "currency": "EUR", "days": 100000, "regions": ["DE"]}
    settings = make_settings(tmp_path)
    result = run_style(raw, settings)
    assert result["status"] == "REFUND"
    assert result["refund"]["amount"] == 6
    assert result["refund"]["executed"] is False
    assert result["a2ui"]["valid"] is True


def _tabs(result):
    components = result["a2ui"]["messages"][1]["updateComponents"]["components"]
    return [component for component in components if component["component"] == "Tabs"]
