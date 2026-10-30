# Person 3 Input Contract

**Project:** AiTelier
**Owner:** Person 3 (Stylist selection and final check)
**Version:** 1.0
**Status:** Draft for implementation

## 1. Purpose and scope

This contract defines the data that Person 3 receives from the customer brief, Person 1 (real shop data), and Person 2 (filtered candidates from guaranteed shops). It is the input to the Python/LangGraph stylist service.

Person 3 covers:

- Step 5: the LLM stylist selects complete outfits from the candidate catalogue.
- Step 6: the final check re-queries live price, size, availability, shipping, and delivery data, then evaluates five guarantees.

Person 3 does not collect shop data, run the trust-check request, execute payments, or move the refund. Person 2 supplies only shops that passed the trust check.

The LLM may only select existing `item_id` values. It must never invent product URLs, prices, brands, sizes, or item IDs.

## 2. Canonical envelope

```json
{
  "contract_version": "1.0",
  "task_id": "01a18c44-72b6-76e3-8792-4384f64842c8",
  "currency": "EUR",
  "locale": "de-DE",
  "customer": {
    "budget": {"amount": 600.0, "currency": "EUR"},
    "item_count": 6,
    "outfit_count": 3,
    "style": ["old money", "minimal"],
    "fit": ["slim", "straight through the leg"],
    "fit_description": "Straight fit with a defined waist; avoid oversized shoulders.",
    "gender": "men",
    "season": "autumn",
    "climate": "Munich, wet, 8-15 C",
    "measurements_cm": {
      "height": 178,
      "chest": 96,
      "shoulder": 42,
      "waist": 82,
      "inseam": 82
    },
    "sizes": {
      "top": "M",
      "shirt": "15",
      "trousers": "EU48",
      "shoes": "EU42"
    },
    "must_have": ["water-resistant outer layer"],
    "avoid": ["large logos"],
    "deadline": "2026-11-05",
    "photo": null
  },
  "shops": [
    {
      "shop_id": "uniqlo-eu",
      "name": "Uniqlo EU",
      "domain": "uniqlo.com",
      "base_url": "https://www.uniqlo.com/eu/en/",
      "guarantee": {
        "status": "guaranteed",
        "trust_score": 0.93,
        "checked_at": "2026-10-30T09:00:00Z",
        "expires_at": "2026-10-31T09:00:00Z",
        "evidence": {
          "source": "person2",
          "reference": "trust:...",
          "method": "x402"
        }
      },
      "shipping": {
        "regions": ["DE"],
        "default_amount": 4.9,
        "currency": "EUR",
        "min_days": 2,
        "max_days": 5
      }
    }
  ],
  "items": [
    {
      "item_id": "uniqlo:460567",
      "shop_id": "uniqlo-eu",
      "title": "Water-Repellent Single Breasted Trench Coat",
      "brand": "Uniqlo",
      "category": "outerwear",
      "description": "Long trench coat, water-repellent finish, belted waist, mid-thigh length.",
      "look_description": "Straight silhouette with a clean, formal finish.",
      "fit_description": "Regular fit with structured shoulders.",
      "style": {
        "silhouette": "straight",
        "fit": "regular",
        "formality": "smart-casual",
        "pattern": "solid",
        "style_tags": ["old-money", "minimal"],
        "occasions": ["office", "city", "rain"]
      },
      "materials": ["100% polyester"],
      "colors": [{"name": "beige", "hex": "#C8B79B"}],
      "size_system": "EU",
      "sizes": [
        {
          "label": "S",
          "in_stock": true,
          "measurements_cm": {"chest": 104, "shoulder": 44}
        },
        {
          "label": "M",
          "in_stock": true,
          "measurements_cm": {"chest": 108, "shoulder": 45}
        }
      ],
      "price": {"amount": 129.9, "currency": "EUR"},
      "shipping": {"amount": 4.9, "currency": "EUR", "days": 3, "regions": ["DE"]},
      "availability": "in_stock",
      "stock_quantity": 3,
      "images": [
        {"url": "https://.../front.jpg", "role": "front"},
        {"url": "https://.../detail.jpg", "role": "detail"},
        {"url": "https://.../model.jpg", "role": "on_model"}
      ],
      "product_url": "https://www.uniqlo.com/eu/en/product/...",
      "collected_at": "2026-10-30T09:00:00Z",
      "source": {
        "collector": "person1",
        "method": "shop_json",
        "snapshot_hash": "sha256:..."
      }
    }
  ],
  "options": {
    "strict_guarantees": true,
    "fit_mode": "measurements",
    "required_layers": ["base", "mid", "outer", "bottom", "shoes"],
    "max_selection_retries": 2,
    "max_images_per_item": 3,
    "allow_text_only_items": false,
    "timeout_seconds": 90
  },
  "metadata": {}
}
```

