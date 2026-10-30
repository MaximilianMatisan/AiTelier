from __future__ import annotations

from copy import deepcopy

from app.normalize import normalize_request
from app.services.checks import check_outfit, live_check
from app.services.llm import select_outfits
from app.services.resolver import resolve_selection


def _outfit(settings, raw):
    request = normalize_request(deepcopy(raw), settings)
    selection = select_outfits(request, settings=settings)
    outfits, errors = resolve_selection(selection, request)
    assert not errors
    assert outfits
    return request, outfits[0]


def test_snapshot_passes_all_five(settings, raw_input):
    request, outfit = _outfit(settings, raw_input)
    live = {item.item_id: live_check(item, settings) for item in request.items}
    result = check_outfit(outfit, request, live)
    assert result["ok"] is True
    assert set(result["checks"]) == {
        "budget",
        "fit",
        "availability",
        "price_integrity",
        "delivery",
    }


def test_price_change_fails(settings, raw_input):
    request, outfit = _outfit(settings, raw_input)
    live = {item.item_id: live_check(item, settings) for item in request.items}
    item_id = outfit["items"][0]["item_id"]
    live[item_id]["price"]["amount"] = 999.0
    result = check_outfit(outfit, request, live)
    assert result["ok"] is False
    assert result["checks"]["price_integrity"]["ok"] is False


def test_stale_or_out_of_stock_fails(settings, raw_input):
    request, outfit = _outfit(settings, raw_input)
    live = {item.item_id: live_check(item, settings) for item in request.items}
    item_id = outfit["items"][0]["item_id"]
    live[item_id]["availability"] = "sold_out"
    live[item_id]["stale"] = True
    result = check_outfit(outfit, request, live)
    assert result["ok"] is False
    assert result["checks"]["availability"]["ok"] is False


def test_budget_fails(settings, raw_input):
    request, outfit = _outfit(settings, raw_input)
    live = {item.item_id: live_check(item, settings) for item in request.items}
    outfit = deepcopy(outfit)
    outfit["totals"]["grand_total"] = 5000.0
    result = check_outfit(outfit, request, live)
    assert result["checks"]["budget"]["ok"] is False


def test_snapshot_uses_shop_shipping_when_item_shipping_is_missing(settings, raw_input):
    raw = deepcopy(raw_input)
    for item in raw["items"]:
        item.pop("shipping", None)
    request = normalize_request(raw, settings)
    item = next(item for item in request.items if item.item_id == "base-oxford")
    shop = next(shop for shop in request.shops if shop.shop_id == item.shop_id)
    live = live_check(item, settings, shop)
    assert live["shipping"]["amount"] == 4.9
    assert live["shipping"]["regions"] == ["DE"]


def test_delivery_region_fails(settings, raw_input):
    request, outfit = _outfit(settings, raw_input)
    live = {item.item_id: live_check(item, settings) for item in request.items}
    item_id = outfit["items"][0]["item_id"]
    live[item_id]["shipping"]["regions"] = ["US"]
    result = check_outfit(outfit, request, live)
    assert result["checks"]["delivery"]["ok"] is False
