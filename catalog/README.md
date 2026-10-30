# Catalogue (Person 1 — data layer)

Real products from real EU shops, normalised to the agreed schema (Frame 16).
Everything is fetched from the shops' public Shopify product feed — nothing is scraped.

**8725 items across 36 shops.** Tops 4496, bottoms 1755, shoes 1285, outerwear 1189.
Themes: casual 6007, old\_money 1513, streetwear 1281. Prices 5.50–1995 EUR.
Every item carries an image and is in stock in at least one size; 8305 carry a description.

## Files

| File | What |
| --- | --- |
| `shops.seed.json` | The 36 shops. Person 2 keys `trust.json` off these `id`s. |
| `cache/products.json` | **The handover artifact.** Normalised items, one array. |
| `cache/raw/<shop_id>.json` | Untouched feed responses, so the demo runs with no network. |
| `cache/person3.input.json` | 100-item sample in Person 3's envelope shape, for smoke tests. |

## Commands

```sh
node logic/data/collect.js                       # all shops, live, rewrites raw + products.json
node logic/data/collect.js --shop afew           # refresh one shop, keep the others
OFFLINE=1 node logic/data/collect.js             # rebuild products.json from raw only
MAX_PAGES=4 node logic/data/collect.js           # widen (default 2 pages = 500 products/shop)

node logic/data/refetch.js <item-id>             # fresh stock/price for one item
node logic/data/refetch.js <item-id> --person3   # same, as a section 9 final-check record

node logic/data/to_person3.js --limit 100        # emit Person 3's envelope shape
node logic/data/to_person3.js --in shortlist.json
node logic/data/refresh-service.mjs --port 8787   # live re-check for the final check
node logic/result-page.mjs --run catalog/cache/run   # the page the customer reads
```

Politeness: one request at a time per shop, 500 ms between pages, 10 s timeout,
`User-Agent: OutfitAgent-Hackathon/0.1 (TUM Blockchain Hackathon)`.

`npm test` covers this layer from `catalog-data.test.mjs`: the catalogue invariants (every
seeded shop present, unique ids, no zero prices, a variant id exactly for each in-stock size),
the normalisation heuristics, and conformance to the Person 3 contract. Each test was checked
against a deliberately reintroduced bug, so it fails when the thing it guards breaks.

## The item schema

One entry of `cache/products.json`. Field names are the Frame 16 agreement — **do not rename
them in place**; the Person 3 adapter converts on the way out instead.

A real entry, shortened only in the image URL:

```json
{
  "id": "knowledgecotton-16271018787151",
  "shop_id": "knowledgecotton",
  "name": "Bora wide corduroy pant - Burgundy",
  "vendor": "KnowledgeCotton Apparel - WMN",
  "description": "These corduroy pants combine timeless design with a relaxed silhouette, ...",
  "category": "bottom",
  "themes": ["old_money"],
  "seasons": ["autumn", "winter"],
  "price_eur": 139.95,
  "stock": { "26": 0, "30": 1, "31": 1, "32": 1, "33": 1, "34": 0 },
  "stock_kind": "boolean",
  "variants": { "30": 58460636807503, "31": 58460636840271,
                "32": 58460636873039, "33": 58460637266255 },
  "delivery_days": 4,
  "url": "https://www.knowledgecottonapparel.com/products/bora-wide-corduroy-pant-burgundy",
  "image": "https://cdn.shopify.com/s/files/1/0601/1797/5218/files/Bora_wide...jpg",
  "source": { "type": "shopify_products_json",
              "handle": "bora-wide-corduroy-pant-burgundy",
              "fetched_at": "2026-10-30T12:29:58.455Z" }
}
```

- `category` is one of `top | bottom | shoes | outer`.
- `description` is `body_html` stripped to plain text, kept at full length and `null` when the
  shop wrote none (420 of 8725). Consumers cap it: the Person 3 adapter cuts at 2000.
- `stock` covers every size; `variants` only the buyable ones, so `variants[size]` exists
  exactly when `stock[size] === 1`.
- `variants[size]` is the Shopify variant id — the cart permalink is
  `https://{domain}/cart/{variant_id}:{qty}`, several items joined with `,`.

## Shops

