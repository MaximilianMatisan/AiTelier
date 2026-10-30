from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .graph import (
    EditRejected,
    candidates_for_layer,
    catalogue_items,
    edit_outfit,
    run_style_debug,
)
from .models import ContractError


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    settings.static_dir.mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="AiTelier Person 3 Stylist", version="1.0")
    app.state.settings = settings
    app.state.results: dict[str, dict[str, Any]] = {}
    app.state.sessions: dict[str, dict[str, Any]] = {}
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.mount(
        "/artifacts",
        StaticFiles(directory=str(settings.artifact_dir)),
        name="artifacts",
    )
    app.mount(
        "/static",
        StaticFiles(directory=str(settings.static_dir)),
        name="static",
    )

    @app.get("/", include_in_schema=False)
    def home():
        index = settings.web_dir / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="web UI is not installed")
        return FileResponse(index, media_type="text/html")

    @app.get("/gallery/{task_id}", include_in_schema=False)
    def gallery(task_id: str):
        if task_id not in app.state.sessions:
            raise HTTPException(status_code=404, detail="task not found")
        page = settings.web_dir / "gallery.html"
        if not page.is_file():
            raise HTTPException(status_code=404, detail="gallery UI is not installed")
        return FileResponse(page, media_type="text/html")

    @app.get("/healthz")
    def healthz():
        return {
            "ok": True,
            "service": "aitelier-person3",
            "llm_mode": settings.llm_mode,
            "ui": (settings.web_dir / "index.html").is_file(),
            "demo_catalog": settings.demo_catalog_path.is_file(),
        }

    @app.get("/v1/demo/input")
    def demo_input(kind: str = Query(default="synthetic", pattern="^(synthetic|real)$")):
        try:
            if kind == "real":
                if not settings.demo_catalog_path.is_file():
                    raise HTTPException(
                        status_code=404,
                        detail=(
                            "Real catalogue demo is not mounted. Set DEMO_CATALOG_PATH "
                            "or upload a full Person 3 input JSON."
                        ),
                    )
                raw = json.loads(
                    settings.demo_catalog_path.read_text(encoding="utf-8")
                )
                customer_path = settings.static_dir / "customer.catalog.json"
                if not customer_path.is_file():
                    raise HTTPException(
                        status_code=404,
                        detail="customer.catalog.json is not installed",
                    )
                customer = json.loads(customer_path.read_text(encoding="utf-8"))
                raw.update({key: value for key, value in customer.items() if key != "customer"})
                raw["customer"] = customer["customer"]
                return JSONResponse(raw)
            path = settings.static_dir / "input.json"
            if not path.is_file():
                raise HTTPException(status_code=404, detail="demo input is not installed")
            return JSONResponse(json.loads(path.read_text(encoding="utf-8")))
        except HTTPException:
            raise
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.get("/v1/demo/customer")
    def demo_customer():
        path = settings.static_dir / "customer.catalog.json"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="demo customer is not installed")
        return JSONResponse(json.loads(path.read_text(encoding="utf-8")))

    @app.post("/v1/style")
    def style(payload: dict):
        try:
            state = run_style_debug(payload, app.state.settings)
        except ContractError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        result = state["result"]
        task_id = result["task_id"]
        app.state.results[task_id] = result
        app.state.sessions[task_id] = {
            "request": state["request"],
            "result": result,
        }
        return JSONResponse(result)

    @app.get("/v1/style/{task_id}")
    def get_style(task_id: str):
        result = app.state.results.get(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="task not found")
        return JSONResponse(result)

    @app.get("/v1/style/{task_id}/a2ui")
    def get_a2ui(task_id: str):
        result = app.state.results.get(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="task not found")
        return JSONResponse(result["a2ui"]["messages"])

    @app.get("/v1/style/{task_id}/catalogue")
    def get_catalogue(task_id: str):
        session = app.state.sessions.get(task_id)
        if not session:
            raise HTTPException(status_code=404, detail="task not found")
        return JSONResponse({"items": catalogue_items(session["request"])})

    @app.get("/v1/style/{task_id}/candidates")
    def get_candidates(
        task_id: str,
        layer: str = Query(..., min_length=2, max_length=20),
    ):
        session = app.state.sessions.get(task_id)
        if not session:
            raise HTTPException(status_code=404, detail="task not found")
        try:
            items = candidates_for_layer(session["request"], layer)
        except ContractError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return JSONResponse({"layer": layer, "items": items})

    @app.post("/v1/style/{task_id}/outfits/{outfit_id}/parts")
    def replace_part(task_id: str, outfit_id: str, payload: dict):
        session = app.state.sessions.get(task_id)
        if not session:
            raise HTTPException(status_code=404, detail="task not found")
        replacements = payload.get("replacements")
        if not isinstance(replacements, list):
            replacements = [payload]
        try:
            result = edit_outfit(
                session["request"],
                session["result"],
                app.state.settings,
                outfit_id,
                replacements,
            )
        except EditRejected as exc:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": str(exc),
                    "guarantees": exc.guarantees,
                },
            ) from exc
        except ContractError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        session["result"] = result
        app.state.results[task_id] = result
        return JSONResponse(result)

    return app


app = create_app()
