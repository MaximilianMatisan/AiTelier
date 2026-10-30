Redesign the whole website of the AiTelier Studio: all three screens (order, waiting, result) plus header and footer. The page already works; I need the design, not new features. Read everything below before you start.

## The product

AiTelier is an AI agent built for the Cardano track of the TUM Blockchain & AI Hackathon. A customer enters a budget, a style, a season and their sizes. The agent builds outfits from real products in real online shops (a catalogue of 8,725 items) and checks every outfit in code against five guarantees: budget, fit, availability, price integrity and delivery. Payment goes into an escrow on Cardano; if no outfit passes, the customer is refunded. Core principle: the AI decides, the code checks.

Tone: calm, premium, an atelier. Not a tech-startup look.

## The site today

A local web app. Three screens, exactly one visible at a time:

1. **Order** (owned by the page): total budget, number of outfits, style (Old money, Lässig/casual, Streetwear), season, collection, fit, climate, sizes (tops, waist in inches, shoes EU), things to avoid, and a "Fast demo mode" switch. Validation errors come back from the server all at once and appear in one error box.
2. **Waiting** (owned by the page): "Order checked" plus five pipeline stages, each `pending`, `running` or `done`, with a seconds counter. It takes about 25 to 40 seconds.
3. **Result** (owned by the agent): a status badge (`APPROVED` or `REFUND`), then the interface the agent sends as A2UI, then a collapsible block that shows the raw A2UI messages.

## The key constraint: A2UI

The agent describes the result screen itself as A2UI v0.9.1 messages (Agent-to-User Interface, Basic Catalog). The page has no outfit layout of its own; a renderer draws whatever the agent sends. So anything on the result screen can change in three ways, from least to most work:

1. **Restyle only**: CSS on the classes below. Nothing changes in the agent.
2. **New composition**: a new pattern built from existing components, such as a colour palette as a `Row` of small `Text` and `Icon`. The agent must then send that structure.
3. **Custom catalog component**: a new type such as `OutfitCard`. Renderer, agent and catalog ID all change. Only when 1 and 2 cannot do it.

The order and waiting screens are not A2UI; anything goes there.

### Components the agent sends, and the HTML the renderer makes of them

| Component | Fields | Rendered as |
|---|---|---|
| `Text` | `text`, `variant`: `h1` `h2` `h3` `body` `caption` | `h2`/`h3`/`h4`/`p`/`small` with `.a2ui-text.a2ui-text-{variant}` |
| `Image` | `url`, `description`, `fit` (`cover`/`contain`), `variant` (`largeFeature`, …) | `img.a2ui-image.a2ui-image-{variant}`; if it fails, `div.a2ui-image-missing` |
| `Card` | `child` | `div.a2ui-card` |
| `Column` / `Row` | `children`, `align` | `div.a2ui-column` / `div.a2ui-row` plus `.a2ui-align-{align}` |
| `List` | `children`, `direction` | `div.a2ui-list.a2ui-list-{direction}` |
| `Tabs` | `tabs: [{title, child}]` | `.a2ui-tabs` > `.a2ui-tabbar` (buttons `.a2ui-tab[aria-selected]`) + `.a2ui-tabpanel` |
| `Button` | `child`, `variant` (`primary`, `borderless`), `action.functionCall` `openUrl` | `button.a2ui-button.a2ui-button-{variant}` |
| `Icon` | `name`: `check`, `close`, `warning`, `info` | `span.a2ui-icon.a2ui-icon-{name}` |
| `Divider` | – | `hr.a2ui-divider` |

Components reference each other by `id` in a flat list; the root is always `root`. The theme the agent sends: `primaryColor: #1F2A44`, `agentDisplayName: "AiTelier Stylist"`. An unknown component renders as `div.a2ui-unknown`.

### A real outfit from a run (trimmed)

