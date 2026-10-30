from __future__ import annotations

import base64
import io
import ipaddress
import socket
from pathlib import Path
from urllib.parse import urlparse

import httpx
from PIL import Image, ImageDraw, ImageFont, ImageOps

from ..config import Settings


_CACHE: dict[str, bytes | None] = {}
_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def _is_private_host(host: str) -> bool:
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        addresses = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return True
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address[4][0])
        except ValueError:
            return True
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return True
    return False


def _local_fixture_path(url: str, settings: Settings) -> Path | None:
    path = urlparse(url).path
    for marker in ("/static/images/", "/static/fixtures/images/"):
        if marker in path:
            name = path.split(marker, 1)[1].split("?", 1)[0]
            candidate = (settings.fixture_image_dir / name).resolve()
            if candidate.is_file() and settings.fixture_image_dir.resolve() in candidate.parents:
                return candidate
    return None


def fetch_image_bytes(url: str, settings: Settings) -> bytes | None:
    if url in _CACHE:
        return _CACHE[url]
    local = _local_fixture_path(url, settings)
    if local:
        data = local.read_bytes()
        _CACHE[url] = data
        return data
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        _CACHE[url] = None
        return None
    if parsed.hostname and _is_private_host(parsed.hostname) and not settings.allow_local_images:
        _CACHE[url] = None
        return None
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=20.0,
            headers={"User-Agent": "AiTelier-Person3/1.0"},
        ) as client:
            response = client.get(url)
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";")[0].lower()
            if content_type and content_type not in _ALLOWED_CONTENT_TYPES:
                _CACHE[url] = None
                return None
            data = response.content
            if len(data) > settings.image_max_bytes:
                _CACHE[url] = None
                return None
            _CACHE[url] = data
            return data
    except (httpx.HTTPError, OSError):
        _CACHE[url] = None
        return None


def open_image(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image = ImageOps.exif_transpose(image)
    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGB")
    return image


def image_to_data_url(data: bytes, max_side: int = 512) -> str:
    image = open_image(data)
    image.thumbnail((max_side, max_side))
    if image.mode == "RGBA":
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.split()[-1])
        image = background
    else:
        image = image.convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=82, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def image_data_urls(items: list, settings: Settings, limit: int = 12) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for item in items:
        if len(result) >= limit:
            break
        for image in item.images:
            data = fetch_image_bytes(image.url, settings)
            if data:
                result.append(
                    {
                        "item_id": item.item_id,
                        "url": image.url,
                        "data_url": image_to_data_url(data),
                    }
                )
                break
    return result


def placeholder_image(label: str, size: tuple[int, int] = (480, 640)) -> Image.Image:
    image = Image.new("RGB", size, "#EFE8DD")
    draw = ImageDraw.Draw(image)
    font = _font(22)
    draw.rounded_rectangle((8, 8, size[0] - 8, size[1] - 8), radius=18, outline="#B8AA98", width=3)
    bbox = draw.textbbox((0, 0), label, font=font)
    x = (size[0] - (bbox[2] - bbox[0])) // 2
    y = size[1] // 2
    draw.text((x, y), label, fill="#6B5F52", font=font)
    return image


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()
