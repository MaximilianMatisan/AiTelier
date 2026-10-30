from __future__ import annotations

import os
from dataclasses import replace

import pytest

from app.config import Settings
from app.normalize import normalize_request
from app.services.llm import select_outfits
from .conftest import load_input


@pytest.mark.live
def test_live_gemini_returns_valid_selection():
    if os.getenv("RUN_LIVE_TESTS") != "1":
        pytest.skip("set RUN_LIVE_TESTS=1 to call Gemini")
    settings = Settings.from_env()
    if not settings.gemini_api_key:
        pytest.skip("Gemini API key is not configured")
    settings = replace(settings, llm_mode="gemini")
    request = normalize_request(load_input(), settings)
    selection = select_outfits(request, settings=settings)
    assert selection.outfits
    ids = {item.item_id for item in request.items}
    for outfit in selection.outfits:
        assert outfit.items
        assert all(item.item_id in ids for item in outfit.items)
