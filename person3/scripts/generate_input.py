from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.config import Settings
from app.normalize import normalize_request


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize a raw Person 2 payload into the Person 3 input contract.")
    parser.add_argument("--raw", required=True, help="raw shop/item payload")
    parser.add_argument("--customer", required=True, help="customer brief JSON")
    parser.add_argument("--out", required=True, help="output canonical input JSON")
    parser.add_argument("--task-id", default="aitelier-generated")
    args = parser.parse_args()

    raw = json.loads(Path(args.raw).read_text(encoding="utf-8"))
    customer = json.loads(Path(args.customer).read_text(encoding="utf-8"))
    raw["customer"] = customer
    raw.setdefault("task_id", args.task_id)
    request = normalize_request(raw, Settings.from_env())
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(request.model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"wrote {path} ({len(request.items)} items, {len(request.shops)} shops)")


if __name__ == "__main__":
    main()
