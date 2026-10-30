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

## Suggestions

Your call, these are only the shapes that fit the data:

- **Cap per slot, not per item.** Shoes and outerwear need a much higher ceiling
  than tops. Even a rough split (shoes 40 %, bottom 30 %, top 15 %) keeps every
  slot populated.
- **Or drop the price cap at the filter stage.** The filter's job is narrowing
  8725 items to at most 100 while keeping every required slot represented. The
  stylist does the budget arithmetic over a whole outfit, and the final check
  enforces guarantee 1. A cap here only removes options the stylist needs.
- **Either way, keep slot coverage as an invariant.** A shortlist missing a
  required slot cannot produce a result, so it is worth failing loudly inside
  the filter rather than passing it on.

`logic/run-pipeline.mjs` already warns at the handoff when a required slot is
missing, so this at least shows up at step 1 from now on.

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