All 36 answer `/products.json` and price in EUR (confirmed via `/cart.js`), and their product
pages answer `200` to our User-Agent. 84 candidates were probed; the rest either closed their
feed (403/404/410/429) or price in another currency (Velasca USD, Won Hundred DKK, Les Deux
unconfirmed). **ID.EIGHT** passed every check but was dropped anyway: its titles and
`product_type` are bare model names ("URIDURI", "MARU") with no category word anywhere, so
nothing in its 62 products can be classified.

Shoes in EU sizing: **asphaltgold, afew, overkill, eytys** (premium) and **saye, naevegan,
ecoalf, ethletic, womsh, zeta, flamingoslife, ideight** (affordable).
Numeric waist sizing (e.g. `32`): **overkill, norseprojects, mfpen, knowledgecotton**.

### Why a public feed, not scraping

- The feed carries `variant_id`, the only way to build the cart permalink that guarantee 4
  depends on. Product HTML usually does not expose it.
- One shop costs one seed entry, not a parser per shop that breaks on a restyle.
- `available` is an explicit field; HTML would have to be guessed at.
- Shops that closed their feed (Asket, NN07, Samsøe, Nudie, Wood Wood and others) said no.
  We do not route around that.

A WooCommerce Store API probe (`/wp-json/wc/store/v1/products`) over the same candidates
returned nothing usable, so the collector stays Shopify-only.

## Known limits — read these before trusting a guarantee

1. **Cart permalinks cannot be verified by the agent.** The format is documented and the
   `variant_id`s are real, but every shop returns **403 on the `/cart/` path** to a non-browser
   client. Product pages answer 200.
   → **Derive guarantee 4 from `refetch()` — `url_ok` *and* the size available *and*
   `source === "live"`** — never from an HTTP check on the cart link. The `source` part matters:
   a cache read returns `url_ok: true` because it found the product record, but it cannot prove
   the page still answers. `toPerson3Check` already folds this into `stale`. Have a human click
   one cart link in a browser before the demo.
2. **Stock is boolean, not a count.** The feed has `available: true/false` and no quantity, so
   `stock` values are only ever `1` or `0`. Guarantee 2 means "buyable in that size", not
   "N in warehouse".
3. **`/products.json` is CDN-cached and can be minutes stale.** `refetch()` hits
   `/products/{handle}.js` first, which is fresher. Always refetch before asserting a guarantee.
   Its live attempts share an **8 s budget**, after which it falls back to the cache. A shop that
   accepts the connection and then stalls would otherwise cost a 10 s timeout on each of up to
   three attempts — ~30 s for one item, against the 90 s the contract allows for the whole
   request. Measured: 8.02 s against a stalled shop, 63 ms when the network is simply down
   (DNS fails immediately), 0.5 s on the happy path.
4. **Items with no buyable size are dropped at collect time**, so guarantee 2 can only fail on
   the *customer's* size.
5. **Category, theme and season are keyword heuristics** (tables at the top of
   `logic/data/normalize.js`). Tune the tables, not the mapper. Two rules keep them honest:
   - **Tags are a fallback, never the first source.** Themes and seasons ignore them entirely;
     category only reaches for them when the title and `product_type` say nothing. Shop tags
     carry customs and logistics junk — asphaltgold tags every jersey tee
     `"knitted or crocheted"` (an HS code), which classified Nike t-shirts as `old_money`.
   - **Short keywords match whole words only** (`WHOLE_WORD_ONLY`). Plain substring matching
     turned 600+ t-shirts into trousers, because `"style:Shortsleeves".includes("short")`, and
     read `"steel gray"` as a tee. `CATEGORY_PHRASES` handles the rest: "boot cut" is a trouser
     cut, not footwear.
6. **Sizes are normalised** (`Medium`→`M`, `EU 43 1/3`→`43`, `W32`→`32`). Fractional shoe sizes
   lose the fraction. Products with no size option are stored under `"ONE"`. A label like
   `"M/L"` is registered under both `M` and `L`, pointing at the same variant, because the
   garment fits a customer asking for either. A numeric `"32/34"` is a waist and a leg length,
   not two sizes, so it stays `32` — the variant we link to has one specific leg length.
7. **The size option is found by word, not by exact name.** Shops call it `Size`, `Größe`,
   `Damen Bekleidung Größe`, `Tamanhos` or `Waist`. `Title` is Shopify's name for a product with
   no options and never counts.
8. **Bottoms use two size systems.** 894 are waist-sized, 713 letter-sized. A customer giving a
   waist measurement can only match the first group, so a `waist 32` brief reaches 293 of 1755
   trousers. Mapping waist to letter sizes is a fit judgement and has not been made here.
