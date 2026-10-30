# Person 3 Output Contract

**Project:** AiTelier
**Owner:** Person 3 (Stylist and final check)
**Version:** 1.0
**A2UI:** v0.9.1, Basic Catalog
**Transport:** REST JSON array

## 1. Output layers

Person 3 returns three connected outputs:

1. **LLM selection JSON** — item IDs, sizes, layers, and reasoning only.
2. **Service result JSON** — resolved garments, prices, totals, guarantees, and artifacts.
3. **A2UI messages** — a gallery surface that renders the result in an A2UI client.

The LLM never writes URLs, prices, or arbitrary UI. Deterministic Python code resolves the
catalogue and builds the A2UI tree.

## 2. LLM selection output

```json
{
  "outfits": [
    {
      "name": "Rainy Munich Classic",
      "items": [
        {"item_id": "base-oxford", "size": "M", "layer": "base"},
        {"item_id": "mid-merino", "size": "M", "layer": "mid"},
        {"item_id": "outer-trench", "size": "M", "layer": "outer"},
        {"item_id": "bottom-jeans", "size": "EU48", "layer": "bottom"},
        {"item_id": "shoes-boots", "size": "EU42", "layer": "shoes"}
      ],
      "rationale": "Structured shoulders, tonal palette, weather protection.",
      "fit_notes": "Hem the trousers to 79-80 cm; keep the coat shoulder on the acromion.",
      "confidence": 0.86
    }
  ]
}
```

Validation:

- Every `item_id` exists in the input catalogue.
- Every `layer` matches the item slot.
- `size` is offered and in stock, unless the item has a single size.
- Required layers come from the season; summer may be base + bottom + shoes.
- No URLs, prices, or extra keys.

## 3. Service result

```json
{
  "contract_version": "1.0",
  "task_id": "aitelier-demo-001",
  "status": "APPROVED",
  "style_blend": ["old money", "minimal", "quiet luxury", "smart casual", "heritage"],
  "budget_label": "1200.00 EUR",
  "outfits": [
    {
      "outfit_id": "look-1",
      "name": "Rainy Munich Classic",
      "style_blend": ["old money", "minimal"],
      "item_ids": ["base-oxford", "mid-merino", "outer-trench", "bottom-jeans", "shoes-boots"],
      "layers": [
        {"layer": "base", "label": "Base", "item_id": "base-oxford", "size": "M"},
        {"layer": "mid", "label": "Mid", "item_id": "mid-merino", "size": "M"},
        {"layer": "outer", "label": "Outer", "item_id": "outer-trench", "size": "M"},
        {"layer": "bottom", "label": "Bottom", "item_id": "bottom-jeans", "size": "EU48"},
        {"layer": "shoes", "label": "Shoes", "item_id": "shoes-boots", "size": "EU42"}
      ],
      "items": [
        {
          "item_id": "base-oxford",
          "title": "Washed Oxford Shirt",
          "brand": "Atelier",
          "layer": "base",
          "layer_label": "Base",
          "size": "M",
          "price": {"amount": 89.9, "currency": "EUR"},
          "product_url": "https://atelier-munich.example/base-oxford",
          "image_url": "http://127.0.0.1:21951/static/images/shirt.jpg"
        }
      ],
      "totals": {"items": 709.5, "shipping": 9.8, "grand_total": 719.3, "currency": "EUR"},
      "rationale": "Structured shoulders, tonal palette, weather protection.",
      "fit_notes": "Hem the trousers to 79-80 cm.",
      "confidence": 0.86,
      "color_palette": ["#6E8CA8", "#E6DED0"],
      "images": {
        "board": "aitelier-demo-001/look-1-board.jpg"
      },
      "guarantees": {
        "ok": true,
        "checks": {
          "budget": {"ok": true, "detail": "719.30 EUR <= 1200.00 EUR"},
          "fit": {"ok": true, "detail": "all selected sizes and measurements are compatible"},
          "availability": {"ok": true, "detail": "all items live in stock"},
          "price_integrity": {"ok": true, "detail": "live prices match the catalogue"},
          "delivery": {"ok": true, "detail": "delivery regions and timing are valid"}
        }
      }
    }
  ],
  "guarantees": {
    "budget": {"ok": true, "detail": "..."},
    "fit": {"ok": true, "detail": "..."},
    "availability": {"ok": true, "detail": "..."},
    "price_integrity": {"ok": true, "detail": "..."},
    "delivery": {"ok": true, "detail": "..."}
  },
  "decision": {"approved": true, "reason": null},
  "refund": null,
  "warnings": [],
  "lookbook": "aitelier-demo-001/lookbook.jpg",
  "markdown": "# AiTelier result — APPROVED ...",
  "a2ui": {"...": "..."},
  "artifacts": {
    "directory": "C:/CardanoProject/Blockchain-AI/person3/artifacts/aitelier-demo-001",
    "lookbook": "aitelier-demo-001/lookbook.jpg"
  }
}
```

