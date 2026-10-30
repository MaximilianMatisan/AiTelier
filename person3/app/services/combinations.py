"""Garment combinations that never belong in one outfit.

The stylist prompt asks the model to avoid these, but a model can ignore a
prompt and the deterministic fallback never reads one. The resolver rejects an
outfit that breaks a rule, and the fallback skips candidates that would, so the
customer never receives one. Colour harmony stays with the model: it is a
judgement, not a keyword test.

Titles are matched in the shop's own language, so the patterns include the
German, Spanish and French words the catalogue uses.
"""

from __future__ import annotations

import re
from typing import Iterable

Piece = tuple[str, str]  # (layer, title)

_SHORTS = re.compile(r"\bshorts?\b|bermuda|kurze hose|pantal[oó]n corto", re.I)
_POLO = re.compile(r"\bpolo\b", re.I)
_LONG_OR_WARM = re.compile(
    r"\bls\b|long.?sleeve|langarm|manga larga|manches longues|knit|strick|punto|"
    r"sweat|terry|fleece|hoodie|cardigan|sweater|jumper|pullover|crewneck",
    re.I,
)
_DRESS_SHOES = re.compile(
    r"loafer|derby|oxford|chelsea|brogue|monk.?strap|weejun|penny|moccasin|mocas[ií]n",
    re.I,
)


def clashes(pieces: Iterable[Piece], season: str | None = None) -> list[str]:
    """Every rule the outfit breaks, as a sentence the stylist can act on."""
    pieces = list(pieces)
    bottoms = [title for layer, title in pieces if layer == "bottom"]
    shorts = next((title for title in bottoms if _SHORTS.search(title)), None)
    if not shorts:
        return []
    problems: list[str] = []
    if season and season.lower() != "summer":
        problems.append(f"shorts ({shorts}) outside summer")
    for layer, title in pieces:
        if layer in ("base", "mid") and _POLO.search(title):
            problems.append(f"a polo ({title}) with shorts; use a t-shirt with shorts or trousers with the polo")
        elif layer == "mid" or (layer == "base" and _LONG_OR_WARM.search(title)):
            problems.append(f"a long-sleeve or warm top ({title}) with shorts")
        elif layer == "outer":
            problems.append(f"a jacket or coat ({title}) with shorts")
        elif layer == "shoes" and _DRESS_SHOES.search(title):
            problems.append(f"dress shoes ({title}) with shorts")
    return problems