9. **One colour per size.** When a product has both Colour and Size options, `variants[size]`
   points at the *cheapest available* variant for that size, so two sizes of one product can be
   different colours.
10. **Duplicates are real.** Shops list each colourway as its own product, so similar names repeat.
11. **`delivery_days` is an estimate** from `shops.seed.json`; the feed does not carry it.

## Person 3 adapter

`PERSON3_INPUT_CONTRACT.md` v1.0 uses different field names from the Frame 16 schema. Five of
its six required item fields differ, and its normalization matrix (section 7) normalizes
*values*, not field *names* — so our items would be rejected or degraded if sent as they are.

`logic/data/to_person3.js` converts on the way out. **`cache/products.json` keeps the agreed
Frame 16 shape**, because Person 2 consumes that. Nothing was renamed in place.

### Items

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

Descriptions ride along in `products.json` as `description`, so the filter step reads them
without opening the raw cache. The adapter only caps them at the contract's 2000 characters.

The adapter emits **our half** of the envelope — `contract_version`, `currency`, `shops`,
`items`. Person 3 adds `task_id`, `customer` and `options`.

### Final-check record (section 9)

Section 9 ("Final-check input from Person 1") is a second surface, and `refetch()` does not
match it either. `toPerson3Check(item, fresh, shop)` converts;
`node logic/data/refetch.js <item-id> --person3` prints it.

| `refetch()` | Section 9 |
| --- | --- |
| `id` | `item_id` |
| `fetched_at` | `checked_at` |
| `price_eur` | `price: {amount, currency}` |
| `stock: {M: 1, L: 0}` | `sizes_in_stock: ["M"]` + `availability` |
| `url_ok: false` | `availability: "unknown"` |
| `source: "cache"` | `stale: true` |

**`stale` matters for the offline demo.** Section 9 fails strict guarantees on a stale record,
so an `OFFLINE=1` run with `strict_guarantees: true` refuses every outfit. That is the honest
result — a cached answer cannot prove live stock — but it means **the offline fallback and
strict mode cannot both be on during the demo.**

### What the adapter cannot fix

1. **The contract caps a request at 100 items and 30 shops** (section 11); we hold 8725 items
   across 36 shops. `--limit` samples round-robin within the 30-shop cap for smoke tests. The
   real shortlist is Person 2's filter step (`--in <shortlist.json>`), **which must also stay
   within 30 shops.**
2. **`options.fit_mode` must be `size_only`.** The canonical envelope uses `measurements`, which
   needs per-size `measurements_cm`. The feed has no garment measurements at all.
3. **No `guarantee` on any shop** — that is Person 2's `catalog/trust.json`. Their section 5
   treats an **absent guarantee as guaranteed**, with only a `GUARANTEE_ASSUMED` warning, so
   shop trust silently passes until it is wired in.

## Shipping is estimated, deliberately high

The feed carries no shipping, and `/cart/shipping_rates.json` answers `200` with an empty list
because Shopify only computes rates for a session that already holds a cart. Building carts on
36 shops to read their rates is a write to someone else's store, so it was not done.

`shops.seed.json` carries a hand-entered estimate per shop, flagged `estimated: true` and
carried through to Person 3:

```json
"shipping": { "amount_eur": 8.0, "ships_to": ["DE"], "estimated": true }
```

Both fields are **conservative on purpose**:

- The **amount is set high** (5 EUR domestic, up to 20 EUR from the UK). Guarantee 1 is "total
  within budget", so an estimate above the real cost can never break it; an estimate below it
  would let us promise a total the customer then exceeds.
- **`ships_to` is narrowed to `["DE"]`**, the demo's destination, so guarantee 5 fails closed
  elsewhere instead of passing on an assumption.

Replace these with measured values before trusting G1 or G5 outside the demo.

## Budget finding — resolved

The first seed was 12 premium EU labels, and the demo order (`old_money`, `autumn`, top `M` /
waist `32` / shoe `43`, budget 300 EUR, avoid neon+polyester) could not be met: two independent
outfits cost **686 EUR** at the cheapest.

Adding 25 affordable shops fixed it. The same order now matches **932 items across 32 shops**:

| Scenario | Total | |
| --- | --- | --- |
| Two outfits, nothing shared | 401.18 EUR | over |
| Two outfits sharing bottom and shoes, two tops | 206.78 EUR | **within budget** |
| The same plus one outer layer | 287.68 EUR | **within budget** |

