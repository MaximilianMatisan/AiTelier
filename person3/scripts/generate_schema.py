from __future__ import annotations

import json
from pathlib import Path

from app.models import StylistRequest


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    target = root / "schemas" / "input.schema.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(StylistRequest.model_json_schema(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
