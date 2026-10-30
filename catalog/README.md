# Catalogue (Person 1 — data layer)

Real products from real EU shops, normalised to the agreed schema (Frame 16).
Everything here is fetched from the shops' public Shopify product feed.

## Files

| File | What |
| --- | --- |
| `shops.seed.json` | The 12 shops. Person 2 keys `trust.json` off these `id`s. |
| `cache/products.json` | **The handover artifact.** Normalised items, one array. |
| `cache/raw/<shop_id>.json` | Untouched feed responses, so the demo runs with no network. |

## Commands

```sh
node logic/data/collect.js                 # all shops, live, rewrites raw + products.json
node logic/data/collect.js --shop afew     # one shop
OFFLINE=1 node logic/data/collect.js       # rebuild products.json from raw only
node logic/data/refetch.js <item-id>       # fresh stock/price for one item
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

## Budget finding (matters for the demo)

With the demo order (`old_money`, `autumn`, top `M` / waist `32` / shoe `43`, avoid neon+polyester)
there are **314 matching items**, but the cheapest possible pair of two fully independent outfits is
**686 EUR** — the stated **300 EUR budget cannot be met**. Cheapest matching pieces: top ~47, bottom
~135, shoes ~129. Two outfits sharing the bottom and shoes land at ~362 EUR.

If the order stays at 300 EUR, guarantee 1 fails, the escrow refunds, and we never demo a
*completed paid job* — which is the hackathon's hard requirement. Either raise the demo budget to
**~450–500 EUR**, or let the stylist build around `owned` items.
