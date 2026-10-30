from __future__ import annotations

from app.services.a2ui import A2UI_VERSION, validate_a2ui


def test_a2ui_gallery_is_valid(style_result):
    result, _settings = style_result
    a2ui = result["a2ui"]
    assert a2ui["version"] == A2UI_VERSION
    assert a2ui["valid"] is True
    assert a2ui["errors"] == []
    assert validate_a2ui(a2ui["messages"]) == []
    assert [message.keys() for message in a2ui["messages"]][0] == {"version", "createSurface"}


def test_a2ui_uses_only_allowed_components(style_result):
    result, _settings = style_result
    components = result["a2ui"]["messages"][1]["updateComponents"]["components"]
    types = {component["component"] for component in components}
    assert "Video" not in types
    assert "AudioPlayer" not in types
    assert {"Column", "List", "Card", "Text", "Image", "Tabs", "Button", "Icon"} <= types


def test_a2ui_click_through_is_tabs_and_open_url(style_result):
    result, _settings = style_result
    components = result["a2ui"]["messages"][1]["updateComponents"]["components"]
    tabs = [component for component in components if component["component"] == "Tabs"]
    buttons = [component for component in components if component["component"] == "Button"]
    assert tabs
    assert all(len(tab["tabs"]) >= 3 for tab in tabs)
    assert all(
        button["action"]["functionCall"]["call"] == "openUrl"
        for button in buttons
    )
    assert all("event" not in button["action"] for button in buttons)


def test_a2ui_layer_count_matches_outfit(style_result):
    result, _settings = style_result
    components = result["a2ui"]["messages"][1]["updateComponents"]["components"]
    tabs = [component for component in components if component["component"] == "Tabs"]
    assert [len(tab["tabs"]) for tab in tabs] == [
        len(outfit["layers"]) for outfit in result["outfits"]
    ]