## 3. Required and optional fields

Required:

- `contract_version`
- `task_id`
- `customer.budget`
- `customer.style`
- `shops[].shop_id`
- `shops[].name`
- `shops[].domain` or `shops[].base_url`
- `items[].item_id`
- `items[].shop_id`
- `items[].title`
- `items[].category`
- `items[].price`
- `items[].product_url`

Recommended:

- `customer.sizes`
- `items[].description`
- `items[].images`
- `items[].sizes`
- `items[].shipping`
- `shops[].guarantee`

Optional:

- `customer.measurements`
- `customer.photo`
- `customer.deadline`
- `customer.climate`
- `customer.fit`
- `customer.fit_description`
- `items[].availability`
- `items[].look_description`
- `items[].fit_description`
- `items[].style`
- `items[].size_chart`
- `items[].stock_quantity`
- `items[].collected_at`
- `items[].source`
- `items[].raw`
- `metadata`

Unknown fields are allowed and preserved in `raw`. The contract accepts additive `1.x` versions; breaking changes require a new major version.

## 4. Customer brief

### 4.1 Budget and currency

Accepted shapes:

- `600`
- `"600 EUR"`
- `{"amount": 600, "currency": "EUR"}`

Currency resolution order:

1. `customer.budget.currency`
2. envelope `currency`
3. `options.default_currency`

No currency conversion is performed. If a currency cannot be resolved, the request is rejected with `422 CURRENCY_MISMATCH`. All item and shipping prices must use the same currency as the budget.

### 4.2 Style and fit descriptors

`style` accepts a string or a list of strings. Free text is allowed.

`fit` accepts a string or a list of strings. These are examples, not a closed enum:

- `slim`
- `straight fit`
- `regular`
- `relaxed`
- `boxy`
- `oversized`
- `tailored`
- `athletic`
- `straight through the leg`
- `slim through the waist`

Plain-language combinations such as `"straight fit, slim waist"` are valid. The normalized value is a list of strings, and the original text is preserved.

`fit_description` is optional free text describing the desired look or silhouette. It is passed to the LLM and is not validated against an enum.

### 4.2.1 Style blend and layer count

`customer.style` may contain up to five style directions. They are blended into one coherent
look, not expanded into five separate outfits. `customer.outfit_count` is clamped to 1-5;
one request can therefore produce up to five looks.

The number of garment layers depends on the season and climate:

- Summer / hot: base, bottom, shoes.
- Spring / autumn / mild or wet: base, mid, bottom, shoes.
- Winter / cold / snow: base, mid, outer, bottom, shoes.
- An accessory is optional.

`options.required_layers` may override this list. A single top layer is valid in summer; five
layers are valid in winter.

### 4.3 Measurements

Accepted measurement shapes:

- `_cm` suffix: `chest_cm`, `waist_cm`, `inseam_cm`
- `_in` suffix: `chest_in`, `waist_in` (converted to cm)
- Plain numbers: `chest: 96` (interpreted as cm by default)
- Aliases: `bust` -> chest, `shoulder_width` -> shoulder, `leg_length` -> inseam
- Partial sets are allowed

`measurement_unit` may be set to `cm` or `in` when plain numbers are used. If omitted, plain numbers are treated as cm and a `MEASUREMENT_UNIT_ASSUMED` warning is emitted.

