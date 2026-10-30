from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

import httpx

from ..config import Settings
from ..models import Item, StylistRequest


def live_check(item: Item, settings: Settings) -> dict[str, Any]:
    if settings.live_check_mode == "stale":
        return _snapshot(item, stale=True)
    if settings.live_check_mode == "snapshot" or not settings.person1_refresh_url:
        return _snapshot(item, stale=False)
    try:
        with httpx.Client(timeout=20.0) as client:
            response = client.post(
                settings.person1_refresh_url,
                json={
                    "items": [
                        {
                            "item_id": item.item_id,
                            "shop_id": item.shop_id,
                            "product_url": item.product_url,
                        }
                    ]
                },
            )
            response.raise_for_status()
            payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get("items"), list):
            payload = payload["items"]
        if isinstance(payload, list) and payload:
            value = payload[0]
            value.setdefault("source", "person1_refresh")
            value.setdefault("stale", False)
            return value
    except (httpx.HTTPError, ValueError):
        pass
    return _snapshot(item, stale=True)


def _snapshot(item: Item, stale: bool) -> dict[str, Any]:
    return {
        "item_id": item.item_id,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "price": {"amount": item.price.amount, "currency": item.price.currency},
        "availability": item.availability,
        "sizes_in_stock": [size.label for size in item.sizes if size.in_stock is not False],
        "shipping": item.shipping,
        "product_url": item.product_url,
        "stale": stale,
        "source": "snapshot",
    }


def _size_option(item: Item, label: str):
    return next((size for size in item.sizes if size.label.lower() == label.lower()), None)


def _region(request: StylistRequest) -> str:
    region = request.options.get("country") or request.options.get("region")
    if region:
        return str(region).upper()
    return "DE"


def _deadline_days(request: StylistRequest) -> int | None:
    if not request.customer.deadline:
        return None
    try:
        deadline = date.fromisoformat(str(request.customer.deadline)[:10])
    except ValueError:
        return None
    return max(0, (deadline - date.today()).days)


def check_outfit(
    outfit: dict[str, Any],
    request: StylistRequest,
    live: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    by_id = {item.item_id: item for item in request.items}
    strict = bool(request.options.get("strict_guarantees", True))
    fit_mode = str(request.options.get("fit_mode", "measurements"))
    checks: dict[str, dict[str, Any]] = {}

    budget = request.customer.budget
    total = outfit["totals"]["grand_total"]
    checks["budget"] = {
        "ok": total <= budget.amount + 0.01 and outfit["totals"]["currency"] == budget.currency,
        "detail": f"{total:.2f} {outfit['totals']['currency']} <= {budget.amount:.2f} {budget.currency}",
    }

    fit_errors: list[str] = []
    for value in outfit["items"]:
        item = by_id[value["item_id"]]
        state = live.get(item.item_id, _snapshot(item, stale=False))
        sizes = state.get("sizes_in_stock") or []
        if value["size"] not in sizes and sizes:
            fit_errors.append(f"{item.item_id}: size {value['size']} unavailable")
        if fit_mode == "measurements" and request.customer.measurements_cm:
            option = _size_option(item, value["size"])
            if option and option.measurements_cm:
                for key, measured in option.measurements_cm.items():
                    body = request.customer.measurements_cm.get(key)
                    if body is None:
                        continue
                    delta = measured - body
                    if key == "chest" and not (4 <= delta <= 18):
                        fit_errors.append(f"{item.item_id}: chest ease {delta:.1f} cm outside range")
                    elif key == "shoulder" and abs(delta) > 3:
                        fit_errors.append(f"{item.item_id}: shoulder delta {delta:.1f} cm")
                    elif key == "waist" and not (0 <= delta <= 12):
                        fit_errors.append(f"{item.item_id}: waist delta {delta:.1f} cm")
                    elif key == "inseam" and not (-5 <= delta <= 2):
                        fit_errors.append(f"{item.item_id}: inseam delta {delta:.1f} cm")
    checks["fit"] = {
        "ok": not fit_errors,
        "detail": "all selected sizes and measurements are compatible" if not fit_errors else "; ".join(fit_errors),
    }

    availability_errors: list[str] = []
    for value in outfit["items"]:
        item = by_id[value["item_id"]]
        state = live.get(item.item_id, _snapshot(item, stale=False))
        if state.get("stale"):
            availability_errors.append(f"{item.item_id}: live data is stale")
        if state.get("availability") != "in_stock":
            availability_errors.append(f"{item.item_id}: {state.get('availability', 'unknown')}")
        sizes = state.get("sizes_in_stock")
        if sizes and value["size"] not in sizes:
            availability_errors.append(f"{item.item_id}: selected size not in live stock")
    checks["availability"] = {
        "ok": not availability_errors,
        "detail": "all items live in stock" if not availability_errors else "; ".join(availability_errors),
    }

    price_errors: list[str] = []
    for value in outfit["items"]:
        item = by_id[value["item_id"]]
        state = live.get(item.item_id, _snapshot(item, stale=False))
        live_price = state.get("price") or {}
        live_amount = live_price.get("amount")
        if live_amount is None:
            price_errors.append(f"{item.item_id}: live price missing")
            continue
        if live_price.get("currency") != item.price.currency:
            price_errors.append(f"{item.item_id}: currency changed")
        tolerance = max(0.01, item.price.amount * 0.01)
        if abs(float(live_amount) - item.price.amount) > tolerance:
            price_errors.append(
                f"{item.item_id}: price {live_amount} differs from {item.price.amount}"
            )
        if not state.get("shipping"):
            price_errors.append(f"{item.item_id}: live shipping missing")
    checks["price_integrity"] = {
        "ok": not price_errors,
        "detail": "live prices match the catalogue" if not price_errors else "; ".join(price_errors),
    }

    region = _region(request)
    deadline_days = _deadline_days(request)
    delivery_errors: list[str] = []
    for value in outfit["items"]:
        item = by_id[value["item_id"]]
        state = live.get(item.item_id, _snapshot(item, stale=False))
        shipping = state.get("shipping") or {}
        regions = [str(r).upper() for r in shipping.get("regions", [])]
        if regions and region not in regions:
            delivery_errors.append(f"{item.item_id}: does not ship to {region}")
        days = shipping.get("days")
        if days is None:
            days = shipping.get("max_days")
        if days is None:
            delivery_errors.append(f"{item.item_id}: delivery time unknown")
        else:
            limit = deadline_days if deadline_days is not None else 14
            if int(days) > limit:
                delivery_errors.append(
                    f"{item.item_id}: delivery {days} days exceeds {limit} days"
                )
    checks["delivery"] = {
        "ok": not delivery_errors,
        "detail": "delivery regions and timing are valid" if not delivery_errors else "; ".join(delivery_errors),
    }

    if not strict:
        for value in checks.values():
            if not value["ok"]:
                value["detail"] = f"warning only: {value['detail']}"
        return {"ok": True, "checks": checks}

    return {"ok": all(value["ok"] for value in checks.values()), "checks": checks}


def overall_guarantees(checked_outfits: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not checked_outfits:
        return {
            name: {"ok": False, "detail": "no outfit passed"}
            for name in ("budget", "fit", "availability", "price_integrity", "delivery")
        }
    names = ("budget", "fit", "availability", "price_integrity", "delivery")
    return {
        name: {
            "ok": all(outfit["guarantees"]["checks"][name]["ok"] for outfit in checked_outfits),
            "detail": "; ".join(
                outfit["guarantees"]["checks"][name]["detail"] for outfit in checked_outfits
            ),
        }
        for name in names
    }
