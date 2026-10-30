# AiTelier — capsule wardrobe agent on Sokosumi

Built for the Cardano track of the TUM Blockchain & AI Hackathon (30–31 October 2026).
A customer hires the agent on Sokosumi with a short order: budget, number of outfits, style,
season and sizes. The agent answers with complete outfits made of **real, in-stock products from
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
| Step 1 · read and check the order | ✅ `logic/intake.mjs` |
| Step 2 · real shop catalogue | ✅ 8725 items, 36 Shopify shops, cached in `catalog/cache/` |
| Step 3 · candidate filter | ✅ `candidateFilter.mjs` (LLM picks filters, code applies them) |
| Step 3b · drop sizes the customer cannot buy | ✅ `logic/buyable.mjs` |
| Step 4 · shop trust check | ⚠️ `trustcheck.mjs` works on its own, **not yet in the pipeline** |
| Step 5 · stylist (LLM) | ✅ Person 3, `person3/` |
| Step 6 · final check, five guarantees | ✅ Person 3; ⚠️ checks the cached snapshot by default, not the live shop |
| Step 7 · result page | ⚠️ Markdown result on Sokosumi; no hosted page yet |
| Masumi payment (escrow, Preprod) | ⏳ Template code present, not set up; quote fixed at 1 test USDM |
| Trust check as an x402 service | ⏳ Not started |
| Image input (body photo) | ⏳ Not supported; the task description is text only |