Failure outcome:

```json
{
  "status": "REFUND",
  "outfits": [],
  "decision": {"approved": false, "reason": "No outfit passed all five guarantees"},
  "refund": {"amount": 6, "currency": "ADA", "recommended": true, "executed": false}
}
```

## 4. Outfit board

The board is a deterministic Pillow composition of the **garment product images themselves**.

- No person, face, model, or mannequin body is drawn by the service.
- Source images are shop product images; some shops photograph garments on a model, and those
  images are used as-is.
- Garments are arranged in layer order and connected to a thin central spine.
- Each panel has layer, brand, title, and price labels.
- The number of panels follows the season: 3 in summer, 4 in mild weather, 5 in winter.
- Output files:
  - `artifacts/<task_id>/look-<n>-board.jpg`
  - `artifacts/<task_id>/lookbook.jpg`

This keeps the garments visually connected without inventing a body or a generated model.

## 5. A2UI output

```json
{
  "version": "v0.9.1",
  "surface_id": "aitelier-gallery-aitelier-demo-001",
  "catalog_id": "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
  "theme": {
    "primaryColor": "#1F2A44",
    "agentDisplayName": "AiTelier Stylist"
  },
  "messages": [
    {"version": "v0.9.1", "createSurface": {"...": "..."}},
    {"version": "v0.9.1", "updateComponents": {"...": "..."}},
    {"version": "v0.9.1", "updateDataModel": {"...": "..."}}
  ],
  "valid": true,
  "errors": [],
  "fallback_markdown": "# AiTelier result ..."
}
```

### 5.1 Parameters

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `version` | string | yes | `v0.9.1` |
| `surface_id` | string | yes | One gallery surface per task |
| `catalog_id` | string | yes | Renderer-supported basic catalog |
| `theme` | object | yes | Primary colour and agent name |
| `messages` | array | yes | createSurface, updateComponents, updateDataModel |
| `valid` | boolean | yes | Structural validation result |
| `errors` | array | yes | Validation errors; empty when valid |
| `fallback_markdown` | string | yes | Used when a renderer cannot show A2UI |

### 5.2 Components used

| Component | Purpose |
|---|---|
| `Column` | page root, card body, layer detail, guarantee list |
| `Row` | guarantee rows |
| `List` | vertical outfit gallery |
| `Card` | one outfit |
| `Text` | title, totals, rationale, labels |
| `Image` | outfit board and garment image |
| `Icon` | guarantee status (`check` / `error`) |
| `Tabs` | click through the layers of one outfit |
| `Button` | open a product page |
| `Divider` | optional separation |

Not used: `Video`, `AudioPlayer`, forms, pickers, sliders, date inputs, modal.

### 5.3 What is clickable

Exactly two interactions:

1. **Layer tabs** — switch between the garments of one outfit:
   `Base → Mid → Outer → Bottom → Shoes` (only layers present).
   This is local UI state; no server call.
2. **Open product page** — a `Button` with a local `openUrl` action. It opens the exact
   product URL copied from the catalogue.

There are no “choose outfit”, “request alternative”, approve, or checkout buttons. The gallery
is the final result; the refund is a recommendation, not an action.

### 5.4 Gallery structure

```text
root Column
├─ header Text
├─ summary Text
├─ gallery List
│  ├─ outfit_0 Card → Column
│  │  ├─ board Image
│  │  ├─ name Text
│  │  ├─ total Text
│  │  ├─ rationale Text
│  │  ├─ Tabs (base / mid / outer / bottom / shoes)
│  │  │  └─ Column → Image, title, size/price, Button openUrl
│  │  └─ guarantees Column → Row(Icon, Text) × 5
│  └─ outfit_1 Card ...
├─ lookbook Image
├─ decision Text
├─ refund Text (only for REFUND)
└─ warnings Text (optional)
```

### 5.5 Rendering rules

- Artifacts are local: `ARTIFACT_BASE_URL` defaults to `http://127.0.0.1:21951`.
- `Image.url` must be absolute and reachable by the renderer.
- `createSurface.sendDataModel` is `false`; there are no server actions.
- The API returns `a2ui.messages` as a plain JSON array.
- `GET /v1/style/{task_id}/a2ui` returns the same array.
- If structural validation fails, `valid=false` and the client should use `fallback_markdown`.

## 6. Example

A full generated example is written to `person3/examples/output.example.json` by
`person3/scripts/generate_example.py`, including the A2UI messages and the example board paths.
