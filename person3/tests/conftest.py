from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.config import Settings
from app.graph import run_style


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"


def load_input() -> dict:
    return json.loads((FIXTURES / "input.json").read_text(encoding="utf-8"))


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = {
        "gemini_api_key": "",
        "gemini_base_url": "",
        "gemini_model": "",
        "gemini_image_model": "",
        "gemini_image_base_url": "",
        "llm_mode": "mock",
        "live_check_mode": "snapshot",
        "person1_refresh_url": "",
        "artifact_dir": tmp_path / "artifacts",
        "artifact_base_url": "http://127.0.0.1:21951",
        "static_dir": FIXTURES,
        "fixture_image_dir": FIXTURES / "images",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings(tmp_path):
    return make_settings(tmp_path)


@pytest.fixture
def raw_input():
    return load_input()


@pytest.fixture(scope="session")
def style_result(tmp_path_factory):
    path = tmp_path_factory.mktemp("artifacts")
    settings = make_settings(path)
    return run_style(load_input(), settings), settings
