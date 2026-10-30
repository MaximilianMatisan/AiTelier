from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.config import Settings
from app.graph import run_style_debug


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Person 3 against the Person 1 catalogue envelope.")
    parser.add_argument("--catalog", required=True, help="catalog/cache/person3.input.json")
    parser.add_argument("--customer", required=True, help="customer brief + options")
    parser.add_argument("--out", required=True, help="directory for step JSON and result.json")
    parser.add_argument("--artifacts", default=None, help="artifact directory override")
    args = parser.parse_args()

    raw = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    customer = json.loads(Path(args.customer).read_text(encoding="utf-8"))
    raw.update({k: v for k, v in customer.items() if k != "customer"})
    raw["customer"] = customer["customer"]
    raw.setdefault("task_id", "aitelier-catalog-demo")

    settings = Settings.from_env()
    if args.artifacts:
        settings = Settings(
            gemini_api_key=settings.gemini_api_key,
            gemini_base_url=settings.gemini_base_url,
            gemini_model=settings.gemini_model,
            gemini_image_model=settings.gemini_image_model,
            gemini_image_base_url=settings.gemini_image_base_url,
            llm_mode=settings.llm_mode,
            live_check_mode=settings.live_check_mode,
            person1_refresh_url=settings.person1_refresh_url,
            artifact_dir=Path(args.artifacts),
            artifact_base_url=settings.artifact_base_url,
            static_dir=settings.static_dir,
            fixture_image_dir=settings.fixture_image_dir,
        )

    state = run_style_debug(raw, settings)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "01-input.json").write_text(json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "02-normalized.json").write_text(
        json.dumps(state["request"].model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (out / "03-selection.json").write_text(
        json.dumps(state["selection"].model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (out / "04-resolved.json").write_text(
        json.dumps(
            {"approved": state.get("approved", []), "rejected": state.get("rejected", [])},
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (out / "05-live-check.json").write_text(
        json.dumps(state.get("live", {}), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (out / "result.json").write_text(
        json.dumps(state["result"], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"wrote {out / 'result.json'}")
    print(f"status={state['result']['status']} outfits={len(state['result'].get('outfits', []))}")


if __name__ == "__main__":
    main()
