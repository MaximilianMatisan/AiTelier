from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .graph import run_style
from .models import ContractError


RESULTS: dict[str, dict] = {}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    settings.static_dir.mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="AiTelier Person 3 Stylist", version="1.0")
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:21951", "http://localhost:21951"],
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

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "service": "aitelier-person3"}

    @app.post("/v1/style")
    def style(payload: dict):
        try:
            result = run_style(payload, app.state.settings)
        except ContractError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        RESULTS[result["task_id"]] = result
        return JSONResponse(result)

    @app.get("/v1/style/{task_id}")
    def get_style(task_id: str):
        result = RESULTS.get(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="task not found")
        return JSONResponse(result)

    @app.get("/v1/style/{task_id}/a2ui")
    def get_a2ui(task_id: str):
        result = RESULTS.get(task_id)
        if not result:
            raise HTTPException(status_code=404, detail="task not found")
        return JSONResponse(result["a2ui"]["messages"])

    return app


app = create_app()
