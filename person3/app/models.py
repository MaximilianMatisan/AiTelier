from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


Layer = Literal["base", "mid", "outer", "bottom", "shoes", "accessory", "other"]


class Money(BaseModel):
    amount: float
    currency: str = "EUR"


class Guarantee(BaseModel):
    status: str = "guaranteed"
    trust_score: float | None = None
    checked_at: str | None = None
    expires_at: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class Shop(BaseModel):
    shop_id: str
    name: str
    domain: str | None = None
    base_url: str | None = None
    guarantee: Guarantee | None = None
    shipping: dict[str, Any] | None = None


class ImageRef(BaseModel):
    url: str
    role: str = "unknown"


class SizeOption(BaseModel):
    label: str
    in_stock: bool | None = None
    measurements_cm: dict[str, float] = Field(default_factory=dict)


class Item(BaseModel):
    item_id: str
    shop_id: str
    title: str
    brand: str = ""
    category: str
    slot: Layer = "other"  # type: ignore[assignment]
    description: str = ""
    look_description: str | None = None
    fit_description: str | None = None
    style: dict[str, Any] = Field(default_factory=dict)
    materials: list[str] = Field(default_factory=list)
    colors: list[dict[str, str]] = Field(default_factory=list)
    size_system: str | None = None
    sizes: list[SizeOption] = Field(default_factory=list)
    price: Money
    shipping: dict[str, Any] | None = None
    availability: str = "unknown"
    stock_quantity: int | None = None
    images: list[ImageRef] = Field(default_factory=list)
    product_url: str
    collected_at: str | None = None
    source: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)


class Customer(BaseModel):
    budget: Money
    style: list[str] = Field(default_factory=lambda: ["minimal"])
    fit: list[str] = Field(default_factory=list)
    fit_description: str | None = None
    measurements_cm: dict[str, float] = Field(default_factory=dict)
    sizes: dict[str, str] = Field(default_factory=dict)
    item_count: int | None = None
    outfit_count: int = 3
    gender: str | None = None
    season: str | None = None
    climate: str | None = None
    must_have: list[str] = Field(default_factory=list)
    avoid: list[str] = Field(default_factory=list)
    deadline: str | None = None
    photo: Any = None


class StylistRequest(BaseModel):
    contract_version: str = "1.0"
    task_id: str = Field(default_factory=lambda: f"task-{uuid4().hex[:12]}")
    currency: str = "EUR"
    locale: str = "de-DE"
    customer: Customer
    shops: list[Shop]
    items: list[Item]
    options: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    warnings: list[dict[str, str]] = Field(default_factory=list)

    @property
    def required_layers(self) -> list[str]:
        value = self.options.get("required_layers")
        if isinstance(value, list) and value:
            return [str(v) for v in value]
        text = " ".join(
            str(part)
            for part in (
                self.customer.season,
                self.customer.climate,
                self.customer.fit_description,
            )
            if part
        ).lower()
        if any(word in text for word in ("summer", "hot", "warm", "tropical")):
            return ["base", "bottom", "shoes"]
        if any(word in text for word in ("winter", "cold", "snow", "freezing")):
            return ["base", "mid", "outer", "bottom", "shoes"]
        if any(word in text for word in ("autumn", "spring", "mild", "rain", "wet")):
            return ["base", "mid", "bottom", "shoes"]
        return ["base", "bottom", "shoes"]


class SelectedItem(BaseModel):
    item_id: str
    size: str | None = None
    layer: Layer | None = None


class OutfitDraft(BaseModel):
    name: str = "AiTelier look"
    items: list[SelectedItem] = Field(default_factory=list)
    rationale: str = ""
    fit_notes: str = ""
    confidence: float | None = None


class OutfitSelection(BaseModel):
    outfits: list[OutfitDraft] = Field(default_factory=list)


class ContractError(ValueError):
    pass
