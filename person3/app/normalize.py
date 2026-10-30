from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse
from uuid import uuid4

from .config import Settings
from .models import (
    ContractError,
    Customer,
    Guarantee,
    ImageRef,
    Item,
    Money,
    Shop,
    SizeOption,
    StylistRequest,
)


ALLOWED_LAYERS = {"base", "mid", "outer", "bottom", "shoes", "accessory", "other"}
REQUIRED_LAYERS = ("base", "mid", "outer", "bottom", "shoes")
CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "CHF": "CHF"}
CURRENCY_CODES = {"EUR", "USD", "GBP", "CHF", "JPY", "SEK", "DKK", "PLN"}
MEASUREMENT_ALIASES = {
    "bust": "chest",
    "chest": "chest",
    "shoulder": "shoulder",
    "shoulder_width": "shoulder",
    "waist": "waist",
    "hip": "hip",
    "seat": "hip",
    "inseam": "inseam",
    "leg_length": "inseam",
    "sleeve": "sleeve",
    "sleeve_length": "sleeve",
    "neck": "neck",
    "height": "height",
}
SIZE_KEY_ALIASES = {
    "top": "base",
    "shirt": "base",
    "tshirt": "base",
    "t-shirt": "base",
    "sweater": "mid",
    "knit": "mid",
    "jacket": "outer",
    "coat": "outer",
    "outerwear": "outer",
    "bottom": "bottom",
    "trousers": "bottom",
    "pants": "bottom",
    "shoes": "shoes",
    "shoe": "shoes",
    "boots": "shoes",
    "accessory": "accessory",
}


def _warning(
    warnings: list[dict[str, str]],
    code: str,
    message: str,
    item_id: str | None = None,
) -> None:
    entry = {"code": code, "message": message}
    if item_id:
        entry["item_id"] = item_id
    warnings.append(entry)


def _clean_text(value: Any, max_chars: int = 2000) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        text = "\n".join(str(v) for v in value if v is not None)
    elif isinstance(value, dict):
        parts: list[str] = []
        for key in ("summary", "description", "details"):
            if value.get(key):
                parts.append(str(value[key]))
        bullets = value.get("bullets")
        if isinstance(bullets, list):
            parts.extend(str(v) for v in bullets)
        if value.get("care"):
            parts.append(f"Care: {value['care']}")
        text = "\n".join(parts)
    else:
        text = str(value)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:max_chars]


def _parse_currency(value: Any) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    upper = text.upper()
    for code in CURRENCY_CODES:
        if code in upper:
            return code
    for symbol, code in CURRENCY_SYMBOLS.items():
        if symbol in text:
            return code
    return None


def _parse_amount(value: Any) -> float:
    text = str(value).replace("\u00a0", " ").strip()
    match = re.search(r"\d[\d.,\s]*", text)
    if not match:
        raise ContractError(f"Cannot parse price: {value!r}")
    raw = match.group(0).replace(" ", "")
    if "," in raw and "." in raw:
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif "," in raw:
        if raw.count(",") == 1 and len(raw.split(",")[1]) <= 2:
            raw = raw.replace(",", ".")
        else:
            raw = raw.replace(",", "")
    try:
        amount = float(raw)
    except ValueError as exc:
        raise ContractError(f"Cannot parse price: {value!r}") from exc
    if amount < 0:
        raise ContractError("Price cannot be negative")
    return round(amount, 2)


def parse_money(
    value: Any,
    default_currency: str,
    warnings: list[dict[str, str]],
    context: str,
) -> Money:
    currency = default_currency
    if isinstance(value, dict):
        amount_value = value.get("amount", value.get("value"))
        if amount_value is None:
            raise ContractError(f"{context}: price amount is missing")
        currency = _parse_currency(value.get("currency")) or currency
        amount = _parse_amount(amount_value)
    else:
        currency = _parse_currency(value) or currency
        amount = _parse_amount(value)
    if not currency:
        currency = "EUR"
        _warning(warnings, "CURRENCY_ASSUMED", f"{context}: currency assumed EUR")
    return Money(amount=amount, currency=currency.upper())