Textual fit descriptors are not measurements. They belong in `fit` or `fit_description`.

If neither measurements nor sizes are supplied, the request is still accepted, but the fit guarantee is `unknown` and strict mode fails.

### 4.4 Sizes

Accepted shapes:

- Map: `{"top": "M", "shoes": "EU42"}`
- List of strings: `["M", "EU42"]`
- List of objects: `[{"slot": "top", "label": "M"}]`
- Single string: `"M"`

Canonical slots: `top`, `shirt`, `jacket`, `bottom`, `trousers`, `shoes`, `accessory`.

Size labels are not converted between systems. Matching is exact unless a size chart provides measurements.

### 4.5 Photo

Accepted shapes:

- URL string
- Data URI
- `{"url": "..."}`
- `{"base64": "...", "mime_type": "image/jpeg"}`

The photo is optional. Without it, the stylist relies on measurements and the customer's fit description. EXIF data is stripped before processing.

## 5. Shops and the Person 2 guarantee

Person 2 supplies only shops that passed the trust check. The `guarantee` object is therefore optional, but when present it must be valid.

```json
{
  "shop_id": "uniqlo-eu",
  "name": "Uniqlo EU",
  "domain": "uniqlo.com",
  "base_url": "https://www.uniqlo.com/eu/en/",
  "guarantee": {
    "status": "guaranteed",
    "trust_score": 0.93,
    "checked_at": "2026-10-30T09:00:00Z",
    "expires_at": "2026-10-31T09:00:00Z",
    "evidence": {
      "source": "person2",
      "reference": "trust:...",
      "method": "x402"
    }
  }
}
```

Normalization:

- `status: "guaranteed"`, `"verified"`, or `"trusted"` is accepted.
- `trusted: true` or `verified: true` is normalized to `status: "guaranteed"`.
- A missing guarantee is accepted because Person 2 only sends guaranteed shops. An `GUARANTEE_ASSUMED` warning is emitted.
- `status: "failed"`, `"unverified"`, or an expired `expires_at` rejects the shop with `422 NO_GUARANTEED_SHOPS`.

Trust is a precondition, not one of the five final-check guarantees.

## 6. Catalogue items

### 6.1 Categories

`category` accepts free text and is normalized to a slot:

| Slot | Example inputs |
|---|---|
| `outerwear` | coat, jacket, trench, mantel, parka |
| `top` | shirt, t-shirt, sweater, hoodie, blouse, top |
| `bottom` | trousers, pants, jeans, chinos, skirt, shorts |
| `shoes` | boots, sneakers, loafers, shoes, schuhe |
| `accessory` | belt, bag, scarf, hat, watch |
| `other` | anything that cannot be mapped |

Items mapped to `other` remain available to the stylist but do not satisfy a required slot.

### 6.2 Descriptions

`description`, `look_description`, and `fit_description` accept:

- Plain string
- Array of bullet strings
- Object with `summary`, `details`, `bullets`, `care`
- `null` or empty

Descriptions are normalized to plain text, truncated to 2000 characters, and preserved in `raw`. Missing descriptions produce a `MISSING_DESCRIPTION` warning. They do not reject the item.

Descriptions are untrusted data. They are delimited in the LLM prompt and never treated as instructions.

### 6.3 Images

Accepted shapes:

- URL string
- Array of URL strings
- Array of `{"url": "...", "role": "front"}`
- `image_url` field

Normalization:

- `role` values: `front`, `back`, `detail`, `on_model`, `flat_lay`, `unknown`.
- The first image without a role becomes `front`; remaining images become `unknown`.
- Relative URLs resolve against `shop.base_url`.
- Only `http` and `https` are accepted; private IPs and localhost are blocked.
- Items without a usable image are accepted but excluded when `options.allow_text_only_items` is `false`.
- Items missing an `on_model` image can still be selected for text and product-image boards.

### 6.4 Prices and shipping

