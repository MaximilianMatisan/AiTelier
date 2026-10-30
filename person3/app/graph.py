from __future__ import annotations

from pathlib import Path
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .config import Settings
from .models import ContractError, StylistRequest
from .normalize import normalize_request
from .services.a2ui import build_a2ui
from .services.checks import check_outfit, live_check, overall_guarantees
from .services.llm import select_outfits
from .services.mannequin import compose_board, compose_lookbook
from .services.resolver import resolve_selection


class StylistState(TypedDict, total=False):
    raw: dict[str, Any]
    settings: Settings
    request: StylistRequest
    selection: Any
    outfits: list[dict[str, Any]]
    approved: list[dict[str, Any]]
    rejected: list[dict[str, Any]]
    live: dict[str, dict[str, Any]]
    feedback: list[str]
    attempt: int
    result: dict[str, Any]


def _normalize(state: StylistState) -> StylistState:
    request = normalize_request(state["raw"], state["settings"])
    return {"request": request, "attempt": 0, "feedback": []}


def _select(state: StylistState) -> StylistState:
    request = state["request"]
    selection = select_outfits(
        request,
        feedback=state.get("feedback", []),
        settings=state["settings"],
    )
    return {"selection": selection}


def _resolve(state: StylistState) -> StylistState:
    request = state["request"]
    outfits, errors = resolve_selection(state["selection"], request)
    return {"outfits": outfits, "feedback": errors}


def _final_check(state: StylistState) -> StylistState:
    request = state["request"]
    settings = state["settings"]
    live: dict[str, dict[str, Any]] = {}
    shops = {shop.shop_id: shop for shop in request.shops}
    for item in request.items:
        live[item.item_id] = live_check(item, settings, shops.get(item.shop_id))
    approved: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    feedback: list[str] = []
    for outfit in state.get("outfits", []):
        guarantee = check_outfit(outfit, request, live)
        outfit["guarantees"] = guarantee
        if guarantee["ok"]:
            approved.append(outfit)
        else:
            rejected.append(outfit)
            for key, value in guarantee["checks"].items():
                if not value["ok"]:
                    feedback.append(f"{outfit['outfit_id']} {key}: {value['detail']}")
    return {
        "live": live,
        "approved": approved,
        "rejected": rejected,
        "feedback": feedback or state.get("feedback", []),
    }


def _retry(state: StylistState) -> StylistState:
    return {"attempt": state.get("attempt", 0) + 1}


def _route_after_guarantees(state: StylistState) -> str:
    if state.get("approved"):
        return "compose"
    attempts = state.get("attempt", 0)
    request = state["request"]
    max_retries = int(request.options.get("max_selection_retries", 1))
    if attempts < max(0, min(2, max_retries)):
        return "retry"
    return "refund"


def _compose(state: StylistState) -> StylistState:
    request = state["request"]
    settings = state["settings"]
    approved = state.get("approved", [])
    task_dir = settings.artifact_dir / request.task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    board_files: list[str] = []
    for outfit in approved:
        filename = compose_board(outfit, request, settings, task_dir)
        outfit["images"] = {"board": f"{request.task_id}/{filename}"}
        board_files.append(filename)
    lookbook = compose_lookbook(board_files, task_dir)
    lookbook_path = f"{request.task_id}/{lookbook}" if lookbook else None
    guarantees = overall_guarantees(approved)
    result = {
        "contract_version": "1.0",
        "task_id": request.task_id,
        "status": "APPROVED" if approved else "REFUND",
        "style_blend": request.customer.style[:5],
        "budget_label": f"{request.customer.budget.amount:.2f} {request.customer.budget.currency}",
        "outfits": approved,
        "guarantees": guarantees,
        "decision": {
            "approved": bool(approved),
            "reason": None if approved else "No outfit passed all five guarantees",
        },
        "refund": None,
        "warnings": request.warnings,
        "lookbook": lookbook_path,
        "artifacts": {
            "directory": str(task_dir),
            "lookbook": lookbook_path,
        },
        "markdown": "",
    }
    result["markdown"] = render_markdown(result, request, settings.artifact_base_url)
    result["a2ui"] = build_a2ui(
        result,
        settings.artifact_base_url,
        f"aitelier-gallery-{request.task_id}",
    )
    return {"result": result}