Cheapest matching pieces: top 12 EUR (thokkthokk), bottom 59.98 (knowledgecotton), shoes 99.90
(ecoalf), outer 80.90 (armedangels). **The 300 EUR demo order stands**, as long as the stylist
shares pieces across outfits — which is what a capsule wardrobe does anyway.

## Checked against Person 3's service

`person3/scripts/run_catalog.py --catalog catalog/cache/person3.input.json` reads this layer's
output directly, so the adapter is the live integration point. Running Person 3's own
`classify_slot` over all 8725 converted items:

| Their layer | base | mid | outer | bottom | shoes | other |
| --- | --- | --- | --- | --- | --- | --- |
| items | 3413 | 963 | 1192 | 1417 | 1296 | 313 |

**All five required layers are covered**, so no outfit fails for want of a layer. Their
normalisation reads the title as well as `category`, which is why our single `top` splits into
`base` and `mid`.

Their layer disagrees with our category on **470 of 8725 items (5.4%)**, down from 8.0% before
the keyword fixes above. What is left is mostly on their side and worth telling them:

- **313 of our `bottom` items land in `other`**, which satisfies no required layer — e.g.
  "ROA x Wrangler Denim Cargo Washed Pattern". That is 313 real trousers the stylist cannot use.
- **112 more become `base`**, including German titles like "HERRINGBONE BARREL LEG HOSE"
  (*Hose* = trousers) and "Nike Tailored Dri-FIT Loose Short".
- 22 of our tops become `shoes` on the word "Oxford", which is both a shirt fabric and a shoe
  style — genuinely ambiguous.

## The live re-check service

Person 3's final check decides guarantees 2, 3 and 4. Without a service to ask,
`person3/app/services/checks.py` takes this branch:

```python
if live_check_mode == "snapshot" or not person1_refresh_url:
    return _snapshot(item, stale=False)
```

It reads our cached catalogue and reports `stale: false`, so stock and price are
claimed rather than checked. `logic/data/refresh-service.mjs` is the service that
branch waits for:

```sh
node logic/data/refresh-service.mjs --port 8787

PERSON1_REFRESH_URL=http://127.0.0.1:8787/refresh LIVE_CHECK_MODE=live \
PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs
```

It takes `{"items":[{item_id, shop_id, product_url}]}`, runs `refetch()` on each
and answers with section 9 records. An item it cannot look up comes back
`availability: "unknown"`, `stale: true` — never as in stock.

Measured with the demo shortlist and a 500 EUR budget: 50 records, all
`source: person1_refresh` and `stale: false`, result APPROVED with two outfits
and all five guarantees passing. The same run in snapshot mode takes 1 second
instead of 15, which is the difference between asking the shops and not.

## The result page

`logic/result-page.mjs` turns a finished run into one self-contained HTML file,
and run-pipeline writes it as the last step. It is not a lookbook: the customer
is about to let money go, so the page leads with what was checked.

Each of the five guarantees shows its own verdict and wording, and the two that
depend on live data say how many items were re-queried at the shop and when.
Every garment carries its own line - `checked at the shop 2026-10-30 16:47:42
UTC · in_stock` - and one cart link per shop builds the Shopify permalink from
the variant ids kept in `raw`. A REFUND page says nothing was charged and
offers no cart at all.

It closes with what the numbers rest on: stock is available-or-not and never a
count, shipping is a deliberately high estimate rather than a quote.

Shop titles are third-party text and are escaped before they reach the page.

## Open items for the team

These are decisions Person 1 cannot make alone:

1. **Person 3 drops 313 of our trousers into the `other` layer**, which satisfies no required
   layer, and reads 112 more as `base`. Their `classify_slot` needs cargo/denim trousers and
   German titles (*Hose*). Measured above.
2. **Person 2's `catalog/trust.json` is not there yet.** Until it is, every shop reaches
   Person 3 without a `guarantee`, and their contract reads that as guaranteed. Shop trust —
   one of the five paid guarantees — currently passes without being checked.
3. **Set `options.fit_mode` to `size_only`.** `measurements` cannot work with feed data.
4. **Pick one: offline fallback or `strict_guarantees`.** They contradict each other (see
   "Final-check record" above).
5. **Person 2's shortlist must stay within 100 items and 30 shops.**
6. **Replace the shipping estimates with measured values** if G1 or G5 are to mean anything
   beyond the demo.
