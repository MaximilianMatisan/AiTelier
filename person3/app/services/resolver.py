from __future__ import annotations

from typing import Any

from ..models import Item, OutfitDraft, OutfitSelection, StylistRequest


LAYER_ORDER = ["base", "mid", "outer", "bottom", "shoes", "accessory", "other"]
LAYER_LABELS = {
    "base": "Base",
    "mid": "Mid",
    "outer": "Outer",
    "bottom": "Bottom",
    "shoes": "Shoes",
    "accessory": "Accessory",
    "other": "Other",
}


def _size_for_item(item: Item, requested: str | None, request: StylistRequest, layer: str) -> str:
    customer_size = request.customer.sizes.get(layer) or request.customer.sizes.get(item.slot)
    preferred = customer_size or requested
    if preferred:
        matching = next((size for size in item.sizes if size.label.lower() == preferred.lower()), None)
        if item.sizes and not matching:
            raise ValueError(f"{item.item_id}: customer size {preferred} is not offered")
        if matching and matching.in_stock is False:
            raise ValueError(f"{item.item_id}: size {preferred} is not in stock")
        return preferred
    available = [size.label for size in item.sizes if size.in_stock is not False]
    if available:
        return available[0]
    if len(item.sizes) == 1:
        return item.sizes[0].label
    raise ValueError(f"{item.item_id}: no usable size")


def _image_for_item(item: Item) -> str | None:
    for image in item.images:
        if image.role == "front":
            return image.url
    return item.images[0].url if item.images else None


def _shipping_for_outfit(items: list[Item], request: StylistRequest) -> float:
    shops = {shop.shop_id: shop for shop in request.shops}
    per_shop: dict[str, float] = {}
    for item in items:
        amount = None
        if item.shipping and item.shipping.get("amount") is not None:
            amount = float(item.shipping["amount"])
        else:
            shop = shops.get(item.shop_id)
            shipping = shop.shipping if shop else None
            if shipping:
                amount = float(shipping.get("default_amount", 0.0))
        if amount is not None:
            per_shop[item.shop_id] = max(per_shop.get(item.shop_id, 0.0), amount)
    return round(sum(per_shop.values()), 2)


def resolve_selection(
    selection: OutfitSelection,
    request: StylistRequest,
) -> tuple[list[dict[str, Any]], list[str]]:
    by_id = {item.item_id: item for item in request.items}
    outfits: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, draft in enumerate(selection.outfits):
        try:
            chosen: list[dict[str, Any]] = []
            used: set[str] = set()
            for selected in draft.items:
                item = by_id.get(selected.item_id)
                if item is None:
                    raise ValueError(f"unknown item_id {selected.item_id}")
                if item.item_id in used:
                    raise ValueError(f"duplicate item {item.item_id}")
                if item.availability == "sold_out":
                    raise ValueError(f"item {item.item_id} is sold out")
                layer = item.slot if item.slot in LAYER_ORDER else (selected.layer or "other")
                if layer == "other" and selected.layer and selected.layer in LAYER_ORDER:
                    layer = selected.layer
                size = _size_for_item(item, selected.size, request, layer)
                used.add(item.item_id)
                image_url = _image_for_item(item)
                if not image_url:
                    raise ValueError(f"item {item.item_id} has no usable image")
                chosen.append(
                    {
                        "item_id": item.item_id,
                        "title": item.title,
                        "brand": item.brand,
                        "layer": layer,
                        "layer_label": LAYER_LABELS.get(layer, layer.title()),
                        "size": size,
                        "price": {"amount": item.price.amount, "currency": item.price.currency},
                        "product_url": item.product_url,
                        "image_url": image_url,
                        "description": item.description,
                        "fit_description": item.fit_description,
                        "colors": item.colors,
                        "shipping": item.shipping,
                    }
                )
            chosen.sort(key=lambda value: LAYER_ORDER.index(value["layer"]))
            present = {value["layer"] for value in chosen}
            missing = [layer for layer in request.required_layers if layer not in present]
            if missing:
                raise ValueError(f"missing required layers: {', '.join(missing)}")
            if not chosen:
                raise ValueError("empty outfit")
            item_total = round(sum(value["price"]["amount"] for value in chosen), 2)
            shipping = _shipping_for_outfit(
                [by_id[value["item_id"]] for value in chosen],
                request,
            )
            palette: list[str] = []
            for value in chosen:
                for color in value["colors"]:
                    if color.get("hex") and color["hex"] not in palette:
                        palette.append(color["hex"])
            outfits.append(
                {
                    "outfit_id": f"look-{index + 1}",
                    "name": draft.name,
                    "style_blend": request.customer.style[:5],
                    "item_ids": [value["item_id"] for value in chosen],
                    "items": chosen,
                    "layers": [
                        {
                            "layer": value["layer"],
                            "label": value["layer_label"],
                            "item_id": value["item_id"],
                            "size": value["size"],
                        }
                        for value in chosen
                    ],
                    "totals": {
                        "items": item_total,
                        "shipping": shipping,
                        "grand_total": round(item_total + shipping, 2),
                        "currency": request.customer.budget.currency,
                    },
                    "rationale": draft.rationale,
                    "fit_notes": draft.fit_notes,
                    "confidence": draft.confidence,
                    "color_palette": palette,
                }
            )
        except ValueError as exc:
            errors.append(str(exc))
    return outfits, errors