```json
{"id": "root", "component": "Column", "align": "stretch",
 "children": ["header", "summary", "gallery", "lookbook", "decision", "warnings"]}

{"id": "outfit_0", "component": "Card", "child": "outfit_0_body"}
{"id": "outfit_0_body_board", "component": "Image", "variant": "largeFeature", "fit": "cover",
 "url": "http://127.0.0.1:21960/artifacts/aitelier-catalog-demo/look-1-board.jpg",
 "description": "Refined Old Money product board"}
{"id": "outfit_0_body_name", "component": "Text", "variant": "h2", "text": "Refined Old Money"}
{"id": "outfit_0_body_total", "component": "Text", "variant": "body", "text": "Total: 442.40 EUR · 4 layers"}
{"id": "outfit_0_body_rationale", "component": "Text", "variant": "caption",
 "text": "A sophisticated, tonal approach to the old money aesthetic, layering a crisp long-sleeve polo under a breathable knit polo for textural depth, paired with classic navy chinos and premium suede loafers."}
{"id": "outfit_0_body_tabs", "component": "Tabs", "tabs": [
  {"title": "Base — Polo manga larga blanco", "child": "outfit_0_body_layer_0"},
  {"title": "Shoes — Easy Weejuns Larson Penny Loafers for Men (262 / M / CHOCOLATE)", "child": "outfit_0_body_layer_3"}]}
{"id": "outfit_0_body_layer_0", "component": "Column", "align": "start",
 "children": ["…_image", "…_title", "…_detail", "…_link"]}
{"id": "…_detail", "component": "Text", "variant": "body", "text": "Size M · 59.90 EUR"}
{"id": "…_link", "component": "Button", "variant": "borderless", "child": "…_link_text",
 "action": {"functionCall": {"call": "openUrl", "args": {"url": "https://silbonshop.com/products/polo-manga-larga-blanco"}}}}
{"id": "outfit_0_body_guarantees_row_0", "component": "Row", "align": "center",
 "children": ["…_icon_0", "…_text_0"]}
{"id": "…_icon_0", "component": "Icon", "name": "check"}
{"id": "…_text_0", "component": "Text", "variant": "body", "text": "Budget: OK — 442.40 EUR <= 500.00 EUR"}

{"id": "decision", "component": "Text", "variant": "h3", "text": "Approved: all five guarantees passed."}
```

One outfit is about 47 components. The agent also sends each outfit's raw data:

```json
{"outfit_id": "look-1", "name": "Refined Old Money", "style_blend": ["old money"],
 "totals": {"items": 392.4, "shipping": 50.0, "grand_total": 442.4, "currency": "EUR"},
 "rationale": "…", "fit_notes": "…", "confidence": 0.86, "color_palette": [],
 "items": [{"item_id": "silbon-…", "title": "Polo manga larga blanco", "brand": "false",
            "layer": "base", "layer_label": "Base", "size": "M",
            "price": {"amount": 59.9, "currency": "EUR"},
            "product_url": "https://…", "image_url": "https://cdn.shopify.com/…"}],
 "guarantees": {"ok": true, "checks": {
   "budget": {"ok": true, "detail": "442.40 EUR <= 500.00 EUR"},
   "fit": {"ok": true, "detail": "…"}, "availability": {"ok": true, "detail": "…"},
   "price_integrity": {"ok": true, "detail": "…"}, "delivery": {"ok": true, "detail": "…"}}}}
```

## Real data the design has to survive

- Long product titles, such as "Easy Weejuns Larson Penny Loafers for Men (262 / M / CHOCOLATE)".
- Mixed languages from the shops: "Polo manga larga blanco", "Short Bodhi argile".
- A missing brand shows as the text "false" (a data bug being fixed).
- Images can be missing or fail to load. The outfit board image is portrait.
- `color_palette` is often empty; the rationale now starts with the palette, for example "Palette: navy, cream, tan. …".
- Warnings repeat, for example `GUARANTEE_ASSUMED` twenty times in one line.
- The refund case: status `REFUND`, no outfits, one reason such as "look-1 budget: 373.88 EUR <= 300.00 EUR".
- 1 to 10 outfits, each with 3 to 5 pieces (base, mid, outer, bottom, shoes).

## Current design tokens (a starting point, not a requirement)

| Token | Value | Use |
|---|---|---|
| `--ink` | `#1f2a44` | text, primary (matches the A2UI `primaryColor`) |
| `--ink-soft` | `#4a5571` | secondary text |
| `--paper` | `#f7f3ec` | page background |
| `--card` | `#fffdf9` | cards |
| `--line` | `#e4dccd` | borders, dividers |
| `--gold` | `#a8844c` | focus, accent, "running" |
| `--ok` / `--warn` / `--bad` | `#2f6b4f` / `#9a5b13` / `#9b2c2c` | guarantee passed / refund / error |

