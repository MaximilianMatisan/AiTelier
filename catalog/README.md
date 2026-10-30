# Catalogue (Person 1 — data layer)

Real products from real EU shops, normalised to the agreed schema (Frame 16).
Everything here is fetched from the shops' public Shopify product feed.

## Files

| File | What |
| --- | --- |
| `shops.seed.json` | The 12 shops. Person 2 keys `trust.json` off these `id`s. |
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

All 12 answer `/products.json` and price in EUR (verified via `/cart.js`).
Candidates that were checked and rejected: Asket, A Day's March, NN07, Samsøe, Wood Wood,
Nudie, Filippa K, Morjas, Holzweiler, Stutterheim, Sandqvist, Kaufmann (feed closed — 403/404/410);
Velasca (USD), Won Hundred (DKK).

Shoes in EU sizing come mainly from **asphaltgold, afew, overkill, eytys**.
Numeric waist sizing (e.g. `32`) comes mainly from **overkill, norseprojects, mfpen**.

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

1. **The contract caps a request at 100 items** (section 11) and we hold 3346. `--limit` samples
   round-robin across shops for smoke tests; the real shortlist is Person 2's filter step
   (`--in <shortlist.json>`).
2. **`shipping.default_amount` and `shipping.regions` are unknown.** The Shopify feed carries
   neither, so all 12 shops raise `SHIPPING_UNKNOWN`. Their G1 (budget) and G5 (delivery) need a
   value at the final check. Note `regions` means where a shop **ships to**, not where it is
   based — filling it with the shop's own country would fail G5 for every customer abroad, so it
   is left out. Either hand-enter shipping per shop in the seed, or relax G5 to `delivery_days`.
3. **`options.fit_mode` must be `size_only`.** The canonical envelope uses `measurements`, which
   needs per-size `measurements_cm`. The feed has no garment measurements at all.
4. **No `guarantee` on any shop** — that is Person 2's `catalog/trust.json`. Careful: their
   section 5 treats an **absent guarantee as guaranteed** with only a `GUARANTEE_ASSUMED`
   warning. Until Person 2 wires trust in, shop trust silently passes.

## Budget finding (matters for the demo)

With the demo order (`old_money`, `autumn`, top `M` / waist `32` / shoe `43`, avoid neon+polyester)
there are **314 matching items**, but the cheapest possible pair of two fully independent outfits is
**686 EUR** — the stated **300 EUR budget cannot be met**. Cheapest matching pieces: top ~47, bottom
~135, shoes ~129. Two outfits sharing the bottom and shoes land at ~362 EUR.

If the order stays at 300 EUR, guarantee 1 fails, the escrow refunds, and we never demo a
*completed paid job* — which is the hackathon's hard requirement. Either raise the demo budget to
**~450–500 EUR**, or let the stylist build around `owned` items.
