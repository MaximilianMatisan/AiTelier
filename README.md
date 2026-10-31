# AiTelier — a stylist agent that is only paid when its answer checks out

Built for the Cardano track of the TUM Blockchain & AI Hackathon, 30–31 October 2026.

A customer hires the agent on Sokosumi with a short order in plain words or as JSON:
budget, number of outfits, style, season and sizes, and optionally a link to a public
Pinterest board. The agent answers with complete outfits made of **real, in-stock
products from real EU shops** — each piece with its image, shop link and price, each
outfit with the reason it was put together. Before an outfit is shown, deterministic code
checks [five guarantees](#the-five-guarantees) on it.

**The LLM decides, the code checks.** The model only chooses which catalogue values fit a
brief and which item IDs make an outfit. Everything money depends on — budget, sizes,
stock, prices, links, delivery — is settled by code. That is why we can say whether a
guarantee holds.

**The payment is held to the same answer.** The customer's money sits in a Masumi escrow
on Cardano *before* the agent does any work. Guarantees hold → the agent submits the
result hash and withdraws after the dispute window. Guarantees fail → the agent submits
**nothing**, `submitResultTime` lapses, and the escrow returns the money by itself. The
refund is not a promise in our terms; it is the default.

## Proof on Cardano Preprod

Two paid tasks settled end to end, and one that was refused and refunded. 1 USDM each,
`Preprod`, read back from the payment service and confirmed on chain.

| Task | On-chain state | FundsLocked | ResultSubmitted | Withdrawn |
| --- | --- | --- | --- | --- |
| `01a19181` | `Withdrawn` | [`5b99d63a…cb1a20`](https://preprod.cardanoscan.io/transaction/5b99d63abc45cc42b940d0e827d4d7761a11c62c17f855df3fbab20098cb1a20) | [`b7f3cb71…c6359a`](https://preprod.cardanoscan.io/transaction/b7f3cb712ddc592806295fec60edf06f5c5e65866905bddcde67a75136c6359a) | [`55b75a69…0a3c05`](https://preprod.cardanoscan.io/transaction/55b75a692c9cc547c0394884c8d2ea560f1f9bc7867b44bf11f63352120a3c05) |
| `01a1918a` | `Withdrawn` | [`8a57a083…fbaf44`](https://preprod.cardanoscan.io/transaction/8a57a083f11b3d9fbcf17057c68369230e54e544ff8c20ccc1058b71f2fbaf44) | [`78182a39…9339cd`](https://preprod.cardanoscan.io/transaction/78182a3990b829d96fa0231fc4d0c1afc03de45c69db6788508eb449a09339cd) | [`891c4a1b…c3bc52`](https://preprod.cardanoscan.io/transaction/891c4a1b7bb11dca472978e53077b383fba1356ac024156fa7a6dfe71ac3bc52) |
| `01a19168` | `FundsLocked`, no result submitted | [`5e6d1457…ff4eb9`](https://preprod.cardanoscan.io/transaction/5e6d1457c41a3ec5b682d333bc49c4e37c67e32e21a060e0c7d8365374ff4eb9) | — (deliberately) | — |

The third row is the point. That order asked for two old-money autumn outfits on a
150 EUR budget; nothing in the catalogue could do it, so the agent submitted no result and
let the escrow's own deadline return the money. We did not observe the repayment
transaction ourselves — the last state we read was `FundsLocked` and our journal records
the task as `refunded`; the repayment is the escrow's to make, not ours.

Showing both paths is what the guarantee is worth. Any agent can show the happy one.

## What is working

| Part | State |
| --- | --- |
| Sokosumi worker → pipeline | ✅ Every task, free or paid, runs through the pipeline |
| Masumi escrow on Preprod | ✅ Two tasks `Withdrawn`, one refused and refunded; quote 1 USDM |
| Step 0 · conversation | ✅ `logic/conversation.mjs`: several turns to collect the order, show the looks, confirm one; in the studio chat and in Sokosumi task comments |
| Step 1 · read and check the order | ✅ `logic/intake.mjs`; free text or JSON. Refuses before any money is locked |
| Step 2 · real shop catalogue | ✅ 8725 items from 36 Shopify shops, cached in `catalog/cache/` |
| Step 3 · candidate filter | ✅ `candidateFilter.mjs` (LLM picks filters, code applies them) |
| Step 3a · customer profile | ✅ `logic/run-pipeline.mjs`: drops garments marked for the other gender, maps a waist size to the letter size shops use when that reaches a cheaper item |
| Step 3b · drop sizes the customer cannot buy | ✅ `logic/buyable.mjs` |
| Step 4 · shop trust check | ✅ `logic/trust-shops.mjs` runs `trustcheck.mjs` on each shop behind the chosen pieces, after the stylist; **shown on the page and logged only, it decides nothing** |
| Step 5 · stylist (LLM) | ✅ `person3/`; outfits that misuse shorts are rejected by code |
| Step 6 · final check, five guarantees | ✅ `person3/`; live re-query per item when the refresh service runs, else the cached snapshot |
| Step 7 · result page | ✅ `logic/result-page.mjs` writes one HTML page per run; `logic/publish.mjs` puts it on Cloudflare Pages and the Sokosumi result links it |
| Refund path | ✅ A `REFUND` result is not submitted, so the escrow returns the money |
| Step 8 · checkout | ✅ `logic/checkout.mjs` builds and checks the purchase; `logic/pay-stripe.mjs` walks the shop's own checkout in a browser and pays in **Stripe test mode** against a mock merchant |
| Customer-initiated refund | ✅ Offered with the result; authorized only when the escrow carries a refund request |
| Local studio UI | ✅ `npm run ui`: chat with the stylist or fill the form, watch the stages, see the looks |
| Pinterest board as style input | ✅ `logic/pinterest.mjs` + `logic/style-profile.mjs`: the first 25 pins of a public board, read by a vision model, steer the stylist |
| Trust check as an x402 service | ⏳ Not started |
| Image input (body photo) | ⏳ Not supported; the task description is text only |

`npm test` runs **382 tests: 373 pass, 7 fail, 1 skipped, 1 todo** — see [Tests](#tests)
for what the seven are. Person 3's `pytest` passes 30, skips 1.

## How a task flows

```text
Sokosumi Task (order as free text or JSON) and its comments
  │
  ▼
worker.mjs ── polls tasks, runtime start / complete, paid flow
  │           comments.mjs: each comment is a turn of logic/conversation.mjs (step 0)
  ▼
logic/lead-agent.mjs   pipelineAnswer(): same signature as client.mjs answer()
  │  1  logic/intake.mjs        check a JSON order, or pass free text on; refuse before anything runs
  ▼
logic/run-pipeline.mjs  one process per stage, output in catalog/cache/run/<task-id>/
  │  0  logic/style-profile.mjs only with a Pinterest link: first 25 pins -> style-profile.json
  │  3  candidateFilter.mjs     catalog/cache/products.json -> shortlist.json (≤100 items, ≤30 shops)
  │                             and selection.json (what the model read out of the brief)
  │     logic/data/to_person3.js shortlist -> Person 3 envelope
  │  3a customer envelope        order or brief -> customer.json; drop the other gender, map sizes
  │  3b logic/buyable.mjs       keep only sizes the customer can buy
  │  5  person3 scripts.run_catalog   stylist + final check (6) -> person3/result.json
  │  4  logic/trust-shops.mjs   the chosen pieces' shops -> trust.json (shown only, decides nothing)
  │  7  logic/result-page.mjs   result.json (+ style-profile.json, trust.json) -> index.html
  ▼
logic/publish.mjs       index.html -> Cloudflare Pages, /r/<random>, noindex
  ▼
APPROVED: Markdown result with the page link -> runtime complete -> Sokosumi
REFUND:   nothing submitted -> submitResultTime lapses -> escrow refunds the buyer
No result on an unpaid task: the Task is closed as FAILED with the reason, never left RUNNING
```

A refused order returns the reasons from step 1 and starts nothing — and cannot be charged
for, because the intake runs before the payment is locked. A pipeline that fails or
overruns throws, so the paid flow never submits half a result. A run whose guarantees do
not hold throws `GuaranteesFailed`: the worker logs `Refund due, no result submitted` and
keeps the reason in the task journal. On the paid path the pipeline is stopped one minute
before the escrow's `submitResultTime`.

## The money

Two separate layers, and it is worth keeping them apart.

### 1 · The customer pays the agent — Masumi escrow on Cardano

```text
1 · Customer locks     2 · Agent works         3 · Result hash      4 · Dispute window    5 · Withdraw or return
    1 USDM into the        the chain above,        submitted, which     unlockTime,            guarantees held: the agent
    escrow BEFORE          with submitResultTime   opens the dispute    default 3600 s         calls WithdrawPayment
    any work runs          to answer (120 s)       window               silence = payment      guarantees failed: the agent
                                                                                               submits nothing, the deadline
                                                                                               lapses, the buyer is repaid
```

Taste does not decide the payment, and that is deliberate: the money is in escrow before
the work starts, and without a dispute it falls to the agent. What is being paid for is
the five checkable guarantees. A look you dislike is a reason to dispute, not a lever on
the invoice.

A customer who is unhappy is told, with the result, that they can have the **whole**
payment back. Masumi has no partial refund to offer — `/payment/authorize-refund` takes a
blockchain identifier and a network and nothing else — so there is no share to argue over.
The agent authorizes a refund only when the escrow actually carries the buyer's request
(`RefundRequested` or `Disputed`); when it does not, the customer is told plainly that the
request has to come from their side, because a seller cannot return escrowed funds alone.

### 2 · The agent pays the shop — browser checkout, Stripe test mode

`logic/checkout.mjs` turns the confirmed look into a purchase and checks it before any
money can move: one currency, every item linked and priced, the items add up to the total,
the total inside the budget the customer confirmed, and the guarantees held. A purchase
that fails a check never reaches a payment module.

`logic/pay-stripe.mjs` then does two things:

- **Walks the real shop.** It opens the product page of the chosen item, picks the size,
  adds it to the cart and goes as far as the shop's own checkout — by heuristics first,
  falling back to an LLM-driven browser agent (`logic/purchase/agent-browser.mjs`) — and
  **stops at the payment step**. Screenshots go to `.local/evidence/<purchase-id>/`.
- **Pays in test mode.** The money itself moves against our mock merchant
  (`mock-shop/`, a small Shopify-shaped store) as a server-side Stripe **test** PaymentIntent.

Three rules are enforced by code, not by prompt:

1. A click whose label matches pay / buy / place order / *bestellung abschließen* is
   **refused**, and no field that looks like a card number, CVC, password or IBAN may be
   filled. The model proposes actions; `validateAgentAction()` decides.
2. Only a Stripe **test** key is accepted (`sk_test_` / `rk_test_`). A live key is refused
   before any network call.
3. The browser never supplies the amount. The mock shop stores the checkout server-side
   and hands the stored total to Stripe, and the real call uses the `pm_card_visa` test
   token — the digits typed on screen in a demo are theatre, and no card number is stored
   or logged.

Any other payment module can be dropped in. Set `AITELIER_PAYMENT` to a module path that
exports `payOutfit(purchase)`:

```js
export async function payOutfit(purchase, { signal } = {}) {
  return { status: "paid", txHash: "…", paidAmount: 1, paidCurrency: "USDM" };
}
```

```sh
AITELIER_PAYMENT=./logic/pay-stripe.mjs npm run ui   # browser checkout, Stripe test mode
AITELIER_PAYMENT=mock npm run ui                     # demo: says "paid", moves nothing
npm run ui                                           # unset: declines, shows the shop links
```

The header of `logic/checkout.mjs` holds the full contract, including the shape of a
`Purchase` and the three answers a module may give (`paid`, `declined`, `failed`).

## Talking to the agent

An order does not have to arrive complete. The chat collects it over several turns, runs
the pipeline when nothing is missing, shows the looks it found and buys the one the
customer confirms:

```text
collecting ──(order complete)──> ready ──"yes"──> styling ──> presented
                                   ▲                             │
            (change the brief) ────┘                      "outfit 2"
                                                                 ▼
   paid <──(payment module)── paying <────"yes"──────────── selected
```

The same dialogue runs on both surfaces, because `logic/conversation.mjs` performs no I/O
at all: a turn takes a state and a message and answers with the new state, the text to
show and one action for the surface to carry out.

- **Studio page** · `npm run ui`, tab *Talk to the stylist*. The page starts the run
  itself so it can show the stages while the pipeline works.
- **Sokosumi task comments** · every comment on a task is a turn. The task's own result
  seeds the conversation, so the first comment can be "buy outfit 2". One comment is
  answered exactly once, and a turn that was interrupted is never repeated — which is what
  keeps a payment from running twice. A restyle asked for in a comment runs in the
  worker's own loop, so the worker polls nothing else for the minute or two the pipeline
  takes.

What is said about products, prices and totals is written by code from Person 3's result,
and a purchase needs a confirmation that `detectIntent()` reads. A model is used for two
things only: reading an order out of free text, and the wording while the order is still
being collected. With no model configured, or one that is rate-limited, the dialogue
carries on with the code reader alone.

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

If no outfit passes, the result is `REFUND` and nothing is bought. On Sokosumi the agent
then submits no result, so `submitResultTime` lapses and the escrow returns the buyer's
money. The result page says nothing was charged and shows no cart.

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
| `logic/pay-stripe.mjs`, `logic/purchase/` | lead agent | Browser checkout on the shop, Stripe test-mode payment, action guardrails |
| `mock-shop/` | lead agent | Small Shopify-shaped merchant the test payment runs against |
| `comments.mjs` | lead agent | The chat on a Sokosumi task: one conversation per task thread |
| `logic/pinterest.mjs`, `logic/style-profile.mjs` | lead agent | Pipeline stage 0: a public Pinterest board -> the customer's style |
| `logic/run-pipeline.mjs` | Person 1 | Chains all stages; builds the customer profile |
| `logic/result-page.mjs` | Person 1 | Step 7: one self-contained HTML result page per run |
| `logic/data/` | Person 1 | Catalogue collector, normaliser, live refetch and its HTTP service, Person 3 adapter |
| `catalog/` | Person 1 | Shop seed, cached catalogue, demo order and shortlist — see [catalog/README.md](catalog/README.md) |
| `candidateFilter.mjs` | Person 2 | Candidate filter |
| `trustcheck.mjs` | Person 2 | Shop trust check (imprint, policies, domain, LLM verdict) |
| `logic/trust-shops.mjs` | lead agent | Step 4 in the pipeline: checks the chosen pieces' shops, for the page and the log only |
| `logic/buyable.mjs` | Person 2/3 | Drops unbuyable sizes before the stylist |
| `person3/` | Person 3 | Python stylist and final check — see [person3/README.md](person3/README.md) |
| `PERSON3_*.md` | Person 3 | Input and output contracts, global context |
| `ui/` | — | Local studio page: stylist chat, order form, stage progress, A2UI result |
| `agent/instructions.md` | — | Instructions for the plain-LLM fallback |

## Setup

Requirements: Node.js 24+, Python 3.12 (as in `person3/Containerfile`), Sokosumi CLI
`1.0.4`.

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

### Models

In `.env`, set `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL` (and
`ZAI_MODEL_PROVIDER_NAME`) for your OpenAI-compatible model; the filter and the trust
check use it. Give the stylist its **own** key in `GEMINI_API_KEY` (`GEMINI_BASE_URL` and
`GEMINI_MODEL` fall back to the `ZAI_` values). Without it the stylist falls back to
`ZAI_API_KEY`, both steps share one quota, and a single run can make both fail with 429.
`run-pipeline.mjs` prints which key each step uses and warns when they are the same.
`AITELIER_FALLBACK_MODEL` is retried when the primary answers 503 or 429.

### Person 3's Python environment

```sh
python3.12 -m venv person3/.venv
person3/.venv/bin/pip install -e "person3[test]"
```

With [uv](https://docs.astral.sh/uv/), which fetches Python 3.12 if needed:

```sh
uv venv --python 3.12 person3/.venv
uv pip install --python person3/.venv/bin/python -e "person3[test]"
```

Use 3.12: the pinned `pydantic` does not build on newer interpreters such as 3.15. The
worker uses `person3/.venv/bin/python` automatically when it exists; `run-pipeline.mjs` on
its own needs `PYTHON=person3/.venv/bin/python`. Without a model key, the stylist runs in
deterministic mock mode, which is fine for a dry run.

### Result pages (optional)

Set `CLOUDFLARE_ACCOUNT_ID` and either `CLOUDFLARE_API_TOKEN` (a token with Account /
Cloudflare Pages / Edit) or log in once with
`node_modules/.bin/wrangler login --scopes account:read user:read pages:write --use-keyring`.
`AITELIER_PAGES_PROJECT` names the Pages project (default `aitelier-results`). Without
these the pipeline still runs and the Sokosumi result carries no page link.

### Checkout (optional)

For the browser checkout, install the browser once and set a Stripe **test** key:

```sh
node_modules/.bin/playwright install chromium
```

```ini
AITELIER_PAYMENT=./logic/pay-stripe.mjs
STRIPE_SECRET_KEY=sk_test_...
AITELIER_STRIPE_MODE=stripe     # "mock" keeps the whole checkout offline
AITELIER_SHOP_URL=http://127.0.0.1:3100
PLAYWRIGHT_HEADED=true          # to watch it during a demo
```

A live Stripe key is refused before any network call. `.env.example` documents the rest,
including the demo shipping address and the optional Stripe Issuing test card.

### Sokosumi and payments

Sokosumi account, Vendor, Coworker and runtime key: follow
[docs/tum-hackathon.md](docs/tum-hackathon.md) (sections 3–4), then set `COWORKER_ID` in
`.env`. Keep `PAID_TASKS_ENABLED=false` until the Masumi Payment Service is running and
registered; the worker checks that the service answers before it lets any task onto the
paid path, and sends tasks down the unpaid path otherwise.

## Run

### The pipeline on its own

```sh
PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs --order catalog/order.json --out catalog/cache/run
```

The result is in `catalog/cache/run/person3/result.json`, the page the customer reads in
`catalog/cache/run/index.html`. When the filter's model provider is down or rate-limited,
skip the filter with the prepared shortlist:

```sh
PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs --order catalog/order.json --out catalog/cache/run --shortlist catalog/cache/shortlist.demo.json
```

To rebuild the result page from a finished run:

```sh
node logic/result-page.mjs --run catalog/cache/run
```

### Live re-checks in step 6

By default the final check decides stock and price on the cached catalogue. To re-query
the shops instead, start the refresh service and point Person 3 at it:

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

Opens on <http://127.0.0.1:21960> (`AITELIER_UI_PORT` changes it). It checks the order
with step 1, runs the pipeline, shows each stage and renders the looks. One run at a time.

### The checkout demo

```sh
npm run shop
```

```sh
npm run demo:purchase
```

`npm run shop` starts the mock merchant on `127.0.0.1:3100`. `npm run demo:purchase`
drives one purchase through it, and starts the shop itself when it is not already running.
With `PLAYWRIGHT_HEADED=true` you can watch the agent walk the real shop's checkout and
stop at the payment step.

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
| `AITELIER_SHORTLIST=catalog/cache/shortlist.demo.json` | Skip the model-backed filter (~25 s instead of ~110 s) |
| `PYTHON=…` | Use another interpreter for Person 3 |
| `AITELIER_DEFAULT_BUDGET_EUR=500` | Budget assumed when a free-text order names none |
| `PAID_TASKS_ENABLED=true` | Let tasks onto the Masumi escrow path |

Each run writes its order, intermediate files and `pipeline.log` to
`catalog/cache/run/<task-id>/` (git-ignored).

### Trust check for a single shop

```sh
node trustcheck.mjs https://www.knowledgecottonapparel.com
```

Results are cached for 24 hours in `trustCache/<host>.json`.

In the pipeline, step 4 runs after the stylist on the shops behind the chosen pieces, one
shop at a time. Each shop is checked inside its own `try`/`catch` with a 60 s limit, and
the whole step stops starting new shops after 150 s, so it always ends inside the stage's
three minutes. A shop that cannot be checked is "not checked". The verdicts go to the run
log (`trust: <shop> trustworthy, 92%`) and to the result page: a note on every piece and a
section "The shops" with the verdict, its summary and up to three red flags. **They decide
nothing:** no piece is dropped, no outfit refused, no refund caused, and the paid flow
never reads them. The check reads third-party pages and asks a model, so a guarantee the
customer pays on cannot rest on it.

## The order format

A task description is either free text or contains a JSON object.

**Free text** (at most 4000 characters) goes to the candidate filter as written. The filter
reads style, season, sizes and budget out of it. Sizes the customer wrote out ("waist 32",
"shoes EU 43") win over the filter's reading, and a size is only assigned when it is
unambiguous. Without a budget in the text, `AITELIER_DEFAULT_BUDGET_EUR` (500) is used and
the run log says so. Only an empty description is refused — see
[Known limits](#known-limits).

**JSON**: step 1 reads the first JSON object and checks every field below before anything
runs. [`catalog/order.json`](catalog/order.json) is a complete example.

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
| `pinterest` | no | Link to a public Pinterest board, see below |

In a JSON order, a theme the catalogue cannot serve is refused here, so the customer is
not charged for a guaranteed refund later.

### A Pinterest board as style input

Add the link of a public Pinterest board to the order, in free text or as `pinterest` in
JSON. `www.pinterest.com/name/board/`, the country domains (`de.pinterest.com`,
`pinterest.co.uk`) and `pin.it` short links work; a profile link reads the profile's
latest pins. A link to a single pin, a search or another site is refused in step 1, before
any payment.

1. `logic/pinterest.mjs` reads the board's public RSS feed: no login, no API key. It takes
   the first 25 pins and loads their pictures at 736 px. Every request goes to
   `pinterest.com`, `pin.it` or `i.pinimg.com` only, redirects included, with size and
   time limits.
2. `logic/style-profile.mjs` sends the pictures and captions to the model behind `ZAI_*`
   (a vision model; `gemini-3.5-flash` in our setup). It asks only about the clothing,
   never about people, and treats captions as untrusted text. Code keeps catalogue themes
   and short plain terms (colours, pieces, fit) and writes `style-profile.json`.
3. Step 3a adds the board's themes to the stylist's style directions and its colours,
   pieces and fit to the stylist's notes. The candidate filter does **not** get them: as
   hard theme limits they cut the shortlist until no shoes in the customer's size were
   left.
4. The result page shows "Your style, read from Pinterest": the summary, themes, colours
   and pieces. It shows the board's name, never the account and never the pictures,
   because the page is public to anyone with its link.

A board that is secret, mostly not clothing (fewer than 3 pins) or cannot be read does not
fail the order: the page says why and the outfits follow the rest of the order. A board is
a style, not a size: a JSON order still needs `sizes`, and in free text a size the brief
does not name is assumed like in any other free-text order.

## Tests

```sh
npm test
```

382 tests: 373 pass, **7 fail**, 1 skipped, 1 todo. The failures are known and named
rather than hidden:

- **Six** — four in `intake.test.mjs`, two in `style-profile.test.mjs` — assert the strict
  free-text intake that commit `7845365` deliberately removed: that a brief naming no
  garment is refused, that a missing size is asked about rather than guessed. The code now
  runs such a brief and fills the size from the shortlist. The team has not yet settled
  which behaviour it wants; until it does, the tests record the disagreement rather than
  being deleted.
- **One** (`a confirmed request starts and completes the checkout`) needs a reachable
  Stripe test service and leaves the conversation in `selected` instead of `paid` without
  one. The adjacent integration test opts out explicitly via
  `AITELIER_RUN_STRIPE_INTEGRATION=1`; this one does not yet.

The one `todo` (`selectFilters still selects when the model drops a field`) is a known
gap in the filter's nullable schema, marked rather than silently passing.

Person 3's Python tests:

```sh
cd person3 && .venv/bin/pytest -q
```

## Known limits

- **Free text is not checked before it runs.** Since `7845365`, step 1 refuses only an
  empty description. A brief that names no garment ("shopping") or no size runs the whole
  pipeline; a missing size is filled with the label the shortlist stocks most, and the run
  log says it was assumed.
- **Budget refunds.** With 300 EUR the demo order ends in `REFUND`, because both looks
  cost more than 300 EUR. With 500 EUR it ends in `APPROVED`.
- **Two size systems for bottoms.** 894 bottoms use waist sizes, 713 letter sizes. Step 3a
  maps a waist size to its letter size when that reaches a cheaper trouser, and logs each
  swap. The mapping (`WAIST_TO_LETTER` in `logic/data/normalize.js`) is an inference and
  varies by brand.
- **Gender is read from shop data.** Tags, vendor and title decide; items marked for the
  other gender are dropped. About 40% of the catalogue says nothing and is kept.
- **Final check uses the snapshot by default.** See
  [Live re-checks in step 6](#live-re-checks-in-step-6). In the last measured live run, 60
  of 61 records came back live and every chosen item was checked live.
- **The shop purchase is test money.** The agent reaches the real shop's checkout and
  stops; the payment that completes runs against our mock merchant in Stripe test mode. No
  order is placed at a real shop.
- **Cart links cannot be verified by a script.** Shops answer 403 on `/cart/`;
  availability is proven by the live product refetch instead. See
  [catalog/README.md](catalog/README.md).
- **Themes are keyword heuristics.** Only `casual`, `old_money` and `streetwear` exist;
  punk, sportswear and a fit attribute are not in the catalogue yet.
- **Runtime.** About 110 s with the live filter, about 25 s with the demo shortlist.
- **Shop trust is shown, not guaranteed.** Step 4 informs the customer; the five
  guarantees still assume every shop is honest. The check uses the model behind `ZAI_*`,
  so on a free-tier key with a daily request limit (20 for Gemini's free tier) it competes
  with the filter, the stylist and the Pinterest step, and shows "not checked" once the
  quota is used up.
- **Pinterest feed.** Only the newest ~25 pins of a board are in its feed, and Pinterest
  could change or end the feed. The board step adds about 15–40 s with the live model.
- **One model quota, several steps.** The daily limit hangs on the provider's project, not
  the key, so extra keys do not raise it. Every LLM step falls back to deterministic logic
  when the quota is gone.

## Next steps

1. Offer the shop trust check as an x402 service — an assistant that belongs to one shop
   has no reason to vet any other shop.
2. Let the trust verdict do something: a flagged shop should be able to cost an outfit its
   place, which means the guarantee has to be able to rest on it.
3. Turn on live re-checks in step 6 for every paid task, not only on request.
4. Settle the free-text intake question and make the red intake tests green either way.
5. Give a per-item reason in the report, tied to the Pinterest board where there is one.
6. Further sources the customer brings themselves: a Zalando or Instagram data export
   (GDPR), Instagram via its official login.
7. Ask for the customer's frequent activities and add dedicated sets (running, hiking) to
   the wardrobe.

## Security

Keep `.env`, `.local/`, wallets, runtime keys, `.local/evidence/` and
`catalog/cache/run/` out of git. Treat shop pages, catalogue text and Pinterest captions
as untrusted data. The browser checkout may not click a pay control or fill a card,
password or IBAN field, and only a Stripe test key is accepted. Upstream template
instructions, including Workspace switching and payment setup, are in
[docs/tum-quickstart-readme.md](docs/tum-quickstart-readme.md).
