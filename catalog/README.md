# Catalogue (Person 1 — data layer)

Real products from real EU shops, normalised to the agreed schema (Frame 16).
Everything here is fetched from the shops' public Shopify product feed.

## Files

| File | What |
| --- | --- |
| `shops.seed.json` | The 37 shops. Person 2 keys `trust.json` off these `id`s. |
| `cache/products.json` | **The handover artifact.** Normalised items, one array. |
| `cache/raw/<shop_id>.json` | Untouched feed responses, so the demo runs with no network. |
| `cache/person3.input.json` | 100-item sample in Person 3's envelope shape, for smoke tests. |

## Commands

```sh
node logic/data/collect.js                 # all shops, live, rewrites raw + products.json
node logic/data/collect.js --shop afew     # one shop
OFFLINE=1 node logic/data/collect.js       # rebuild products.json from raw only
node logic/data/refetch.js <item-id>       # fresh stock/price for one item
node logic/data/to_person3.js --limit 100  # emit Person 3's envelope shape
node logic/data/refetch.js <item-id> --person3   # final-check record, contract section 9
MAX_PAGES=4 node logic/data/collect.js     # widen (default 2 pages = 500 products/shop)
```

Politeness: one request at a time per shop, 500 ms between pages, 10 s timeout,
`User-Agent: OutfitAgent-Hackathon/0.1 (TUM Blockchain Hackathon)`.

## Shops

All 37 answer `/products.json` and price in EUR (verified via `/cart.js`). 84 candidates were
probed in total; 47 were rejected because the feed is closed (403/404/410/429) or the shop prices
in another currency (Velasca USD, Won Hundred DKK, Les Deux unconfirmed).

Shoes in EU sizing: **asphaltgold, afew, overkill, eytys** (premium) and **saye, naevegan, ecoalf,
ethletic, womsh, zeta, flamingoslife, ideight** (affordable).
Numeric waist sizing (e.g. `32`): **overkill, norseprojects, mfpen, knowledgecotton**.

### Why a public feed and not scraping

Every candidate is reached through `/products.json`, never by parsing product pages:

- The feed carries `variant_id`, which is the only way to build the cart permalink that
  guarantee 4 depends on. Product HTML usually does not expose it.
- One shop costs one seed entry, not a bespoke parser that breaks when the site is restyled.
- `available` is an explicit field; HTML would have to be guessed at.
- Shops that closed their feed (Asket, NN07, Samsøe, Nudie, Wood Wood and others) said no.
  We do not route around that.

A WooCommerce Store API probe (`/wp-json/wc/store/v1/products`) was run across the same
candidates and returned nothing usable, so the collector stays Shopify-only.

## Known limits — read these before trusting a guarantee

1. **Stock is boolean, not a count.** Shopify's feed has `available: true/false` and no quantity.
   `stock_kind` is `"boolean"` and `stock` values are only ever `1` or `0`.
   Guarantee 2 therefore means "buyable in that size", not "N in warehouse".
2. **Items with no buyable size are dropped at collect time.** Every item in `products.json`
   is in stock in at least one size, so guarantee 2 can only fail on the *customer's* size.
3. **`/products.json` is CDN-cached and can be minutes stale.** `refetch()` hits
   `/products/{handle}.js` first, which is fresher. Always refetch before asserting a guarantee.
4. **Cart permalinks cannot be verified by the agent.** `https://{domain}/cart/{variant_id}:{qty}`
   is the documented Shopify format and the `variant_id`s here are real, but every shop returns
   **403 to a non-browser client on the `/cart/` path** (bot protection). Product pages answer 200
   to our User-Agent, all 12 of them.
   → **Guarantee 4 must be derived from `refetch()` (`url_ok` + the size being available),
   not from an HTTP check on the cart link.** Have a human click one cart link in a browser
   once before the demo.
5. **Category and theme are keyword heuristics** (the tables at the top of `logic/data/normalize.js`).
   Themes and seasons read the title and `product_type` only — **not tags.** Shop tags carry
   customs and logistics junk: asphaltgold tags every jersey tee `"knitted or crocheted"` (an HS
   code), which made Nike t-shirts classify as `old_money` until tags were excluded.
   Tune the tables, not the mapper.
6. **`delivery_days` is an estimate** from `shops.seed.json`. The feed does not carry it.
7. **Sizes are normalised** (`Medium`→`M`, `EU 43 1/3`→`43`, `W32`→`32`). Fractional shoe sizes
   lose the fraction. Products without a size option are stored under `"ONE"`.
8. **One colour per size.** When a product has both Colour and Size options, `variants[size]`
   points at the *cheapest available* variant for that size, so two sizes of one product can be
   different colours.
9. **Duplicates are real.** Shops list each colourway as its own product, so similar names repeat.

## Person 3 adapter

`PERSON3_INPUT_CONTRACT.md` v1.0 uses different field names from the Frame 16 schema we agreed
on. Five of its six required item fields differ, and their normalization matrix (section 7)
normalizes *values*, not field *names* - so our items would be rejected or degraded if sent raw.