def _refund(state: StylistState) -> StylistState:
    request = state["request"]
    settings = state["settings"]
    rejected = state.get("rejected", [])
    reason = "No outfit passed all five guarantees"
    if state.get("feedback"):
        reason = "; ".join(state["feedback"][:3])
    result = {
        "contract_version": "1.0",
        "task_id": request.task_id,
        "status": "REFUND",
        "style_blend": request.customer.style[:5],
        "budget_label": f"{request.customer.budget.amount:.2f} {request.customer.budget.currency}",
        "outfits": [],
        "guarantees": overall_guarantees([]),
        "decision": {"approved": False, "reason": reason},
        "refund": {"amount": 6, "currency": "ADA", "recommended": True, "executed": False},
        "warnings": request.warnings,
        "lookbook": None,
        "artifacts": {"directory": str(settings.artifact_dir / request.task_id)},
        "markdown": "",
    }
    result["markdown"] = render_markdown(result, request, settings.artifact_base_url)
    result["a2ui"] = build_a2ui(
        result,
        settings.artifact_base_url,
        f"aitelier-gallery-{request.task_id}",
    )
    return {"result": result}


def render_markdown(result: dict[str, Any], request: StylistRequest, artifact_base_url: str) -> str:
    lines = [
        f"# AiTelier result — {result['status']}",
        "",
        f"Task: `{result['task_id']}`",
        f"Style blend: {', '.join(request.customer.style[:5]) or 'minimal'}",
        f"Budget: {request.customer.budget.amount:.2f} {request.customer.budget.currency}",
        "",
    ]
    if result.get("refund"):
        lines.extend(
            [
                "## Refund recommendation",
                f"{result['refund']['amount']} {result['refund']['currency']} recommended; not executed by Person 3.",
                f"Reason: {result['decision']['reason']}",
                "",
            ]
        )
    for outfit in result.get("outfits", []):
        lines.extend(
            [
                f"## {outfit['name']}",
                f"Total: {outfit['totals']['grand_total']:.2f} {outfit['totals']['currency']}",
                "",
            ]
        )
        board = outfit.get("images", {}).get("board")
        if board:
            lines.append(
                f"![{outfit['name']} board]"
                f"({artifact_base_url.rstrip('/')}/artifacts/{board.lstrip('/')})"
            )
            lines.append("")
        for value in outfit["items"]:
            lines.append(
                f"- **{value['layer_label']}**: {value['brand']} {value['title']} — "
                f"size {value['size']} — {value['price']['amount']:.2f} {value['price']['currency']} — "
                f"[product]({value['product_url']})"
            )
        lines.extend(
            [
                "",
                f"_{outfit.get('rationale', '')}_",
                "",
                "Guarantees: " + ", ".join(
                    f"{key}={'OK' if check['ok'] else 'FAILED'}"
                    for key, check in outfit["guarantees"]["checks"].items()
                ),
                "",
            ]
        )
    if result.get("warnings"):
        lines.append("Warnings: " + "; ".join(w.get("code", "warning") for w in result["warnings"]))
        lines.append("")
    return "\n".join(lines)


def build_graph():
    graph = StateGraph(StylistState)
    graph.add_node("normalize", _normalize)
    graph.add_node("select", _select)
    graph.add_node("resolve", _resolve)
    graph.add_node("final_check", _final_check)
    graph.add_node("retry", _retry)
    graph.add_node("compose", _compose)
    graph.add_node("refund", _refund)
    graph.add_edge(START, "normalize")
    graph.add_edge("normalize", "select")
    graph.add_edge("select", "resolve")
    graph.add_edge("resolve", "final_check")
    graph.add_conditional_edges(
        "final_check",
        _route_after_guarantees,
        {"compose": "compose", "retry": "retry", "refund": "refund"},
    )
    graph.add_edge("retry", "select")
    graph.add_edge("compose", END)
    graph.add_edge("refund", END)
    return graph.compile()


_GRAPH = build_graph()


def run_style_debug(
    raw: dict[str, Any],
    settings: Settings | None = None,
) -> dict[str, Any]:
    settings = settings or Settings.from_env()
    return _GRAPH.invoke({"raw": raw, "settings": settings})


def run_style(raw: dict[str, Any], settings: Settings | None = None) -> dict[str, Any]:
    return run_style_debug(raw, settings)["result"]
