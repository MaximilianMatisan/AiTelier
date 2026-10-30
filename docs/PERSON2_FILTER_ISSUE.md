# candidateFilter: the shortlist never contains shoes

From Person 1 (catalogue) to Person 2 (filter). Found while wiring
`logic/run-pipeline.mjs`, which runs `candidateFilter.mjs` on the real catalogue.

## What happens

The filter returns a shortlist with **no shoes and no outerwear**, every run.
Person 3 then cannot assemble a single complete outfit, refuses every look, and
the escrow refunds. The demo fails at step 3 of 7, and it reads like a stylist
problem when it is a filter problem.

```
matched 17 of 8725 candidates
slots: bottom:1  top:16
```

## Why

The model is told the total budget and the item count, and turns that into a
**per-item price cap**:

> "allocating the 300 EUR total budget across 6 items (50 EUR max each)"

That cap is applied to every slot equally. But the slots have very different
price floors. For the demo order (`old_money`, `autumn`, top M, waist 32,
shoe 43) the catalogue contains:

| slot | items | cheapest | p25 | median | items at or under 50 EUR |
| --- | --- | --- | --- | --- | --- |
| top | 725 | 12.00 | 95.00 | 130.00 | 8 |
| bottom | 61 | 59.98 | 119.95 | 120.00 | **0** |
| shoes | 30 | 99.90 | 149.00 | 180.00 | **0** |
| outer | 116 | 80.90 | 215.00 | 300.00 | **0** |

A 50 EUR cap can only ever return tops. The cheapest pair of shoes in the whole
matching set is 99.90 EUR, so **any per-item cap below 100 removes the shoe slot
entirely**, and with it every possible outfit.

## The budget is not the problem

The cheapest complete outfit costs **171.88 EUR** (top 12.00 + bottom 59.98 +
shoes 99.90). Two outfits that share the bottom and shoes come to 206.78 EUR,
and 287.68 EUR with an outer layer. All of that fits inside the 300 EUR budget.

The budget works. Dividing it evenly across items does not, because a pair of
shoes costs roughly eight times what the cheapest top costs.

## Five runs

Same catalogue, same brief:

| run | exit | cap the model chose | items | shoes |
| --- | --- | --- | --- | --- |
| 1 | 0 | 50 | 17 | 0 |
| 2 | 0 | 50 | 17 | 0 |
| 3 | 0 | 50 | 17 | 0 |
| 4 | 1 | — | — | — |
| 5 | 0 | 75 | 98 | 0 |

The cap is not stable between runs, but the shoe slot is empty in all of them,
including at 75 EUR.

## Three problems, not one

Reading `candidateFilter.mjs` through, the empty shoe slot is the visible
symptom of three separate things.

**1. The per-item cap is instructed, not hallucinated.** `SYSTEM_PROMPT` says it
twice:

```
- priceEur: {...}. maxAmount is the price for one item
- Respect the budget: maxAmount per item.
```

`matches()` then applies it as a hard filter on every candidate:

```js
if (maxAmount !== null && !(candidate.price_eur <= maxAmount)) return false;
```

The model is doing exactly what it was told. The instruction is the bug.

**2. `categoryCounts` is computed and then ignored.** The model is asked for it,
`reconcile` normalises it, and `applySelection` reports it back as `wanted` —
but the only code that would act on it is commented out:

```js
//   if (
//     Object.keys(selection.categoryCounts).length &&
//     !(candidate.category in selection.categoryCounts)
//   )
//     return false;
```

So nothing in the filter ever checks that a wanted slot produced any items.
That is why the shoe slot can empty out silently instead of failing.

**3. The Person 3 caps are passed but dropped.** `filterCandidates` calls

```js
applySelection(candidates, facets, selection, capsOf(options))
```

while the function is declared as

```js
export function applySelection(candidates, facets, selection) {
```

The fourth argument is discarded, `truncated` is hardcoded `false`, and the
`--max-items` flag has no effect. One run returned 98 items, which was luck: a
looser brief returns thousands, and Person 3's contract rejects anything over
100 items or 30 shops.

## A fix that holds up against the catalogue

Replace the per-item price cap with a slot quota. Instead of asking "is this
item cheap enough", ask "has every slot the customer needs got candidates".

1. Filter on theme, season and size as today. Keep a price bound, but at the
   **total budget**, not the budget divided by item count: no single garment may
   cost more than the whole brief.
2. Split the 100-item cap across the wanted categories in proportion to
   `categoryCounts`, with a floor of about 4 per slot, and take the cheapest of
   each slot.
3. Apply the shop cap, and fail loudly if a wanted slot ends up empty.

Simulated on the current catalogue with the demo brief and
`{top: 2, bottom: 2, shoes: 2, outer: 1}`:

```
after theme/season/size: 837 items
  top     quota  28   available  690
  bottom  quota  28   available   58
  shoes   quota  28   available   28
  outer   quota  14   available   61

items 98/100   shops 21/30
slots: top 28, bottom 28, shoes 28, outer 14   -> every wanted slot present

cheapest single outfit     171.88 EUR
two outfits, shared pieces 206.78 EUR
plus an outer layer        287.68 EUR   (budget 300)
```

The shortlist stays inside both contract caps, every slot is populated, and the
budget still works out. The price cap was never doing useful work: the stylist
does the budget arithmetic across a whole outfit and the final check enforces
guarantee 1.

One more thing the quota needs: for autumn, Person 3 requires the layers
`base, mid, outer, bottom, shoes`. The model currently asks for
`{top, bottom, shoes}` and never requests outerwear. Our `top` covers both
`base` and `mid`, but `outer` has to be in `categoryCounts` or the outer layer
has no candidates.

`logic/run-pipeline.mjs` warns at the handoff when a required slot is missing,
so this shows up at step 1 from now on either way.

## The separate flakiness

Run 4 above exited non-zero:

```
Candidate filter failed: Failed after 2 attempts.
Last error: AI_APICallError: Service Unavailable
```

That is the provider, not your logic, and the two retries were not enough. One
failure in five is a real risk on the demo path. Worth more retries with a
backoff, or a cached shortlist to fall back on.

## Reproduce

```sh
node --env-file-if-exists=.env candidateFilter.mjs \
  --user-info "autumn outfits, old money style, 2 outfits, budget 300 EUR in total, top size M, waist 32, shoes EU 43, slim fit" \
  --in catalog/cache/products.json --out /tmp/shortlist.json
```

Or the whole chain, which prints the slot warning:

```sh
node logic/run-pipeline.mjs
```

Catalogue facts behind the table are in [catalog/README.md](../catalog/README.md).
