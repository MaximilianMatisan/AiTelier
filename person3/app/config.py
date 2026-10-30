from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str
    gemini_base_url: str
    gemini_model: str
    gemini_image_model: str
    gemini_image_base_url: str
    llm_mode: str
    live_check_mode: str
    person1_refresh_url: str
    artifact_dir: Path
    artifact_base_url: str
    static_dir: Path
    fixture_image_dir: Path
    web_dir: Path = BASE_DIR / "web"
    demo_catalog_path: Path = BASE_DIR.parent / "catalog" / "cache" / "person3.input.json"
    required_layers: tuple[str, ...] = ("base", "mid", "outer", "bottom", "shoes")
    max_items: int = 100
    max_images: int = 20
    image_max_side: int = 384
    image_max_bytes: int = 8 * 1024 * 1024
    allow_local_images: bool = True
    request_timeout_seconds: float = 90.0
    model_temperature: float = 0.4
    warnings: list[str] = field(default_factory=list)

    @classmethod
    def from_env(cls) -> "Settings":
        api_key = _env("GEMINI_API_KEY") or _env("ZAI_API_KEY")
        base_url = _env("GEMINI_BASE_URL") or _env("ZAI_BASE_URL")
        model = _env("GEMINI_MODEL") or _env("ZAI_MODEL")
        mode = _env("LLM_MODE") or ("auto" if api_key and base_url and model else "mock")
        artifact_dir = Path(_env("ARTIFACT_DIR", str(BASE_DIR / "artifacts")))
        static_dir = Path(_env("STATIC_DIR", str(BASE_DIR / "fixtures")))
        fixture_image_dir = Path(
            _env("FIXTURE_IMAGE_DIR", str(static_dir / "images"))
        )
        web_dir = Path(_env("WEB_DIR", str(BASE_DIR / "web")))
        demo_catalog_path = Path(
            _env(
                "DEMO_CATALOG_PATH",
                str(BASE_DIR.parent / "catalog" / "cache" / "person3.input.json"),
            )
        )
        return cls(
            gemini_api_key=api_key,
            gemini_base_url=base_url,
            gemini_model=model,
            gemini_image_model=_env("GEMINI_IMAGE_MODEL"),
            gemini_image_base_url=_env(
                "GEMINI_IMAGE_BASE_URL",
                "https://generativelanguage.googleapis.com/v1beta",
            ),
            llm_mode=mode,
            live_check_mode=_env("LIVE_CHECK_MODE", "snapshot"),
            person1_refresh_url=_env("PERSON1_REFRESH_URL"),
            artifact_dir=artifact_dir,
            artifact_base_url=_env(
                "ARTIFACT_BASE_URL", "http://127.0.0.1:21951"
            ).rstrip("/"),
            static_dir=static_dir,
            fixture_image_dir=fixture_image_dir,
            web_dir=web_dir,
            demo_catalog_path=demo_catalog_path,
            max_items=int(_env("MAX_ITEMS", "100")),
            max_images=int(_env("MAX_IMAGES", "20")),
            image_max_side=int(_env("IMAGE_MAX_SIDE", "384")),
            image_max_bytes=int(_env("IMAGE_MAX_BYTES", str(8 * 1024 * 1024))),
            allow_local_images=_env_bool("ALLOW_LOCAL_IMAGES", True),
            request_timeout_seconds=float(_env("REQUEST_TIMEOUT_SECONDS", "90")),
            model_temperature=float(_env("MODEL_TEMPERATURE", "0.4")),
        )

    def artifact_url(self, relative_path: str) -> str:
        return f"{self.artifact_base_url}/artifacts/{relative_path.lstrip('/')}"

    def image_url(self, relative_path: str) -> str:
        return f"{self.artifact_base_url}/static/{relative_path.lstrip('/')}"


def get_settings() -> Settings:
    return Settings.from_env()