def _parse_measurements(value: Any, unit: str, warnings: list[dict[str, str]]) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key).strip().lower()
        key_unit = unit
        if key.endswith("_cm"):
            key = key[:-3]
            key_unit = "cm"
        elif key.endswith("_in"):
            key = key[:-3]
            key_unit = "in"
        key = MEASUREMENT_ALIASES.get(key, key)
        if key not in MEASUREMENT_ALIASES.values():
            continue
        try:
            number = float(str(raw_value).replace(",", ".").strip())
        except (TypeError, ValueError):
            continue
        if key_unit == "in":
            number *= 2.54
        result[key] = round(number, 1)
    if result and unit == "cm":
        if not any(str(k).endswith(("_cm", "_in")) for k in value):
            _warning(
                warnings,
                "MEASUREMENT_UNIT_ASSUMED",
                "plain measurement values treated as centimetres",
            )
    return result


def _parse_customer_sizes(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, str):
        return {"base": value}
    if isinstance(value, dict):
        result: dict[str, str] = {}
        for key, raw in value.items():
            canonical = SIZE_KEY_ALIASES.get(str(key).lower(), str(key).lower())
            if isinstance(raw, dict):
                raw = raw.get("label") or raw.get("size")
            if raw is not None:
                result[canonical] = str(raw)
        return result
    if isinstance(value, list):
        result: dict[str, str] = {}
        default_slots = ["base", "bottom", "shoes"]
        for index, entry in enumerate(value):
            if isinstance(entry, dict):
                label = entry.get("label") or entry.get("size")
                slot = entry.get("slot") or entry.get("layer")
                if label and slot:
                    result[SIZE_KEY_ALIASES.get(str(slot).lower(), str(slot).lower())] = str(label)
            elif index < len(default_slots):
                result[default_slots[index]] = str(entry)
        return result
    return {}


def _parse_item_sizes(value: Any) -> list[SizeOption]:
    options: list[SizeOption] = []
    if value is None:
        return options
    if isinstance(value, (str, int, float)):
        return [SizeOption(label=str(value), in_stock=None)]
    if isinstance(value, dict):
        if "label" in value or "size" in value:
            value = [value]
        else:
            for label, raw in value.items():
                if isinstance(raw, dict):
                    options.append(
                        SizeOption(
                            label=str(raw.get("label", label)),
                            in_stock=raw.get("in_stock", raw.get("available")),
                            measurements_cm=_normalize_size_measurements(
                                raw.get("measurements_cm") or raw.get("measurements")
                            ),
                        )
                    )
                else:
                    options.append(SizeOption(label=str(label), in_stock=raw if isinstance(raw, bool) else None))
            return options
    if isinstance(value, list):
        for entry in value:
            if isinstance(entry, dict):
                label = entry.get("label") or entry.get("size") or entry.get("name")
                if label is None:
                    continue
                options.append(
                    SizeOption(
                        label=str(label),
                        in_stock=entry.get("in_stock", entry.get("available")),
                        measurements_cm=_normalize_size_measurements(
                            entry.get("measurements_cm") or entry.get("measurements")
                        ),
                    )
                )
            else:
                options.append(SizeOption(label=str(entry), in_stock=None))
    return options