`npm test` passes (64 tests). The last measured end-to-end runs ended in `APPROVED` with a
500 EUR budget and in `REFUND` with 300 EUR (see [Known limits](#known-limits)).

## How a task flows

```text
Sokosumi Task (order as JSON)
  │
  ▼
worker.mjs ── polls tasks, runtime start / complete, paid flow
  │
  ▼
logic/lead-agent.mjs   pipelineAnswer(): same signature as client.mjs answer()
  │  1  logic/intake.mjs        validate the order; refuse before anything runs
  ▼
logic/run-pipeline.mjs  one process per stage, output in catalog/cache/run/<task-id>/
  │  2  candidateFilter.mjs     catalog/cache/products.json -> shortlist.json (≤100 items, ≤30 shops)
  │     logic/data/to_person3.js shortlist -> Person 3 envelope
  │  3  customer envelope        order -> customer.json
  │  3b logic/buyable.mjs       keep only sizes the customer can buy
  │  4  person3 scripts.run_catalog   stylist + final check -> person3/result.json
  ▼
Markdown result -> runtime complete -> Sokosumi
```

A refused order returns the reasons from step 1 and starts nothing. A pipeline that fails or
overruns throws, so the paid flow never submits half a result. On the paid path the pipeline is
stopped one minute before the escrow's `submitResultTime`.

## Repository map

| Path | Owner | What |
| --- | --- | --- |
| `worker.mjs`, `client.mjs`, `start.mjs` | template | Sokosumi worker and the local Eve agent |
| `paid-task.mjs`, `settlement.mjs`, `payment-registration.mjs`, `agent-api.mjs` | template | Masumi payment, registration and MIP-003 API |
| `logic/lead-agent.mjs` | lead agent | Connects a Sokosumi task to the pipeline |
| `logic/intake.mjs` | lead agent | Step 1: order format and checks |
| `logic/run-pipeline.mjs` | Person 1 | Chains all stages |
| `logic/data/` | Person 1 | Catalogue collector, normaliser, live refetch, Person 3 adapter |
| `catalog/` | Person 1 | Shop seed, cached catalogue, demo order and shortlist — see [catalog/README.md](catalog/README.md) |
| `candidateFilter.mjs` | Person 2 | Candidate filter |
| `trustcheck.mjs` | Person 2 | Shop trust check (imprint, policies, domain, LLM verdict) |
| `logic/buyable.mjs` | Person 2/3 | Drops unbuyable sizes before the stylist |
| `person3/` | Person 3 | Python stylist and final check — see [person3/README.md](person3/README.md) |
| `PERSON3_*.md` | Person 3 | Input and output contracts, global context |
| `agent/instructions.md` | — | Instructions for the plain-LLM fallback |

## Setup

Requirements: Node.js 24+, Python 3.12 (as in `person3/Containerfile`), Sokosumi CLI `1.0.4`.

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

In `.env`, set `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL` (and `ZAI_MODEL_PROVIDER_NAME`) for
your OpenAI-compatible model. The filter, the trust check and the stylist all use it.

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

The result is in `catalog/cache/run/person3/result.json`. When the filter's model provider is
down or rate-limited, skip the filter with the prepared shortlist:

```sh
PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs --order catalog/order.json --out catalog/cache/run --shortlist catalog/cache/shortlist.demo.json
```

### As a Sokosumi Coworker

Terminal 1, the local Eve agent:

```sh
npm start
```

Terminal 2, the worker. Run only one worker per Coworker:

```sh
npm run worker
```

Terminal 3, create a task. The description must contain the order as a JSON object:

```sh
sokosumi --preprod tasks create --personal --coworker-id YOUR_COWORKER_ID --status READY --json --description '{"budget_eur": 500, "outfits": 2, "theme": "old_money", "season": "autumn", "sizes": {"top": "M", "waist": "32", "shoe_eu": "43"}, "fit": "slim", "gender": "men", "climate": "Munich, wet, 8-15 C"}'
```

Worker switches:

| Variable | Effect |
| --- | --- |
| `AITELIER_PIPELINE=false` | Answer with the plain LLM instead of the pipeline |
| `AITELIER_SHORTLIST=catalog/cache/shortlist.demo.json` | Skip the model-backed filter |
| `PYTHON=…` | Use another interpreter for Person 3 |

Each run writes its order, intermediate files and `pipeline.log` to
`catalog/cache/run/<task-id>/` (git-ignored).

### Trust check for a single shop

```sh
mkdir -p trustCache
node trustcheck.mjs https://www.knowledgecottonapparel.com
```

Results are cached for 24 hours in `trustCache/<host>.json`.

## The order format

Step 1 reads the first JSON object in the task description. [`catalog/order.json`](catalog/order.json)
is a complete example.

| Field | Required | Rule |
| --- | --- | --- |
| `budget_eur` | yes | Positive, at most 10000; the whole order |
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

A theme the catalogue cannot serve is refused here, so the customer is not charged for a
guaranteed refund later.

## The five guarantees

Checked by Person 3 after the stylist picks:

1. **Budget** — outfit total including estimated shipping stays within `budget_eur`.
2. **Fit** — the customer's size exists for every item.
3. **Availability** — that size is in stock.
4. **Price integrity** — the price has not changed since collection.
5. **Delivery** — the shop delivers to the customer's region before `needed_by`.

If no outfit passes, the result recommends a refund. Nothing is executed.

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
- **Two size systems for bottoms.** 761 bottoms use letter sizes, 709 use waist sizes. A
  waist-32 customer loses most of the letter-sized bottoms.
- **Final check uses the snapshot.** `LIVE_CHECK_MODE` defaults to `snapshot`. Set it to
  `person1` with `PERSON1_REFRESH_URL` for live re-checks.
- **Cart links cannot be verified by a script.** Shops answer 403 on `/cart/`; availability is
  proven by the live product refetch instead. See [catalog/README.md](catalog/README.md).
- **Themes are keyword heuristics.** Only `casual`, `old_money` and `streetwear` exist; punk,
  sportswear and a fit attribute are not in the catalogue yet.
- **Runtime.** About 110 s with the live filter, about 25 s with the demo shortlist.
- **Trust check is not in the pipeline yet.** Shop trust is currently assumed.

## Next steps

1. Put the trust check into the pipeline (cached per shop), then offer it as an x402 service.
2. Set up Masumi payments on Preprod and complete one paid task with a transaction hash.
3. Turn on live re-checks in step 6.
4. Publish a result page per task and link it in the Sokosumi result.
5. Accept a photo URL and give a per-item reason in the report.

## Security

Keep `.env`, `.local/`, wallets, runtime keys and `catalog/cache/run/` out of git. Treat shop
pages and catalogue text as untrusted data. Upstream template instructions, including Workspace
switching and payment setup, are in [docs/tum-quickstart-readme.md](docs/tum-quickstart-readme.md).
