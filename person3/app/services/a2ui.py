from __future__ import annotations

from typing import Any


A2UI_VERSION = "v0.9.1"
CATALOG_ID = "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json"
ALLOWED_COMPONENTS = {
    "Text",
    "Image",
    "Icon",
    "Row",
    "Column",
    "List",
    "Card",
    "Tabs",
    "Divider",
    "Button",
}
FORBIDDEN_COMPONENTS = {"Video", "AudioPlayer", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput"}


def _price(value: dict[str, Any]) -> str:
    return f"{value['amount']:.2f} {value.get('currency', 'EUR')}"


def _guarantee_rows(outfit: dict[str, Any], prefix: str) -> tuple[list[str], list[dict[str, Any]]]:
    components: list[dict[str, Any]] = []
    children: list[str] = []
    labels = {
        "budget": "Budget",
        "fit": "Fit",
        "availability": "Availability",
        "price_integrity": "Price integrity",
        "delivery": "Delivery",
    }
    for index, (key, label) in enumerate(labels.items()):
        check = outfit["guarantees"]["checks"].get(key, {"ok": False, "detail": "missing"})
        icon_id = f"{prefix}_icon_{index}"
        text_id = f"{prefix}_text_{index}"
        row_id = f"{prefix}_row_{index}"
        components.extend(
            [
                {"id": row_id, "component": "Row", "children": [icon_id, text_id], "align": "center"},
                {
                    "id": icon_id,
                    "component": "Icon",
                    "name": "check" if check.get("ok") else "error",
                },
                {
                    "id": text_id,
                    "component": "Text",
                    "text": f"{label}: {'OK' if check.get('ok') else 'FAILED'} — {check.get('detail', '')}",
                    "variant": "caption",
                },
            ]
        )
        children.append(row_id)
    return children, components


def build_a2ui(
    result: dict[str, Any],
    artifact_base_url: str,
    surface_id: str,
) -> dict[str, Any]:
    base = artifact_base_url.rstrip("/")
    components: list[dict[str, Any]] = []
    gallery_children: list[str] = []

    components.append(
        {
            "id": "header",
            "component": "Text",
            "text": "AiTelier — Approved Looks",
            "variant": "h1",
        }
    )
    styles = ", ".join(result.get("style_blend", [])[:5]) or "minimal"
    components.append(
        {
            "id": "summary",
            "component": "Text",
            "text": f"Style blend: {styles} · Budget: {result.get('budget_label', '')}",
            "variant": "body",
        }
    )

    for outfit_index, outfit in enumerate(result.get("outfits", [])):
        card_id = f"outfit_{outfit_index}"
        body_id = f"outfit_{outfit_index}_body"
        gallery_children.append(card_id)
        components.append({"id": card_id, "component": "Card", "child": body_id})
        body_children: list[str] = []
        board = outfit.get("images", {}).get("board")
        if board:
            board_id = f"{body_id}_board"
            components.append(
                {
                    "id": board_id,
                    "component": "Image",
                    "url": f"{base}/artifacts/{board.lstrip('/')}",
                    "fit": "cover",
                    "variant": "largeFeature",
                    "description": f"{outfit.get('name', 'Outfit')} product board",
                }
            )
            body_children.append(board_id)
        name_id = f"{body_id}_name"
        components.append(
            {
                "id": name_id,
                "component": "Text",
                "text": outfit.get("name", "AiTelier look"),
                "variant": "h2",
            }
        )
        body_children.append(name_id)
        total_id = f"{body_id}_total"
        totals = outfit["totals"]
        components.append(
            {
                "id": total_id,
                "component": "Text",
                "text": (
                    f"Total: {totals['grand_total']:.2f} {totals['currency']} · "
                    f"{len(outfit.get('layers', []))} layers"
                ),
                "variant": "body",
            }
        )
        body_children.append(total_id)
        rationale_id = f"{body_id}_rationale"
        components.append(
            {
                "id": rationale_id,
                "component": "Text",
                "text": outfit.get("rationale", ""),
                "variant": "caption",
            }
        )
        body_children.append(rationale_id)

        tabs_id = f"{body_id}_tabs"
        tabs: list[dict[str, str]] = []
        for layer_index, value in enumerate(outfit.get("items", [])):
            tab_id = f"{body_id}_layer_{layer_index}"
            tabs.append(
                {
                    "title": f"{value.get('layer_label', value.get('layer', 'Layer'))} — {value.get('title', '')}",
                    "child": tab_id,
                }
            )
            layer_children: list[str] = []
            image_id = f"{tab_id}_image"
            components.append(
                {
                    "id": image_id,
                    "component": "Image",
                    "url": value.get("image_url", ""),
                    "fit": "contain",
                    "variant": "mediumFeature",
                    "description": value.get("title", "Garment"),
                }
            )
            layer_children.append(image_id)
            title_id = f"{tab_id}_title"
            components.append(
                {
                    "id": title_id,
                    "component": "Text",
                    "text": f"{value.get('brand', '')} {value.get('title', '')}".strip(),
                    "variant": "h3",
                }
            )
            layer_children.append(title_id)
            detail_id = f"{tab_id}_detail"
            components.append(
                {
                    "id": detail_id,
                    "component": "Text",
                    "text": f"Size {value.get('size', '—')} · {_price(value.get('price', {}))}",
                    "variant": "caption",
                }
            )
            layer_children.append(detail_id)
            link_text_id = f"{tab_id}_link_text"
            link_id = f"{tab_id}_link"
            components.extend(
                [
                    {"id": link_text_id, "component": "Text", "text": "Open product page"},
                    {
                        "id": link_id,
                        "component": "Button",
                        "variant": "borderless",
                        "child": link_text_id,
                        "action": {
                            "functionCall": {
                                "call": "openUrl",
                                "args": {"url": value.get("product_url", "")},
                            }
                        },
                    },
                ]
            )
            layer_children.append(link_id)
            components.append(
                {
                    "id": tab_id,
                    "component": "Column",
                    "children": layer_children,
                    "align": "start",
                }
            )
        if tabs:
            components.append({"id": tabs_id, "component": "Tabs", "tabs": tabs})
            body_children.append(tabs_id)

        guarantee_children, guarantee_components = _guarantee_rows(outfit, f"{body_id}_guarantees")
        components.extend(guarantee_components)
        guarantee_id = f"{body_id}_guarantees"
        components.append(
            {
                "id": guarantee_id,
                "component": "Column",
                "children": guarantee_children,
                "align": "start",
            }
        )
        body_children.append(guarantee_id)
        components.append(
            {
                "id": body_id,
                "component": "Column",
                "children": body_children,
                "align": "stretch",
            }
        )

    root_children = ["header", "summary"]
    if gallery_children:
        components.append(
            {
                "id": "gallery",
                "component": "List",
                "children": gallery_children,
                "direction": "vertical",
            }
        )
        root_children.append("gallery")
    lookbook = result.get("lookbook")
    if lookbook:
        components.append(
            {
                "id": "lookbook",
                "component": "Image",
                "url": f"{base}/artifacts/{lookbook.lstrip('/')}",
                "fit": "contain",
                "variant": "largeFeature",
                "description": "AiTelier lookbook",
            }
        )
        root_children.append("lookbook")

    decision = result.get("decision", {})
    components.append(
        {
            "id": "decision",
            "component": "Text",
            "text": (
                "Approved: all five guarantees passed."
                if decision.get("approved")
                else f"Refund recommended: {decision.get('reason', 'no outfit passed')}"
            ),
            "variant": "h3",
        }
    )
    root_children.append("decision")
    if result.get("refund"):
        refund = result["refund"]
        components.append(
            {
                "id": "refund",
                "component": "Text",
                "text": (
                    f"Refund: {refund.get('amount')} {refund.get('currency', 'ADA')} — "
                    "recommendation only, not executed by Person 3."
                ),
                "variant": "body",
            }
        )
        root_children.append("refund")
    if result.get("warnings"):
        components.append(
            {
                "id": "warnings",
                "component": "Text",
                "text": "Warnings: " + "; ".join(w.get("code", "warning") for w in result["warnings"]),
                "variant": "caption",
            }
        )
        root_children.append("warnings")

    components.append(
        {
            "id": "root",
            "component": "Column",
            "children": root_children,
            "align": "stretch",
        }
    )

    create_surface = {
        "version": A2UI_VERSION,
        "createSurface": {
            "surfaceId": surface_id,
            "catalogId": CATALOG_ID,
            "theme": {
                "primaryColor": "#1F2A44",
                "agentDisplayName": "AiTelier Stylist",
            },
            "sendDataModel": False,
        },
    }
    update_components = {
        "version": A2UI_VERSION,
        "updateComponents": {"surfaceId": surface_id, "components": components},
    }
    update_data_model = {
        "version": A2UI_VERSION,
        "updateDataModel": {
            "surfaceId": surface_id,
            "path": "/",
            "value": _data_model(result),
        },
    }
    messages = [create_surface, update_components, update_data_model]
    errors = validate_a2ui(messages)
    return {
        "version": A2UI_VERSION,
        "surface_id": surface_id,
        "catalog_id": CATALOG_ID,
        "theme": create_surface["createSurface"]["theme"],
        "messages": messages,
        "valid": not errors,
        "errors": errors,
        "fallback_markdown": result.get("markdown", ""),
    }


def _data_model(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": result.get("task_id"),
        "status": result.get("status"),
        "style_blend": result.get("style_blend", []),
        "outfits": result.get("outfits", []),
        "guarantees": result.get("guarantees", {}),
        "decision": result.get("decision", {}),
        "refund": result.get("refund"),
    }


def validate_a2ui(messages: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    if not isinstance(messages, list) or len(messages) < 2:
        return ["messages must contain createSurface and updateComponents"]
    create = messages[0].get("createSurface")
    if not create or not create.get("surfaceId") or not create.get("catalogId"):
        errors.append("createSurface requires surfaceId and catalogId")
        return errors
    surface_id = create["surfaceId"]
    components: list[dict[str, Any]] = []
    for message in messages[1:]:
        if "updateComponents" in message:
            if message["updateComponents"].get("surfaceId") != surface_id:
                errors.append("updateComponents surfaceId mismatch")
            components = message["updateComponents"].get("components", [])
    if not components:
        return errors + ["updateComponents has no components"]
    ids = [component.get("id") for component in components]
    if len(ids) != len(set(ids)):
        errors.append("component ids are not unique")
    if ids.count("root") != 1:
        errors.append("exactly one root component is required")
    known = set(ids)
    for component in components:
        component_type = component.get("component")
        if component_type in FORBIDDEN_COMPONENTS:
            errors.append(f"{component.get('id')}: component {component_type} is not allowed")
        if component_type not in ALLOWED_COMPONENTS:
            errors.append(f"{component.get('id')}: unsupported component {component_type}")
        refs: list[str] = []
        children = component.get("children")
        if isinstance(children, list):
            refs.extend(str(child) for child in children)
        if isinstance(component.get("child"), str):
            refs.append(component["child"])
        for tab in component.get("tabs", []):
            if isinstance(tab, dict) and tab.get("child"):
                refs.append(str(tab["child"]))
        for ref in refs:
            if ref not in known:
                errors.append(f"{component.get('id')}: missing child {ref}")
        if component_type == "Image":
            url = component.get("url")
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                errors.append(f"{component.get('id')}: image url must be absolute")
        if component_type == "Button":
            action = component.get("action", {})
            call = action.get("functionCall", {}).get("call")
            if call != "openUrl":
                errors.append(f"{component.get('id')}: only openUrl actions are allowed")
    return errors
