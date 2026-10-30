from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import httpx

from ..config import Settings
from ..models import (
    Item,
    OutfitDraft,
    OutfitSelection,
    SelectedItem,
    StylistRequest,
)
from .images import image_data_urls


PROMPT_DIR = Path(__file__).resolve().parents[2] / "prompts"


def load_prompt(name: str) -> str:
    path = PROMPT_DIR / name
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def _strip_json_fences(text: str) -> str:
    text = text.strip()
    match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if match:
        text = match.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    return text


class GeminiClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        base = settings.gemini_base_url.rstrip("/")
        self.url = base if base.endswith("/chat/completions") else f"{base}/chat/completions"

    def chat(self, messages: list[dict[str, Any]], json_mode: bool = True) -> str:
        if not self.settings.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY/ZAI_API_KEY is not configured")
        payload: dict[str, Any] = {
            "model": self.settings.gemini_model,
            "messages": messages,
            "temperature": self.settings.model_temperature,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        headers = {
            "Authorization": f"Bearer {self.settings.gemini_api_key}",
            "Content-Type": "application/json",
        }
        with httpx.Client(timeout=self.settings.request_timeout_seconds) as client:
            response = None
            for attempt in range(3):
                response = client.post(self.url, headers=headers, json=payload)
                if response.status_code == 400 and json_mode:
                    payload.pop("response_format", None)
                    response = client.post(self.url, headers=headers, json=payload)
                if response.status_code < 500 and response.status_code != 429:
                    break
                time.sleep(1.5 * (attempt + 1))
            assert response is not None
            response.raise_for_status()
            data = response.json()
        message = data["choices"][0]["message"]["content"]
        if isinstance(message, list):
            message = "".join(str(part.get("text", "")) for part in message if isinstance(part, dict))
        if not isinstance(message, str) or not message.strip():
            raise RuntimeError("Gemini returned an empty message")
        return message


def _catalog_text(request: StylistRequest, items: list[Item]) -> str:
    shops = {shop.shop_id: shop for shop in request.shops}
    lines = [
        f"Customer budget: {request.customer.budget.amount:.2f} {request.customer.budget.currency}",
        f"Desired number of looks (1-5): {request.customer.outfit_count}",
        f"Style directions (max 5): {', '.join(request.customer.style)}",
        f"Fit: {', '.join(request.customer.fit) or 'not specified'}",
        f"Fit description: {request.customer.fit_description or 'not provided'}",
        f"Measurements (cm): {json.dumps(request.customer.measurements_cm, ensure_ascii=False)}",
        f"Sizes: {json.dumps(request.customer.sizes, ensure_ascii=False)}",
        f"Required layers: {', '.join(request.required_layers)}",
        "",
        "Catalogue:",
    ]
    for item in items:
        shop = shops.get(item.shop_id)
        stock_sizes = [size.label for size in item.sizes if size.in_stock is not False]
        lines.append(
            "\n".join(
                [
                    f"- item_id: {item.item_id}",
                    f"  title: {item.title}",
                    f"  brand: {item.brand or 'unknown'}",
                    f"  shop: {shop.name if shop else item.shop_id}",
                    f"  slot: {item.slot}",
                    f"  price: {item.price.amount:.2f} {item.price.currency}",
                    f"  availability: {item.availability}",
                    f"  sizes: {', '.join(stock_sizes) or 'unknown'}",
                    f"  colors: {json.dumps(item.colors, ensure_ascii=False)}",
                    f"  materials: {', '.join(item.materials)}",
                    f"  description: {item.description[:500]}",
                    f"  fit: {item.fit_description or ''}",
                ]
            )
        )
    return "\n".join(lines)


def _mock_selection(request: StylistRequest) -> OutfitSelection:
    grouped: dict[str, list[Item]] = {}
    for item in request.items:
        grouped.setdefault(item.slot, []).append(item)
    for layer in grouped:
        grouped[layer].sort(
            key=lambda item: (
                item.availability == "sold_out",
                item.price.amount,
                item.item_id,
            )
        )
    outfits: list[OutfitDraft] = []
    style_names = request.customer.style or ["minimal"]
    for index in range(min(request.customer.outfit_count, 5)):
        chosen: list[SelectedItem] = []
        used: set[str] = set()
        for layer_index, layer in enumerate(request.required_layers):
            candidates = [
                item
                for item in grouped.get(layer, [])
                if item.item_id not in used and _has_customer_size(item, request, layer)
            ]
            if candidates:
                offset = (index + layer_index) % len(candidates)
                candidates = candidates[offset:] + candidates[:offset]
            candidate = candidates[0] if candidates else None
            if candidate is None:
                continue
            size = _pick_size(candidate, request, layer)
            chosen.append(SelectedItem(item_id=candidate.item_id, size=size, layer=layer))
            used.add(candidate.item_id)
        if not chosen:
            continue
        present_layers = {item.layer for item in chosen}
        if not set(request.required_layers).issubset(present_layers):
            continue
        style = style_names[index % len(style_names)]
        outfits.append(
            OutfitDraft(
                name=f"{style.title()} composition",
                items=chosen,
                rationale=(
                    f"A coherent {style} look built from {len(chosen)} layers, "
                    "balanced across the requested palette and weather context."
                ),
                fit_notes=(
                    request.customer.fit_description
                    or "Use the selected sizes; adjust hems and shoulder seams during tailoring."
                ),
                confidence=0.82,
            )
        )
    return OutfitSelection(outfits=outfits)


def _has_customer_size(item: Item, request: StylistRequest, layer: str) -> bool:
    preferred = request.customer.sizes.get(layer) or request.customer.sizes.get(item.slot)
    if not preferred or not item.sizes:
        return True
    return any(
        size.label.lower() == preferred.lower() and size.in_stock is not False
        for size in item.sizes
    )


def _pick_size(item: Item, request: StylistRequest, layer: str) -> str | None:
    preferred = request.customer.sizes.get(layer) or request.customer.sizes.get(item.slot)
    available = [size.label for size in item.sizes if size.in_stock is not False]
    if preferred and (not item.sizes or preferred in available):
        return preferred
    if preferred and item.sizes:
        return None
    if available:
        return available[0]
    if len(item.sizes) == 1:
        return item.sizes[0].label
    return preferred


def select_outfits(
    request: StylistRequest,
    feedback: list[str] | None = None,
    settings: Settings | None = None,
) -> OutfitSelection:
    settings = settings or Settings.from_env()
    feedback = feedback or []
    if settings.llm_mode == "mock" or not settings.gemini_api_key:
        return _mock_selection(request)
    try:
        return _live_selection(request, feedback, settings)
    except Exception as exc:  # keep the demo alive if the model is temporarily unavailable
        request.warnings.append(
            {
                "code": "LLM_FALLBACK",
                "message": f"Gemini selection failed; deterministic fallback used: {exc}",
            }
        )
        return _mock_selection(request)


def _image_sample(items: list[Item], request: StylistRequest, limit: int) -> list[Item]:
    """Spread the image budget across layers instead of taking catalogue order."""
    grouped: dict[str, list[Item]] = {}
    for item in items:
        grouped.setdefault(item.slot, []).append(item)
    order = [layer for layer in request.required_layers if layer in grouped]
    order.extend(layer for layer in grouped if layer not in order)
    selected: list[Item] = []
    while len(selected) < limit:
        added = False
        for layer in order:
            if grouped[layer]:
                selected.append(grouped[layer].pop(0))
                added = True
                if len(selected) >= limit:
                    break
        if not added:
            break
    return selected


def _live_selection(
    request: StylistRequest,
    feedback: list[str],
    settings: Settings,
) -> OutfitSelection:
    items = [item for item in request.items if item.availability != "sold_out"]
    if not items:
        items = list(request.items)
    image_items = _image_sample(list(items), request, settings.max_images)
    images = image_data_urls(
        image_items,
        settings,
        limit=settings.max_images,
        max_side=settings.image_max_side,
    )
    system_prompt = "\n\n".join(
        part
        for part in (
            load_prompt("global.md"),
            load_prompt("stylist.md"),
        )
        if part
    )
    user_text = _catalog_text(request, items)
    if feedback:
        user_text += "\n\nPrevious attempt failed these checks:\n- " + "\n- ".join(feedback)
    user_text += (
        "\n\nReturn one JSON object with an `outfits` array. "
        "Every outfit must contain exactly one item per required layer. "
        "Use only item_id values from the catalogue. Do not write URLs or prices."
    )
    content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    content.extend(
        {"type": "image_url", "image_url": {"url": image["data_url"]}}
        for image in images
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": content},
    ]
    client = GeminiClient(settings)
    raw = client.chat(messages, json_mode=True)
    try:
        parsed = json.loads(_strip_json_fences(raw))
        selection = OutfitSelection.model_validate(parsed)
    except Exception as exc:
        repair = client.chat(
            [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": (
                        "Your previous answer was not valid JSON for the required schema. "
                        f"Error: {exc}. Return only the JSON object now."
                    ),
                },
            ],
            json_mode=True,
        )
        selection = OutfitSelection.model_validate(json.loads(_strip_json_fences(repair)))
    if not selection.outfits:
        raise RuntimeError("Gemini returned no outfits")
    return selection