Headings in a serif ("Iowan Old Style", Georgia, serif, weight 500), body in system-ui, no web fonts required. Card radius 14px, inputs 8px, chips and buttons fully round. Card padding 18–24px, page gutter 16px, max width 860px. Light mode only. A better system of your own is welcome, as long as all text reaches WCAG AA contrast.

## Technical rules

- Vanilla HTML, CSS and JavaScript (ES modules). No framework, no build step, no new dependencies, no external scripts.
- All CSS in one `<style>` block.
- Never insert text as HTML (`textContent` only). Images only from http(s) or the same server. The only action is `openUrl` to an http(s) address.
- Works at 375px wide with no horizontal scrolling.
- Accessibility: real labels, `role` and `aria-selected` on tabs, visible focus, respect `prefers-reduced-motion`.

## Hooks the page logic depends on: keep these exactly

Look, order and surrounding markup are yours to change; these are not.

- Three `<section>` elements with the IDs `order`, `progress` and `result`. The logic shows one at a time by toggling the `hidden` attribute.
- The form `#form`, its submit button `#submit`, and the error box `#form-errors`. Field names go to the server unchanged:

  | `name` | Type | Values |
  |---|---|---|
  | `budget_eur` | number | 1–10000, euros |
  | `outfits` | number | 1–10 |
  | `theme` | exactly one choice (radio) | `old_money`, `casual`, `streetwear` |
  | `season` | choice | `autumn`, `winter`, `spring`, `summer` |
  | `gender` | choice | `men`, `women` |
  | `fit`, `climate` | text, optional | short free text |
  | `top` | choice | `XS`, `S`, `M`, `L`, `XL`, `XXL` |
  | `waist` | number | 24–50, inches |
  | `shoe_eu` | number | 34–50, half sizes allowed |
  | `avoid` | text, optional | comma separated |
  | `fast` | checkbox | on = prepared demo shortlist, about 30 s |

- Waiting: the list `#steps` and the counter `#elapsed`. The logic builds each entry itself as `<li class="done|running|pending">` containing `<span class="dot">` and a `<div>` with `<strong>` (title) and `<small>` (explanation). Style those classes however you like. Failure state: `#run-error` containing `#run-log`.
- Result: `#badge` gets the class `badge APPROVED` or `badge REFUND`; `#refund-note` is shown only on refund; `#surface` is the container the A2UI renderer draws into; `#raw` shows the raw A2UI messages.
- Any button with the attribute `data-restart` returns to the form.
- Where the page script belongs, put exactly this comment instead of writing the logic: `<!-- AITELIER PAGE SCRIPT -->`. I will insert the existing script there.

## The brief

Goal: a demo that says "premium atelier" within five seconds, and shows at the same time that every order is checked and paid on Cardano.

1. **Order**: should feel like a conversation with a tailor, not a government form. Choose the style visually instead of with text chips. Group the sizes clearly. Keep "Fast demo mode" visible but quiet. Show server errors together.
2. **Waiting**: make 25 to 40 seconds worth watching. The stages should show what is happening ("Removing sizes you cannot buy") and that code is checking. No fake progress: state comes only from the `done`, `running` and `pending` classes.
3. **Result**: style every A2UI Basic Catalog component in the table as one coherent design system (restyle only). This part is required. If a clearly better result needs a new structure, for example an outfit card that shows every piece at once instead of behind tabs, add it as a proposal with the exact A2UI JSON the agent would have to send. `APPROVED` and `REFUND` must be easy to tell apart; a refund protects the customer, it is not an error.

## What to deliver

- One complete `index.html` with all three screens, header, footer and all CSS embedded, containing every hook above unchanged and the `<!-- AITELIER PAGE SCRIPT -->` placeholder.
- CSS for every `a2ui-*` class in the component table.
- Optional: proposals for new A2UI structures with example JSON.
- Show these states: empty form, form with errors, each waiting stage, `APPROVED` with 1 and with 3 outfits, `REFUND`, a missing image, a very long product title, and mobile at 375px.
