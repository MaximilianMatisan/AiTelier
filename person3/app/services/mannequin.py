from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageOps

from ..config import Settings
from ..models import Item, StylistRequest
from .images import _font, fetch_image_bytes, open_image, placeholder_image


CANVAS = (1200, 1500)
HEADER = 170
FOOTER = 60


def _load_item_image(item: Item, settings: Settings) -> Image.Image:
    for image in item.images:
        data = fetch_image_bytes(image.url, settings)
        if data:
            try:
                return open_image(data)
            except Exception:
                continue
    return placeholder_image(item.title[:28])


def _fit(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    fitted = ImageOps.contain(image.convert("RGB"), size)
    canvas = Image.new("RGB", size, "white")
    canvas.paste(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    return canvas


def _round_mask(size: tuple[int, int], radius: int = 20) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def compose_board(
    outfit: dict[str, Any],
    request: StylistRequest,
    settings: Settings,
    out_dir: Path,
) -> str:
    """Compose the garment product images into one connected outfit board.

    No person or mannequin body is drawn: the input images are the garment
    product shots themselves, connected by layer order.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{outfit['outfit_id']}-board.jpg"
    path = out_dir / filename
    by_id = {item.item_id: item for item in request.items}
    items = [value for value in outfit["items"] if value["layer"] in {
        "base", "mid", "outer", "bottom", "shoes", "accessory"
    }]
    count = max(1, len(items))
    usable_height = CANVAS[1] - HEADER - FOOTER
    row_height = usable_height // count
    panel_width = 430
    panel_height = max(190, row_height - 26)
    left_x = 70
    right_x = CANVAS[0] - panel_width - 70
    spine_x = CANVAS[0] // 2

    canvas = Image.new("RGB", CANVAS, "#F7F2E9")
    draw = ImageDraw.Draw(canvas)
    draw.text((60, 40), outfit["name"], fill="#2E2A25", font=_font(40))
    draw.text(
        (60, 92),
        " · ".join(outfit.get("style_blend", [])[:5]),
        fill="#7B6E5F",
        font=_font(22),
    )
    draw.text(
        (60, 126),
        f"{count} layers · {outfit['totals']['grand_total']:.2f} {outfit['totals']['currency']}",
        fill="#7B6E5F",
        font=_font(22),
    )
    draw.line((spine_x, HEADER - 10, spine_x, CANVAS[1] - FOOTER + 10), fill="#D2C4B2", width=3)
    draw.text(
        (60, CANVAS[1] - FOOTER + 14),
        "Product images · AiTelier layered outfit",
        fill="#8E7F6C",
        font=_font(18),
    )

    for index, value in enumerate(items):
        item = by_id[value["item_id"]]
        x = left_x if index % 2 == 0 else right_x
        y = HEADER + 8 + index * row_height
        center_y = y + panel_height // 2
        draw.line((spine_x, center_y, x + (panel_width if index % 2 == 0 else 0), center_y),
                  fill="#C4B6A3", width=3)
        draw.ellipse((spine_x - 7, center_y - 7, spine_x + 7, center_y + 7), fill="#8E7F6C")

        image = _load_item_image(item, settings)
        image_area = (panel_width - 20, panel_height - 58)
        image = _fit(image, image_area)
        panel = Image.new("RGB", (panel_width, panel_height), "white")
        panel.paste(image, (10, 8))
        mask = _round_mask(panel.size, radius=18)
        canvas.paste(panel, (x, y), mask)
        draw.rounded_rectangle(
            (x, y, x + panel_width, y + panel_height),
            radius=18,
            outline="#B8AA98",
            width=3,
        )
        label_y = y + panel_height - 46
        draw.rectangle(
            (x + 4, label_y, x + panel_width - 4, y + panel_height - 4),
            fill="#F7F2E9",
        )
        draw.text(
            (x + 16, label_y + 6),
            f"{value['layer_label'].upper()} · {value['brand'] or item.brand or 'Atelier'}",
            fill="#4C4339",
            font=_font(17),
        )
        draw.text(
            (x + 16, label_y + 26),
            f"{value['title'][:36]}  {value['price']['amount']:.2f} {value['price']['currency']}",
            fill="#7B6E5F",
            font=_font(14),
        )

    canvas.save(path, quality=92)
    return filename


def compose_lookbook(
    board_files: list[str],
    out_dir: Path,
    title: str = "AiTelier lookbook",
) -> str | None:
    if not board_files:
        return None
    thumbs: list[Image.Image] = []
    for filename in board_files:
        path = out_dir / filename
        if path.is_file():
            thumbs.append(Image.open(path).convert("RGB"))
    if not thumbs:
        return None
    width, height = 440, 550
    gap = 24
    columns = min(3, len(thumbs))
    rows = (len(thumbs) + columns - 1) // columns
    canvas = Image.new(
        "RGB",
        (columns * width + (columns + 1) * gap, rows * height + (rows + 1) * gap + 60),
        "#F7F2E9",
    )
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 18), title, fill="#2E2A25", font=_font(30))
    for index, thumb in enumerate(thumbs):
        row, column = divmod(index, columns)
        x = gap + column * (width + gap)
        y = 60 + gap + row * (height + gap)
        fitted = ImageOps.contain(thumb, (width, height))
        canvas.paste(fitted, (x + (width - fitted.width) // 2, y + (height - fitted.height) // 2))
        draw.rectangle((x, y, x + width, y + height), outline="#C4B6A3", width=2)
    path = out_dir / "lookbook.jpg"
    canvas.save(path, quality=92)
    return path.name