Price accepts a number, a formatted string (`"€129.90"`, `"129,90 EUR"`), or `{"amount": 129.9, "currency": "EUR"}`. Ambiguous formats are rejected rather than guessed.

Shipping accepts a number, a formatted string, or an object with `amount`, `currency`, `days`, and `regions`. Missing shipping is allowed at input time, but strict budget and delivery guarantees require a value from the final check.

## 7. Variants and normalization matrix

| Field | Accepted variants | Normalized to | Missing or empty behavior |
|---|---|---|---|
| `customer.budget` | number, string, object | Money object | Use envelope currency; reject if still unknown |
| `customer.style` | string, array | `list[str]` | Default `["minimal"]` + warning |
| `customer.fit` | string, array, free-text descriptors | `list[str]` | No constraint; LLM uses available text |
| `customer.fit_description` | free text | string | No effect on validation |
| `customer.measurements` | `_cm`, `_in`, plain numbers, aliases | cm values | Fit limited to size availability |
| `customer.sizes` | map, array, single string | canonical slot map | Fit guarantee fails in strict mode |
| `customer.photo` | URL, data URI, object | image reference | Measurements-only analysis |
| `shops[].guarantee` | object, boolean aliases, absent | guarantee object | Accepted as guaranteed + warning |
| `items[].description` | string, array, object, null | plain text + raw | Title/style/images used + warning |
| `items[].look_description` | string, null | string | Ignored |
| `items[].fit_description` | string, null | string | Item `style.fit` used |
| `items[].images` | URL, array of URLs, array of objects, `image_url` | `{url, role}[]` | Item accepted but may be excluded |
| `items[].price` | number, string, object | Money object | Reject if currency ambiguous |
| `items[].sizes` | array of strings, array of objects, map, single string | size objects | Availability becomes `unknown` |
| `items[].availability` | boolean, string enum, object, `null`, `""`, absent | `in_stock` / `sold_out` / `preorder` / `unknown` | Accepted; normalized to `unknown`; final check decides |
| `items[].category` | free text, German/English synonyms | slot | `other` + warning |
| `items[].shipping` | number, string, object, absent | Shipping object | `null`; strict budget/delivery fails |
| `items[].collected_at` | ISO timestamp, absent | timestamp | Request time + warning |
| `items[].raw` | any JSON | preserved | Not sent to the LLM |

## 8. Availability is optional

`items[].availability` is optional. These are all valid inputs:

```json
{}
```

```json
{"availability": null}
```

```json
{"availability": ""}
```

```json
{"availability": true}
```

```json
{"availability": "in_stock"}
```

```json
{"availability": {"status": "sold_out", "quantity": 0}}
```

Normalization rules:

- Missing, `null`, or `""` becomes `unknown`.
- `true`, `"in_stock"`, `"available"` becomes `in_stock`.
- `false`, `"sold_out"`, `"out_of_stock"` becomes `sold_out`.
- `"preorder"` becomes `preorder`.
- Anything else becomes `unknown` with an `AVAILABILITY_UNKNOWN` warning.

Input availability is a snapshot, not a guarantee. The final check always re-queries live data. A missing input value does not reject the item and does not fail ingestion. If the live check also returns `unknown` or is unreachable in strict mode, the availability guarantee fails.

## 9. Final-check input from Person 1

The final check receives one live record per selected item:

```json
{
  "item_id": "uniqlo:460567",
  "checked_at": "2026-10-30T10:15:00Z",
  "price": {"amount": 129.9, "currency": "EUR"},
  "availability": "in_stock",
  "sizes_in_stock": ["M"],
  "shipping": {"amount": 4.9, "currency": "EUR", "days": 3, "regions": ["DE"]},
  "product_url": "https://www.uniqlo.com/eu/en/product/...",
  "stale": false,
  "source": "person1_refresh"
}
```

If the live source is unreachable, the record is marked `stale: true` and strict guarantees fail. Person 3 never silently approves an outfit using stale data.

## 10. Five guarantees

Person 2 guarantees the shops, so trust is a precondition. The five final-check guarantees are:

| # | Guarantee | Predicate |
|---|---|---|
| G1 | Budget | Items plus shipping are within the customer budget and use the same currency |
| G2 | Fit | Selected size is in stock; measurements are compatible when `fit_mode` is `measurements`; `size_only` mode uses size availability |
| G3 | Availability | Every selected item is in stock at the live re-check |
| G4 | Price integrity | Live price matches the catalogue snapshot within 1%; shipping is known |
| G5 | Delivery | Shop ships to the customer's region and the ETA meets the deadline, or is known within 14 days when no deadline is supplied |

If Aiatelier defines trust as one of the five, replace G5 with `shop_guarantee_valid`. The guarantee set is configurable in the Python service.

An outfit is approved only when all five guarantees pass. Failed outfits are dropped and the stylist retries with the failure reasons. If no outfit passes after the retry limit, Person 3 emits a refund recommendation for 6 ADA and does not execute the refund itself.

## 11. Validation, warnings, and errors

Warnings are returned with the result and do not stop processing:

- `MISSING_DESCRIPTION`
- `MISSING_IMAGE`
- `TRUNCATED_DESCRIPTION`
- `CURRENCY_INFERRED`
- `SIZE_SYSTEM_ASSUMED`
- `GUARANTEE_ASSUMED`
- `AVAILABILITY_UNKNOWN`
- `MEASUREMENT_UNIT_ASSUMED`
- `SHIPPING_UNKNOWN`

Errors:

- `400 INVALID_ENVELOPE` — malformed JSON or missing root fields.
- `422 NO_GUARANTEED_SHOPS` — guarantee failed or expired.
- `422 NO_ELIGIBLE_ITEMS` — no item satisfies the required slots or image policy.
- `422 CURRENCY_MISMATCH` — budget, item, and shipping currencies differ.
- `409 TASK_ALREADY_PROCESSED` — idempotency key reused with a different payload.

Limits:

- Maximum 100 items and 30 shops per request.
- Maximum 8 images per item.
- Maximum 10 MB per image.
- Maximum 2000 characters of description per item.
- Maximum 90 seconds per request.

## 12. Minimal example

```json
{
  "contract_version": "1.0",
  "task_id": "task-minimal-1",
  "currency": "EUR",
  "customer": {
    "budget": 300,
    "style": "minimal",
    "fit": "straight fit",
    "sizes": {"top": "M", "bottom": "EU48", "shoes": "EU42"}
  },
  "shops": [
    {"shop_id": "shop-1", "name": "Example Shop", "domain": "shop.example"}
  ],
  "items": [
    {
      "item_id": "item-1",
      "shop_id": "shop-1",
      "title": "Heavyweight Cotton T-Shirt",
      "category": "top",
      "price": 29.9,
      "product_url": "https://shop.example/item-1",
      "images": ["https://shop.example/item-1.jpg"]
    }
  ],
  "options": {
    "strict_guarantees": false,
    "fit_mode": "size_only"
  }
}
```

This example is valid even though it has no description, no measurements, no shipping, and no explicit availability. It produces warnings and relies on the final check for live data.

## 13. Versioning

- The current version is `1.0`.
- Additive fields are allowed within `1.x`.
- Unknown fields are preserved.
- Removing or changing required fields requires `2.0`.
- Every request is idempotent by `task_id` plus a payload hash.

## 14. Handoff boundary

Person 3 returns a result containing:

- Approved outfits with item snapshots, totals, and image boards.
- Per-outfit and overall guarantee results.
- Warnings and audit timestamps.
- A refund recommendation when no outfit passes.

The output contract is defined separately in the Person 3 output specification.

## 15. Generating a canonical input

`person3/scripts/generate_input.py` turns a raw Person 1/2 payload and a customer brief into
the canonical input above:

```text
python -m scripts.generate_input --raw raw.json --customer customer.json --out input.json
```

There are no profiles or preset modes. The same normalizer serves every season, budget, and
style blend. The checked-in demo input is `person3/fixtures/input.json`; tests cover the
variants in code.
