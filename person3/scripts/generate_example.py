from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from app.config import Settings
from app.graph import run_style


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"


def main() -> None:
    raw = json.loads((ROOT / "fixtures" / "input.json").read_text(encoding="utf-8"))
    settings = Settings.from_env()
    settings = Settings(
        gemini_api_key="",
        gemini_base_url="",
        gemini_model="",
        gemini_image_model="",
        gemini_image_base_url="",
        llm_mode="mock",
        live_check_mode="snapshot",
        person1_refresh_url="",
        artifact_dir=Path(os.getenv("EXAMPLE_ARTIFACT_DIR", str(ROOT / "artifacts"))),
        artifact_base_url=settings.artifact_base_url,
        static_dir=settings.static_dir,
        fixture_image_dir=settings.fixture_image_dir,
    )
    result = run_style(raw, settings)
    result["artifacts"]["directory"] = f"person3/artifacts/{result['task_id']}"
    EXAMPLES.mkdir(parents=True, exist_ok=True)
    for outfit in result.get("outfits", []):
        board = settings.artifact_dir / outfit["images"]["board"]
        if board.is_file():
            shutil.copyfile(board, EXAMPLES / board.name)
    if result.get("lookbook"):
        lookbook = settings.artifact_dir / result["lookbook"]
        if lookbook.is_file():
            shutil.copyfile(lookbook, EXAMPLES / lookbook.name)
    (EXAMPLES / "output.example.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"wrote {EXAMPLES / 'output.example.json'}")
    print(f"status={result['status']} outfits={len(result.get('outfits', []))}")


if __name__ == "__main__":
    main()
