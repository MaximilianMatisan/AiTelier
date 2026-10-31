# AiTelier — capsule wardrobe agent on Sokosumi

Built for the Cardano track of the TUM Blockchain & AI Hackathon (30–31 October 2026).
A customer hires the agent on Sokosumi with a short order in plain words or as JSON: budget,
number of outfits, style, season and sizes. The agent answers with complete outfits made of **real, in-stock products from
real EU shops**, each with its image, shop link, price and a reason for choosing it. Before an
outfit is returned, the agent checks five guarantees on it.

**The LLM decides, the code checks.** The model only chooses which catalogue values fit a brief
and which item IDs make an outfit. Everything money depends on (budget, sizes, stock, prices,
links, delivery) is settled by deterministic code. That is why we can tell whether a guarantee
holds.

## Current status

| Part | State |
| --- | --- |
| Sokosumi worker → pipeline | ✅ Every task, free or paid, runs through the pipeline |
| Step 0 · conversation | ✅ `logic/conversation.mjs`: several turns to collect the order, show the looks and confirm one; in the studio chat and in Sokosumi task comments |
| Step 1 · read and check the order | ✅ `logic/intake.mjs`; free text or JSON |
| Step 2 · real shop catalogue | ✅ 8725 items, 36 Shopify shops, cached in `catalog/cache/` |
| Step 3 · candidate filter | ✅ `candidateFilter.mjs` (LLM picks filters, code applies them) |
| Step 3a · customer profile | ✅ `logic/run-pipeline.mjs`: drops garments marked for the other gender, maps a waist size to the letter size shops use when that reaches a cheaper item |
| Step 3b · drop sizes the customer cannot buy | ✅ `logic/buyable.mjs` |
| Step 4 · shop trust check | ⚠️ `trustcheck.mjs` works on its own, **not yet in the pipeline** |
| Step 5 · stylist (LLM) | ✅ Person 3, `person3/`; outfits that misuse shorts are rejected by code |
| Step 6 · final check, five guarantees | ✅ Person 3; ⚠️ checks the cached snapshot unless the live re-check service runs |
| Step 7 · result page | ✅ `logic/result-page.mjs` writes one HTML page per run; ⚠️ not hosted yet, Sokosumi gets Markdown |
| Refund path | ✅ A `REFUND` result is not submitted, so the escrow returns the money |
| Step 8 · checkout | ⚠️ `logic/checkout.mjs` builds and checks the purchase; **no payment module wired in yet**, so a confirmed outfit is declined with its shop links |
| Local studio UI | ✅ `npm run ui`: chat with the stylist or fill the form, watch the stages, see the looks |
| Masumi payment (escrow, Preprod) | ⏳ Template code present, not set up; quote fixed at 1 test USDM |
| Trust check as an x402 service | ⏳ Not started |
| Image input (body photo) | ⏳ Not supported; the task description is text only |

