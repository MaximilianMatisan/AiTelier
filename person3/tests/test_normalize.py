from __future__ import annotations

from copy import deepcopy

import pytest

from app.models import ContractError
from app.normalize import normalize_request


def test_availability_missing_null_and_empty_become_unknown(settings, raw_input):
    for value in (None, "", "  "):
        raw = deepcopy(raw_input)
        raw["items"][0]["availability"] = value
        request = normalize_request(raw, settings)
        item = next(item for item in request.items if item.item_id == "base-oxford")
        assert item.availability == "unknown"


def test_availability_boolean_and_object(settings, raw_input):
    raw = deepcopy(raw_input)
    raw["items"][0]["availability"] = False
    raw["items"][1]["availability"] = {"status": "in_stock", "quantity": 2}
    request = normalize_request(raw, settings)
    assert next(i for i in request.items if i.item_id == "base-oxford").availability == "sold_out"
    assert next(i for i in request.items if i.item_id == "base-check").availability == "in_stock"


def test_fit_descriptors_are_free_text(settings, raw_input):
    raw = deepcopy(raw_input)
    raw["customer"]["fit"] = "straight fit, slim waist"
    request = normalize_request(raw, settings)
    assert request.customer.fit == ["straight fit, slim waist"]
    assert request.customer.fit_description.startswith("Straight fit")


def test_season_changes_required_layers(settings, raw_input):
    winter = normalize_request(deepcopy(raw_input), settings)
    assert winter.required_layers == ["base", "mid", "outer", "bottom", "shoes"]

    raw = deepcopy(raw_input)
    raw["customer"]["season"] = "summer"
    raw["customer"]["climate"] = "hot and dry"
    summer = normalize_request(raw, settings)
    assert summer.required_layers == ["base", "bottom", "shoes"]


def test_no_html_and_price_variants(settings, raw_input):
    raw = deepcopy(raw_input)
    raw["items"][0]["description"] = "<b>Soft</b> oxford <i>shirt</i>."
    raw["items"][0]["price"] = "EUR 89,90"
    request = normalize_request(raw, settings)
    item = next(item for item in request.items if item.item_id == "base-oxford")
    assert "<" not in item.description
    assert "Soft" in item.description
    assert item.price.amount == pytest.approx(89.90)


def test_unknown_fields_are_preserved(settings, raw_input):
    raw = deepcopy(raw_input)
    raw["items"][0]["raw_extra"] = {"source_note": "keep me"}
    request = normalize_request(raw, settings)
    item = next(item for item in request.items if item.item_id == "base-oxford")
    assert item.raw["raw_extra"]["source_note"] == "keep me"


def test_invalid_budget_is_rejected(settings, raw_input):
    raw = deepcopy(raw_input)
    del raw["customer"]["budget"]
    with pytest.raises(ContractError):
        normalize_request(raw, settings)