def _normalize_size_measurements(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for key, raw in value.items():
        canonical = MEASUREMENT_ALIASES.get(str(key).lower(), str(key).lower())
        try:
            result[canonical] = round(float(str(raw).replace(",", ".")), 1)
        except (TypeError, ValueError):
            continue
    return result


def _parse_availability(value: Any, warnings: list[dict[str, str]], item_id: str) -> str:
    if value is None or value == "":
        return "unknown"
    if isinstance(value, bool):
        return "in_stock" if value else "sold_out"
    if isinstance(value, dict):
        if value.get("in_stock") is not None:
            return "in_stock" if value["in_stock"] else "sold_out"
        if value.get("available") is not None:
            return "in_stock" if value["available"] else "sold_out"
        quantity = value.get("quantity", value.get("stock_quantity"))
        if isinstance(quantity, (int, float)):
            return "in_stock" if quantity > 0 else "sold_out"
        value = value.get("status")
    text = str(value).strip().lower()
    if text in {"in_stock", "instock", "available", "true", "yes"}:
        return "in_stock"
    if text in {"sold_out", "out_of_stock", "unavailable", "false", "no"}:
        return "sold_out"
    if text in {"preorder", "pre_order"}:
        return "preorder"
    _warning(warnings, "AVAILABILITY_UNKNOWN", f"unknown availability value {value!r}", item_id)
    return "unknown"


def _parse_images(
    value: Any,
    base_url: str | None,
    warnings: list[dict[str, str]],
    item_id: str,
) -> list[ImageRef]:
    entries: list[Any] = []
    if isinstance(value, str):
        entries = [value]
    elif isinstance(value, list):
        entries = value
    elif isinstance(value, dict):
        if value.get("url"):
            entries = [value]
        elif value.get("images"):
            entries = value["images"]
    images: list[ImageRef] = []
    roles = {"front", "back", "detail", "on_model", "flat_lay", "unknown"}
    for index, entry in enumerate(entries):
        role = "front" if index == 0 else "unknown"
        if isinstance(entry, str):
            url = entry
        elif isinstance(entry, dict):
            url = entry.get("url") or entry.get("src")
            role_value = str(entry.get("role", "unknown")).lower()
            if role_value in roles:
                role = role_value
        else:
            continue
        if not url:
            continue
        resolved = urljoin(base_url + "/" if base_url and not base_url.endswith("/") else base_url or "", str(url))
        parsed = urlparse(resolved)
        if parsed.scheme not in {"http", "https"}:
            _warning(warnings, "IMAGE_URL_INVALID", f"unsupported image URL {resolved!r}", item_id)
            continue
        if not any(existing.url == resolved for existing in images):
            images.append(ImageRef(url=resolved, role=role))
        if len(images) >= 8:
            break
    if not images:
        _warning(warnings, "MISSING_IMAGE", "item has no usable image", item_id)
    return images


def _parse_shipping(
    value: Any,
    default_currency: str,
    warnings: list[dict[str, str]],
    item_id: str,
) -> dict[str, Any] | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return {"amount": round(float(value), 2), "currency": default_currency}
    if isinstance(value, str):
        amount = _parse_amount(value)
        return {"amount": amount, "currency": _parse_currency(value) or default_currency}
    if isinstance(value, dict):
        result = dict(value)
        if "amount" in result:
            result["amount"] = _parse_amount(result["amount"])
        if not result.get("currency"):
            result["currency"] = default_currency
        return result
    _warning(warnings, "SHIPPING_UNKNOWN", "shipping value could not be parsed", item_id)
    return None


def classify_slot(category: str, explicit: str | None = None) -> str:
    if explicit and str(explicit).lower() in ALLOWED_LAYERS:
        return str(explicit).lower()
    text = str(category).lower()
    rules = [
        ("outer", ("coat", "jacket", "trench", "parka", "mantel", "overcoat", "blazer")),
        ("mid", ("sweater", "pullover", "knit", "cardigan", "hoodie", "sweatshirt")),
        ("base", ("t-shirt", "tshirt", "tee", "shirt", "blouse", "top", "polo", "henley")),
        ("bottom", ("trouser", "pant", "chino", "jean", "skirt", "short", "hose")),
        ("shoes", ("boot", "sneaker", "loafer", "shoe", "schuh", "derby", "oxford")),
        ("accessory", ("belt", "bag", "scarf", "hat", "watch", "tie", "cap")),
    ]
    for slot, needles in rules:
        if any(needle in text for needle in needles):
            return slot
    return "other"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "shop"


def _parse_expiry(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _parse_shop(
    raw: dict[str, Any],
    warnings: list[dict[str, str]],
) -> Shop | None:
    shop_id = str(raw.get("shop_id") or raw.get("id") or "").strip()
    name = str(raw.get("name") or raw.get("shop_name") or "").strip()
    if not shop_id and name:
        shop_id = _slug(name)
    if not shop_id or not name:
        return None
    base_url = raw.get("base_url") or raw.get("url")
    domain = raw.get("domain")
    if not domain and base_url:
        domain = urlparse(str(base_url)).hostname
    guarantee_raw = raw.get("guarantee")
    if guarantee_raw is None:
        guarantee_raw = raw.get("trust")
    if isinstance(guarantee_raw, bool):
        guarantee = Guarantee(status="guaranteed" if guarantee_raw else "failed")
    elif isinstance(guarantee_raw, dict):
        status = str(guarantee_raw.get("status") or "").lower()
        if not status:
            if guarantee_raw.get("trusted") is True or guarantee_raw.get("verified") is True:
                status = "guaranteed"
            elif guarantee_raw.get("trusted") is False or guarantee_raw.get("verified") is False:
                status = "failed"
        guarantee = Guarantee(
            status=status or "guaranteed",
            trust_score=guarantee_raw.get("trust_score") or guarantee_raw.get("score"),
            checked_at=guarantee_raw.get("checked_at"),
            expires_at=guarantee_raw.get("expires_at"),
            evidence=guarantee_raw.get("evidence") or {},
        )
    else:
        guarantee = Guarantee(status=str(guarantee_raw).lower() if guarantee_raw else "guaranteed")
    if guarantee.status not in {"guaranteed", "verified", "trusted"}:
        _warning(warnings, "SHOP_NOT_GUARANTEED", f"shop {shop_id} is not guaranteed")
        return None
    expiry = _parse_expiry(guarantee.expires_at)
    if expiry and expiry < datetime.now(timezone.utc):
        _warning(warnings, "SHOP_GUARANTEE_EXPIRED", f"shop {shop_id} guarantee expired")
        return None
    if not guarantee_raw:
        _warning(warnings, "GUARANTEE_ASSUMED", f"shop {shop_id} assumed guaranteed")
    return Shop(
        shop_id=shop_id,
        name=name,
        domain=str(domain) if domain else None,
        base_url=str(base_url) if base_url else None,
        guarantee=guarantee,
        shipping=raw.get("shipping") if isinstance(raw.get("shipping"), dict) else None,
    )


def _parse_colors(value: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    if isinstance(value, str):
        return [{"name": value}]
    if isinstance(value, dict):
        return [{"name": str(k), "hex": str(v)} for k, v in value.items()]
    if isinstance(value, list):
        for entry in value:
            if isinstance(entry, str):
                result.append({"name": entry})
            elif isinstance(entry, dict):
                name = entry.get("name") or entry.get("label") or entry.get("hex")
                if name:
                    item = {"name": str(name)}
                    if entry.get("hex"):
                        item["hex"] = str(entry["hex"])
                    result.append(item)
    return result


def _parse_materials(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(v) for v in value if v]
    return []


def _parse_style(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        return {"style_tags": [value]}
    if isinstance(value, list):
        return {"style_tags": [str(v) for v in value]}
    return {}


def normalize_request(raw: dict[str, Any], settings: Settings) -> StylistRequest:
    if not isinstance(raw, dict):
        raise ContractError("Request must be a JSON object")
    warnings: list[dict[str, str]] = []
    customer_raw = raw.get("customer")
    if not isinstance(customer_raw, dict):
        raise ContractError("customer is required")

    request_currency = (
        _parse_currency(raw.get("currency"))
        or _parse_currency(raw.get("options", {}).get("default_currency") if isinstance(raw.get("options"), dict) else None)
        or ""
    )
    if not request_currency:
        request_currency = "EUR"
        _warning(warnings, "CURRENCY_ASSUMED", "request currency assumed EUR")

    budget_raw = customer_raw.get("budget")
    if budget_raw is None:
        raise ContractError("customer.budget is required")
    budget = parse_money(budget_raw, request_currency, warnings, "customer.budget")
    if budget.currency != request_currency:
        request_currency = budget.currency

    style_raw = customer_raw.get("style", customer_raw.get("styles"))
    if isinstance(style_raw, str):
        styles = [style_raw]
    elif isinstance(style_raw, list):
        styles = [str(v) for v in style_raw if v]
    else:
        styles = []
        _warning(warnings, "STYLE_DEFAULTED", "customer.style missing; using minimal")
    if not styles:
        styles = ["minimal"]
    if len(styles) > 5:
        styles = styles[:5]
        _warning(warnings, "STYLE_TRUNCATED", "at most five style directions are used")
    deduped_styles: list[str] = []
    for style in styles:
        if style.lower() not in {s.lower() for s in deduped_styles}:
            deduped_styles.append(style)

    fit_raw = customer_raw.get("fit")
    if isinstance(fit_raw, str):
        fits = [fit_raw]
    elif isinstance(fit_raw, list):
        fits = [str(v) for v in fit_raw if v]
    else:
        fits = []
    measurements = _parse_measurements(
        customer_raw.get("measurements_cm")
        or customer_raw.get("measurements")
        or {},
        str(customer_raw.get("measurement_unit") or "cm").lower(),
        warnings,
    )
    sizes = _parse_customer_sizes(customer_raw.get("sizes"))
    customer = Customer(
        budget=budget,
        style=deduped_styles,
        fit=fits,
        fit_description=customer_raw.get("fit_description"),
        measurements_cm=measurements,
        sizes=sizes,
        item_count=customer_raw.get("item_count"),
        outfit_count=max(1, min(5, int(customer_raw.get("outfit_count") or 3))),
        gender=customer_raw.get("gender"),
        season=customer_raw.get("season"),
        climate=customer_raw.get("climate"),
        must_have=[str(v) for v in customer_raw.get("must_have", [])] if isinstance(customer_raw.get("must_have"), list) else [],
        avoid=[str(v) for v in customer_raw.get("avoid", [])] if isinstance(customer_raw.get("avoid"), list) else [],
        deadline=customer_raw.get("deadline"),
        photo=customer_raw.get("photo") or customer_raw.get("photo_url"),
    )

    shops: dict[str, Shop] = {}
    raw_shops = raw.get("shops") or []
    if isinstance(raw_shops, list):
        for raw_shop in raw_shops:
            if isinstance(raw_shop, dict):
                shop = _parse_shop(raw_shop, warnings)
                if shop:
                    shops[shop.shop_id] = shop

    items: list[Item] = []
    raw_items = raw.get("items") or []
    if not isinstance(raw_items, list):
        raise ContractError("items must be a list")
    for index, raw_item in enumerate(raw_items[: settings.max_items]):
        if not isinstance(raw_item, dict):
            continue
        item_id = str(raw_item.get("item_id") or raw_item.get("id") or "").strip()
        if not item_id:
            _warning(warnings, "ITEM_ID_MISSING", f"item at index {index} has no item_id")
            continue
        inline_shop = raw_item.get("shop")
        shop_id = str(raw_item.get("shop_id") or "").strip()
        if isinstance(inline_shop, dict):
            shop = _parse_shop(inline_shop, warnings)
            if shop:
                shops[shop.shop_id] = shop
                shop_id = shop_id or shop.shop_id
        if not shop_id:
            _warning(warnings, "SHOP_ID_MISSING", "item has no shop_id", item_id)
            continue
        shop = shops.get(shop_id)
        if not shop:
            _warning(warnings, "SHOP_UNKNOWN", f"unknown or unguaranteed shop {shop_id}", item_id)
            continue
        title = str(raw_item.get("title") or raw_item.get("name") or "").strip()
        category = str(raw_item.get("category") or raw_item.get("type") or "other").strip()
        product_url = str(raw_item.get("product_url") or raw_item.get("url") or "").strip()
        if not title or not product_url:
            _warning(warnings, "ITEM_INVALID", "item requires title and product_url", item_id)
            continue
        price_raw = raw_item.get("price")
        if price_raw is None:
            _warning(warnings, "ITEM_PRICE_MISSING", "item has no price", item_id)
            continue
        try:
            price = parse_money(price_raw, request_currency, warnings, f"item {item_id} price")
        except ContractError as exc:
            _warning(warnings, "ITEM_PRICE_INVALID", str(exc), item_id)
            continue
        if price.currency != customer.budget.currency:
            _warning(warnings, "CURRENCY_MISMATCH", f"item currency {price.currency} differs from budget", item_id)
            continue

        description = _clean_text(raw_item.get("description"))
        if not description:
            _warning(warnings, "MISSING_DESCRIPTION", "item has no description", item_id)
        style = _parse_style(raw_item.get("style"))
        fit_description = raw_item.get("fit_description")
        if not fit_description and isinstance(style.get("fit"), str):
            fit_description = style["fit"]
        slot = classify_slot(category, raw_item.get("layer") or raw_item.get("slot"))
        sizes = _parse_item_sizes(raw_item.get("sizes"))
        availability = _parse_availability(
            raw_item.get("availability", raw_item.get("available")),
            warnings,
            item_id,
        )
        quantity = raw_item.get("stock_quantity", raw_item.get("quantity"))
        if isinstance(quantity, (int, float)) and quantity <= 0:
            availability = "sold_out"
        shipping = _parse_shipping(raw_item.get("shipping"), price.currency, warnings, item_id)
        images = _parse_images(
            raw_item.get("images")
            or raw_item.get("image_urls")
            or raw_item.get("image_url")
            or raw_item.get("image"),
            shop.base_url,
            warnings,
            item_id,
        )
        items.append(
            Item(
                item_id=item_id,
                shop_id=shop_id,
                title=title,
                brand=str(raw_item.get("brand") or ""),
                category=category,
                slot=slot,  # type: ignore[arg-type]
                description=description,
                look_description=raw_item.get("look_description"),
                fit_description=str(fit_description) if fit_description else None,
                style=style,
                materials=_parse_materials(raw_item.get("materials") or raw_item.get("material")),
                colors=_parse_colors(raw_item.get("colors") or raw_item.get("color")),
                size_system=raw_item.get("size_system"),
                sizes=sizes,
                price=price,
                shipping=shipping,
                availability=availability,
                stock_quantity=int(quantity) if isinstance(quantity, (int, float)) else None,
                images=images,
                product_url=product_url,
                collected_at=raw_item.get("collected_at"),
                source=raw_item.get("source") if isinstance(raw_item.get("source"), dict) else {},
                raw=raw_item,
            )
        )

    if not shops:
        raise ContractError("No guaranteed shops in input")
    if not items:
        raise ContractError("No eligible items in input")

    options = raw.get("options") if isinstance(raw.get("options"), dict) else {}
    options.setdefault("fit_mode", "measurements" if measurements else "size_only")
    options.setdefault("strict_guarantees", True)
    options.setdefault("max_selection_retries", 1)

    request = StylistRequest(
        contract_version=str(raw.get("contract_version") or "1.0"),
        task_id=str(raw.get("task_id") or f"task-{uuid4().hex[:12]}"),
        currency=customer.budget.currency,
        locale=str(raw.get("locale") or "de-DE"),
        customer=customer,
        shops=list(shops.values()),
        items=items,
        options=options,
        metadata=raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {},
        warnings=warnings,
    )
    return request