`logic/data/to_person3.js` converts on the way out. **`catalog/cache/products.json` keeps the
agreed Frame 16 shape**, because Person 2 consumes that. Nothing was renamed in place.

| Frame 16 (ours) | Person 3 v1.0 |
| --- | --- |
| `id` | `item_id` |
| `name` | `title` |
| `vendor` | `brand` |
| `category: "outer"` | `category: "outerwear"` — their slot list has no `outer`, so it would have become `other` and stopped satisfying a required slot |
| `price_eur: 49` | `price: {amount: 49, currency: "EUR"}` |
| `url` | `product_url` |
| `image` (one string) | `images: [{url, role: "front"}]` |
| `stock: {M: 1}` | `sizes: [{label: "M", in_stock: true}]` |
| `themes: ["old_money"]` | `style.style_tags: ["old-money"]` |
| `source.fetched_at` | `collected_at` |
| `variants`, `seasons`, `stock_kind` | kept under `raw` (preserved, never sent to the LLM) |

Descriptions are pulled from `body_html` in the raw cache (89% coverage) and stripped to plain
text, so `products.json` keeps its agreed shape.

The adapter emits **our half** of the envelope — `contract_version`, `currency`, `shops`, `items`.
Person 3 adds `task_id`, `customer` and `options`.

Contract **section 9** ("Final-check input from Person 1") is a second surface, and `refetch()`
does not match it either. `toPerson3Check(item, fresh, shop)` converts, and
`node logic/data/refetch.js <item-id> --person3` prints it:

| `refetch()` | Section 9 |
| --- | --- |
| `id` | `item_id` |
| `fetched_at` | `checked_at` |
| `price_eur` | `price: {amount, currency}` |
| `stock: {M: 1, L: 0}` | `sizes_in_stock: ["M"]` + `availability` |
| `url_ok: false` | `availability: "unknown"` |
| `source: "cache"` | `stale: true` |

**`stale` matters for the offline demo.** Section 9 says a stale record fails strict guarantees.
An `OFFLINE=1` run therefore returns `stale: true` and, with `strict_guarantees: true`, every
outfit is refused. That is the honest result — a cached answer cannot prove live stock — but it
means **the offline fallback and strict mode cannot both be on during the demo.** Decide which.

### What the adapter cannot fix

1. **The contract caps a request at 100 items and 30 shops** (section 11) and we hold 8652 items
   across 37 shops. `--limit` samples round-robin within the 30-shop cap for smoke tests; the real
   shortlist is Person 2's filter step (`--in <shortlist.json>`), **which must also stay within
   30 shops**.
2. **`options.fit_mode` must be `size_only`.** The canonical envelope uses `measurements`, which
   needs per-size `measurements_cm`. The feed has no garment measurements at all.
3. **No `guarantee` on any shop** — that is Person 2's `catalog/trust.json`. Careful: their
   section 5 treats an **absent guarantee as guaranteed** with only a `GUARANTEE_ASSUMED`
   warning. Until Person 2 wires trust in, shop trust silently passes.

## Shipping is estimated, deliberately high

The product feed carries no shipping at all, and `/cart/shipping_rates.json` answers `200` with an
empty list because Shopify only computes rates for a session that already holds a cart. Building a
cart on 37 shops to read their rates is a write to someone else's store, so it was not done.

`shops.seed.json` therefore carries a hand-entered estimate per shop, flagged `estimated: true`
and carried through to Person 3:

```json
"shipping": { "amount_eur": 8.0, "ships_to": ["DE"], "estimated": true }
```

Both fields are **conservative on purpose**:

- The **amount is set high** (5 EUR domestic, up to 20 EUR from the UK). Guarantee 1 is "total
  within budget", so an estimate above the real cost can never break it; an estimate below it
  would let us promise a total the customer then exceeds.
- **`ships_to` is narrowed to `["DE"]`**, the demo's destination. Guarantee 5 then fails closed
  for any other destination instead of passing on an assumption.

Replace these with measured values before trusting G1 or G5 outside the demo.

## Budget finding — resolved

The first 12-shop seed was all premium EU labels, and the demo order (`old_money`, `autumn`,
top `M` / waist `32` / shoe `43`, budget 300 EUR, avoid neon+polyester) could not be met: two
independent outfits cost **686 EUR** at the cheapest.

Adding 25 affordable shops fixed it. The same order now matches **910 items across 32 shops**:

| Scenario | Total | |
| --- | --- | --- |
| Two outfits, nothing shared | 401.18 EUR | over |
| Two outfits sharing bottom and shoes, two tops | 206.78 EUR | **within budget** |
| The same plus one outer layer | 287.68 EUR | **within budget** |

Cheapest matching pieces are now top 12 EUR (thokkthokk), bottom 59.98 (knowledgecotton),
shoes 99.90 (ecoalf), outer 80.90 (armedangels). **The 300 EUR demo order stands**, as long as the
stylist shares pieces across outfits, which is what a capsule wardrobe does anyway.
