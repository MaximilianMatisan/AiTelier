# Person 3: six things found in the preprod session

Found while fixing the worker on 31 Oct. Everything here is in `person3/`, so
none of it was changed — the evidence and the exact line are below so whoever
owns the stylist can decide. Items A and B are the two the customer noticed.

Line numbers are from `c4b3a2b`.

---

## A. `customer.owned` is never read  (reported as "owned items should satisfy a layer")

The customer says they already own black slim jeans. The result comes back
`REFUND` with `missing required layers: bottom`.

**`owned` is not ignored in one place — it is not read anywhere in Person 3.**

```
$ grep -rn "owned" person3/app/ person3/scripts/
(no matches)
```

It does arrive. From a real run's `01-input.json`:

```json
"customer": { "owned": ["black slim jeans"], ... }
```

How the refusal happens:

1. `orderToCustomer` (Person 1) puts the customer's brief into
   `customer.fit_description`, so the LLM reads "I already own black slim jeans".
2. The LLM does the sensible thing and leaves the bottom out of the outfit.
3. `required_layers` still contains `bottom`. It is taken from
   `options["required_layers"]` when set, and otherwise derived from the
   season, climate and `fit_description` text (`app/models.py:102`).
4. `app/services/resolver.py:109` compares it against the layers actually
   chosen and raises:

```python
present = {value["layer"] for value in chosen}
missing = [layer for layer in request.required_layers if layer not in present]
if missing:
    raise ValueError(f"missing required layers: {', '.join(missing)}")
```

So the LLM is punished for honouring the brief. Every outfit fails, every
guarantee reports "no outfit passed", and the customer gets a refund for an
order that was fillable.

**Fix:** treat a layer the customer already owns as satisfied — either drop it
from `required_layers` in `app/models.py:102`, or let `present` include owned
layers in `resolver.py:109`. Mapping `"black slim jeans"` to `bottom` needs the
same keyword matching Person 1 already does in `logic/data/normalize.js`
(`categoryOf`), which is worth reusing rather than writing twice.

**Stopgap available on Person 1's side:** `options.required_layers` is honoured
when set, so Person 1 could compute it and leave owned layers out. Not done,
because it would mean duplicating the season-based derivation in
`app/models.py` and the two would drift. Say the word if you want it anyway.

---

## B. The same item is used in every outfit  (reported as "add a diversity constraint")

`app/services/resolver.py:73` creates the "already used" set **inside** the
per-outfit loop:

```python
for index, draft in enumerate(selection.outfits):
    try:
        chosen: list[dict[str, Any]] = []
        used: set[str] = set()          # <- reset for every outfit
        for selected in draft.items:
            ...
            if item.item_id in used:
                raise ValueError(f"duplicate item {item.item_id}")
```

So it only stops an item appearing twice *within* one outfit. Nothing stops
look-1 and look-2 being the same four garments.

**Fix:** hoist `used` above the outfit loop. One caveat: an outfit that raises
part-way must not consume its items, or a later outfit loses garments to a
look that was thrown away. Collect the ids locally and merge them into the
shared set only once the outfit has validated.

---

## C. The refund tells the customer the wrong money

`app/graph.py:362`:

```python
"refund": {"amount": 6, "currency": "ADA", "recommended": True, "executed": False},
```

Rendered at `app/graph.py:390` and `app/services/a2ui.py:286`, so a refunded
result reads:

```
## Refund recommendation
6 ADA recommended; not executed by Person 3.
```

The escrow does not hold 6 ADA. It holds **1 test USDM**, and `paid-task.mjs`
throws rather than proceed if the signed quote says anything else:

```js
payment.RequestedFunds[0].unit !== USDM || payment.RequestedFunds[0].amount !== "1000000"
  → "Signed quote differs from 1 test USDM"
```

"recommended; not executed" also undersells it: nothing needs to recommend
anything. When no result is submitted, `submitResultTime` lapses and the chain
returns the funds on its own.

**Not customer-visible right now.** Since `bafffd4` a REFUND is never
submitted, so this markdown does not reach anyone, and an APPROVED result has
`refund: null` and no refund section. It is latent, not live — but it is wrong
in the one place a payments demo should be right.

---

## D. The refusal reason repeats itself once per outfit

`app/graph.py:350`:

```python
reason = "No outfit passed all five guarantees"
if ...:
    reason = "; ".join(state["feedback"][:3])
```

The feedback entries are per-outfit, so the same failure is stated twice:

```
look-1 budget: 302.90 EUR <= 60.00 EUR; look-2 budget: 332.80 EUR <= 60.00 EUR
```

Both looks broke the same guarantee for the same reason. Worth collapsing to
one sentence plus the worst case, the way the warnings now are.

---

## E. One `GUARANTEE_ASSUMED` per shop

`app/normalize.py:455` emits a warning per shop:

```python
_warning(warnings, "GUARANTEE_ASSUMED", f"shop {shop_id} assumed guaranteed")
```

An ordinary run produced 21 of them, and the submitted markdown listed every
one — 442 characters of `GUARANTEE_ASSUMED; GUARANTEE_ASSUMED; ...` ahead of
the outfit.

**Already handled downstream**, so this is not urgent: `collapseWarnings` in
`logic/lead-agent.mjs` folds repeats before the result is submitted, and the
customer now reads `GUARANTEE_ASSUMED x21, MISSING_DESCRIPTION, LLM_FALLBACK`
in 66 characters. Fixing it at the source — one warning naming the shops, or a
count — would be better, and the downstream fold can stay as a safety net.

---

## F. `a2ui` still points at `127.0.0.1`

`app/config.py:80` defaults the artifact base to `http://127.0.0.1:21951`, so
the look boards are addressed locally:

```
http://127.0.0.1:21951/artifacts/<task_id>/look-1-board.jpg
```

The two surfaces the customer actually reaches are fine:

- the published page (`logic/result-page.mjs`) uses the shops' own CDN URLs —
  zero local addresses in the built `index.html`
- the Sokosumi markdown has its images embedded as `data:` URIs by
  `embedImages` before submission

But `result.json`'s `a2ui` field holds **5** local URLs, so anything rendering
A2UI from somewhere other than this machine shows broken images.

**Note:** until `c4b3a2b` the artifact folder was the same for every run
(`task_id` was never set, so it fell back to `aitelier-catalog-demo`) and two
Tasks running at once overwrote each other's look boards. `task_id` is now the
real Task id, so each run has its own folder — worth knowing if you cached any
artifact paths.