`npm test` passes (200 tests, 2 of them marked todo); Person 3's `pytest` passes 30, skips 1.
The last measured end-to-end runs ended in `APPROVED` with a 500 EUR budget and in `REFUND`
with 300 EUR (see [Known limits](#known-limits)).

## How a task flows

```text
Sokosumi Task (order as free text or JSON)
  │
  ▼
worker.mjs ── polls tasks, runtime start / complete, paid flow
  │
  ▼
logic/lead-agent.mjs   pipelineAnswer(): same signature as client.mjs answer()
  │  1  logic/intake.mjs        check a JSON order, or pass free text on; refuse before anything runs
  ▼
logic/run-pipeline.mjs  one process per stage, output in catalog/cache/run/<task-id>/
  │  3  candidateFilter.mjs     catalog/cache/products.json -> shortlist.json (≤100 items, ≤30 shops)
  │                             and selection.json (what the model read out of the brief)
  │     logic/data/to_person3.js shortlist -> Person 3 envelope
  │  3a customer envelope        order or brief -> customer.json; drop the other gender, map sizes
  │  3b logic/buyable.mjs       keep only sizes the customer can buy
  │  5  person3 scripts.run_catalog   stylist + final check (6) -> person3/result.json
  │  7  logic/result-page.mjs   result.json -> index.html, the page the customer reads
  ▼
APPROVED: Markdown result -> runtime complete -> Sokosumi
REFUND:   nothing submitted -> submitResultTime lapses -> escrow refunds the buyer
```

A refused order returns the reasons from step 1 and starts nothing. A pipeline that fails or
overruns throws, so the paid flow never submits half a result. A run whose guarantees do not
hold throws `GuaranteesFailed`: the worker logs `Refund due, no result submitted` and the reason
is kept in the task journal. On the paid path the pipeline is stopped one minute before the
escrow's `submitResultTime`.

## Talking to the agent

An order no longer has to arrive complete. The chat collects it over several
turns, runs the pipeline when nothing is missing, shows the looks it found and
buys the one the customer confirms:

```text
collecting ──(order complete)──> ready ──"yes"──> styling ──> presented
                                   ▲                             │
            (change the brief) ────┘                      "outfit 2"
                                                                 ▼
   paid <──(payment module)── paying <────"yes"──────────── selected
```

The same dialogue runs on both surfaces, because `logic/conversation.mjs`
performs no I/O at all: a turn takes a state and a message and answers with the
new state, the text to show and one action for the surface to carry out.

- **Studio page** · `npm run ui`, tab *Talk to the stylist*. The page starts
  the run itself so it can show the stages while the pipeline works.
- **Sokosumi task comments** · every comment on a task is a turn. The task's own
  result seeds the conversation, so the first comment can be "buy outfit 2".
  One comment is answered exactly once, and a turn that was interrupted is
  never repeated — which is what keeps a payment from running twice. A restyle
  asked for in a comment runs in the worker's own loop, so the worker polls
  nothing else for the minute or two the pipeline takes.

What is said about products, prices and totals is written by code from Person
3's result, and a purchase needs a confirmation that `detectIntent()` reads.
A model is used for two things only: reading an order out of free text, and the
wording while the order is still being collected. With no model configured, or
one that is rate-limited, the dialogue carries on with the code reader alone.

### Paying for an outfit

`logic/checkout.mjs` turns the confirmed look into a purchase, checks it (one
currency, every item linked and priced, the items add up to the total, the total
inside the budget the customer confirmed, the guarantees held) and hands it to
the payment module named by `AITELIER_PAYMENT`:

```js
// logic/pay-cardano.mjs
export async function payOutfit(purchase, { signal } = {}) {
  return { status: "paid", txHash: "…", paidAmount: 1, paidCurrency: "USDM" };
}
```

```sh
AITELIER_PAYMENT=./logic/pay-cardano.mjs npm run ui   # the module
AITELIER_PAYMENT=mock npm run ui                      # demo: says "paid", moves nothing
npm run ui                                            # unset: declines, shows the links
```

The file's own header holds the full contract, including the shape of a
`Purchase` and the three answers a module may give. A purchase that fails a
check never reaches the module.

## Repository map

| Path | Owner | What |
| --- | --- | --- |
| `worker.mjs`, `client.mjs`, `start.mjs` | template | Sokosumi worker and the local Eve agent |
| `paid-task.mjs`, `settlement.mjs`, `payment-registration.mjs`, `agent-api.mjs` | template | Masumi payment, registration and MIP-003 API |
| `logic/lead-agent.mjs` | lead agent | Connects a Sokosumi task to the pipeline |
| `logic/intake.mjs` | lead agent | Step 1: order format and checks |
| `logic/conversation.mjs` | lead agent | Step 0: the dialogue — one state, one turn at a time, no I/O |
| `logic/chat-session.mjs` | lead agent | Keeps a conversation on disk, runs the pipeline a turn asks for |
| `logic/checkout.mjs` | lead agent | Step 8: the purchase, its checks and the payment module's contract |
| `comments.mjs` | lead agent | The chat on a Sokosumi task: one conversation per task thread |
| `logic/run-pipeline.mjs` | Person 1 | Chains all stages; builds the customer profile |
| `logic/result-page.mjs` | Person 1 | Step 7: one self-contained HTML result page per run |
| `logic/data/` | Person 1 | Catalogue collector, normaliser, live refetch and its HTTP service, Person 3 adapter |
| `catalog/` | Person 1 | Shop seed, cached catalogue, demo order and shortlist — see [catalog/README.md](catalog/README.md) |
| `candidateFilter.mjs` | Person 2 | Candidate filter |
| `trustcheck.mjs` | Person 2 | Shop trust check (imprint, policies, domain, LLM verdict) |
| `logic/buyable.mjs` | Person 2/3 | Drops unbuyable sizes before the stylist |
| `person3/` | Person 3 | Python stylist and final check — see [person3/README.md](person3/README.md) |
| `PERSON3_*.md` | Person 3 | Input and output contracts, global context |
| `ui/` | — | Local studio page: stylist chat, order form, stage progress, A2UI result |
| `agent/instructions.md` | — | Instructions for the plain-LLM fallback |

## Setup

Requirements: Node.js 24+, Python 3.12 (as in `person3/Containerfile`), Sokosumi CLI `1.0.4`.

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

In `.env`, set `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL` (and `ZAI_MODEL_PROVIDER_NAME`) for
your OpenAI-compatible model; the filter and the trust check use it. Give the stylist its own
key in `GEMINI_API_KEY` (`GEMINI_BASE_URL` and `GEMINI_MODEL` fall back to the `ZAI_` values).
Without it the stylist falls back to `ZAI_API_KEY`, both steps share one quota, and a single run
can make both fail with 429. `run-pipeline.mjs` prints which key each step uses and warns when
they are the same.

Set up Person 3's Python environment once:

```sh
python3.12 -m venv person3/.venv
person3/.venv/bin/pip install -e "person3[test]"
```

With [uv](https://docs.astral.sh/uv/), which fetches Python 3.12 if needed:

```sh
uv venv --python 3.12 person3/.venv
uv pip install --python person3/.venv/bin/python -e "person3[test]"
```

Use 3.12: the pinned `pydantic` does not build on newer interpreters such as 3.15.
The worker uses `person3/.venv/bin/python` automatically when it exists; `run-pipeline.mjs`
on its own needs `PYTHON=person3/.venv/bin/python`. Without a model key, the stylist runs in
deterministic mock mode, which is fine for a dry run.

Sokosumi account, Vendor, Coworker and runtime key: follow
[docs/tum-hackathon.md](docs/tum-hackathon.md) (sections 3–4), then set `COWORKER_ID` in `.env`.
Keep `PAID_TASKS_ENABLED=false` until payments are set up.

## Run

### The pipeline on its own

```sh
PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs --order catalog/order.json --out catalog/cache/run
```

The result is in `catalog/cache/run/person3/result.json`, the page the customer reads in
`catalog/cache/run/index.html`. When the filter's model provider is down or rate-limited, skip
the filter with the prepared shortlist:

```sh
PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs --order catalog/order.json --out catalog/cache/run --shortlist catalog/cache/shortlist.demo.json
```

To rebuild the result page from a finished run:

```sh
node logic/result-page.mjs --run catalog/cache/run
```

### Live re-checks in step 6

By default the final check decides stock and price on the cached catalogue. To re-query the
shops instead, start the refresh service and point Person 3 at it:

```sh
node logic/data/refresh-service.mjs --port 8787
```

```sh
PERSON1_REFRESH_URL=http://127.0.0.1:8787/refresh LIVE_CHECK_MODE=live PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs --order catalog/order.json --out catalog/cache/run
```

### The studio UI

```sh
npm run ui
```

Opens on <http://127.0.0.1:21960> (`AITELIER_UI_PORT` changes it). It checks the order with
step 1, runs the pipeline, shows each stage and renders the looks. One run at a time.

### As a Sokosumi Coworker

Terminal 1, the local Eve agent:

```sh
npm start
```

Terminal 2, the worker. Run only one worker per Coworker:

```sh
npm run worker
```

Terminal 3, create a task. The description is the order, in plain words:

```sh
sokosumi --preprod tasks create --personal --coworker-id YOUR_COWORKER_ID --status READY --json --description 'Two autumn outfits, old money style, budget 500 EUR, men, top M, waist 32, shoes EU 43.'
```

or as JSON, which step 1 checks field by field:

```sh
sokosumi --preprod tasks create --personal --coworker-id YOUR_COWORKER_ID --status READY --json --description '{"budget_eur": 500, "outfits": 2, "theme": "old_money", "season": "autumn", "sizes": {"top": "M", "waist": "32", "shoe_eu": "43"}, "fit": "slim", "gender": "men", "climate": "Munich, wet, 8-15 C"}'
```

Worker switches:

| Variable | Effect |
| --- | --- |
| `AITELIER_PIPELINE=false` | Answer with the plain LLM instead of the pipeline |
| `AITELIER_SHORTLIST=catalog/cache/shortlist.demo.json` | Skip the model-backed filter |
| `PYTHON=…` | Use another interpreter for Person 3 |
| `AITELIER_DEFAULT_BUDGET_EUR=500` | Budget assumed when a free-text order names none |

Each run writes its order, intermediate files and `pipeline.log` to
`catalog/cache/run/<task-id>/` (git-ignored).

### Trust check for a single shop

```sh
node trustcheck.mjs https://www.knowledgecottonapparel.com
```

Results are cached for 24 hours in `trustCache/<host>.json`.

## The order format

A task description is either free text or contains a JSON object.

**Free text** (at most 4000 characters) goes to the candidate filter as written. The filter
reads style, season, sizes and budget out of it. Sizes the customer wrote out ("waist 32",
"shoes EU 43") win over the filter's reading, and a size is only assigned when it is
unambiguous. Without a budget in the text, `AITELIER_DEFAULT_BUDGET_EUR` (500) is used and the
run log says so. Only an empty description is refused.

**JSON**: step 1 reads the first JSON object and checks every field below before anything runs.
[`catalog/order.json`](catalog/order.json) is a complete example.

| Field | Required | Rule |
| --- | --- | --- |
| `budget_eur` | yes | Positive, at most 10000; each outfit must fit in it |
| `outfits` | yes | 1–10 |
| `item_count` | no | 1–40, at least `outfits` |
| `theme` | yes | `casual`, `old_money` or `streetwear` (aliases like "preppy", "street" accepted) |
| `season` | yes | `spring`, `summer`, `autumn`, `winter` (German names accepted) |
| `sizes` | yes | `top` (XXS–XXXL), `waist` (24–50 inch), `shoe_eu` (34–50) |
| `fit` | no | Short text, e.g. `slim`, `baggy` |
| `gender` | no | `men` or `women` |
| `needed_by` | no | `YYYY-MM-DD`, not in the past |
| `climate` | no | Short text |
| `owned`, `avoid` | no | Short text lists |

In a JSON order, a theme the catalogue cannot serve is refused here, so the customer is not
charged for a guaranteed refund later.

## The five guarantees

Checked by Person 3 after the stylist picks:

1. **Budget** — outfit total including estimated shipping stays within `budget_eur`.
2. **Fit** — the customer's size exists for every item.
3. **Availability** — that size is in stock.
4. **Price integrity** — the price has not changed since collection.
5. **Delivery** — the shop delivers to the customer's region before `needed_by`.

Before that, code rejects outfits built around shorts that do not belong together: shorts
outside summer, or shorts with a polo, a warm or long-sleeve top, a jacket or dress shoes
(`person3/app/services/combinations.py`). Other combination and colour rules are in the
stylist prompt only.

If no outfit passes, the result is `REFUND` and nothing is bought. On Sokosumi the agent then
submits no result, so `submitResultTime` lapses and the escrow returns the buyer's money. The
result page says nothing was charged and shows no cart.

## Tests

```sh
npm test
```

Person 3's Python tests:

```sh
cd person3 && .venv/bin/pytest -q
```

## Known limits

- **Budget refunds.** With 300 EUR, the demo order ends in `REFUND` because both looks cost
  more than 300 EUR. With 500 EUR it ends in `APPROVED`.
- **Two size systems for bottoms.** 894 bottoms use waist sizes, 713 letter sizes. Step 3a
  maps a waist size to its letter size when that reaches a cheaper trouser, and logs each swap.
  The mapping (`WAIST_TO_LETTER` in `logic/data/normalize.js`) is an inference and varies by
  brand.
- **Gender is read from shop data.** Tags, vendor and title decide; items marked for the other
  gender are dropped. About 40% of the catalogue says nothing and is kept.
- **Final check uses the snapshot by default.** See [Live re-checks in step 6](#live-re-checks-in-step-6).
- **The agent cannot buy yet.** Step 8 checks the purchase and then declines it, because no
  payment module is wired into `AITELIER_PAYMENT`. The customer gets every shop link instead.
- **Cart links cannot be verified by a script.** Shops answer 403 on `/cart/`; availability is
  proven by the live product refetch instead. See [catalog/README.md](catalog/README.md).
- **Themes are keyword heuristics.** Only `casual`, `old_money` and `streetwear` exist; punk,
  sportswear and a fit attribute are not in the catalogue yet.
- **Runtime.** About 110 s with the live filter, about 25 s with the demo shortlist.
- **Trust check is not in the pipeline yet.** Shop trust is currently assumed.

## Next steps

1. Put the trust check into the pipeline (cached per shop), then offer it as an x402 service.
2. Set up Masumi payments on Preprod and complete one paid task with a transaction hash.
3. Turn on live re-checks in step 6 for paid tasks.
4. Host the result page per task and link it in the Sokosumi result.
5. Accept a photo URL and give a per-item reason in the report.
6. Ask for the customer's frequent activities and add dedicated sets (running, hiking) to the
   wardrobe.

## Security

Keep `.env`, `.local/`, wallets, runtime keys and `catalog/cache/run/` out of git. Treat shop
pages and catalogue text as untrusted data. Upstream template instructions, including Workspace
switching and payment setup, are in [docs/tum-quickstart-readme.md](docs/tum-quickstart-readme.md).
