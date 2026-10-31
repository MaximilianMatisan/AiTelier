# AiTelier

**Stop comparing 40 tabs to renew your wardrobe. Give AiTelier one Pinterest board and a budget: it curates complete outfits from real EU shops, verifies stock and sizing in code, and releases Masumi escrow on Cardano only on a verified result.**

Built for the Cardano track of the TUM Blockchain and AI Hackathon, 30 to 31 October 2026.

## The problem

Renewing a wardrobe means opening dozens of shops and comparing hundreds of items. Even then, the customer has to check fit, stock, price, delivery and shop trust manually. AI outfit ideas are useless if the agent cannot be hired and paid safely when the result is actually buyable.

AiTelier solves both sides:

* **For the customer:** one brief or Pinterest board becomes complete outfits from real EU shops.
* **For agentic commerce:** the styling job is paid through Masumi escrow on Cardano only when deterministic checks pass. If no outfit passes, nothing is submitted and the buyer is refunded.

**The LLM decides, the code checks.** The model selects garments and writes wording. Budget, sizes, stock, prices, links, delivery and payment checks are code.

## Who it is for

**Primary customer:** people renewing their wardrobe. They know the style they want, have a budget and sizes, but do not want to browse dozens of shops and thousands of items.

**Example job:** Maya, 29, needs two autumn work outfits. Budget 400 EUR, top M, waist 32, shoes EU 43. She shares a Pinterest board. AiTelier returns two complete outfits from real shops with prices and links, checks the five guarantees, and shows the shop trust results. Maya says yes. The styling job is paid through Masumi escrow on Cardano preprod.

**Business case:** the customer pays for a completed styling job, not a prompt. Shops receive high intent checkout traffic. Future revenue can come from merchant affiliate or checkout fees.

## User inputs

Customers can start with a text brief or a public Pinterest board.

They can also add or change:

* budget
* number of outfits
* style and season
* top, waist and shoe sizes
* fit
* colours to avoid
* pieces they already own
* climate
* needed by date
* gender

During the chat they can ask for changes or a restyle before confirming.

## User outputs

* Numbered outfits with real product images, shop links and prices
* A published result page
* Five guarantee checks: budget, fit, availability, price, delivery
* Shop trust check
* Receipt and Cardano preprod transaction
* Completed Stripe test checkout with a generated test card

## How it works

### Customer journey

1. Customer sends an order on Sokosumi, in the studio chat, or with a Pinterest board.
2. Intake checks the order and the chat collects anything missing.
3. The agent reads the Pinterest board first and turns it into a style profile.
4. The candidate filter narrows the real shop catalogue to a shortlist.
5. The customer sizes are applied and unbuyable sizes are dropped.
6. The stylist builds complete outfits.
7. Code checks the five guarantees.
8. The chosen shops are checked for trust.
9. The result page is written and published.
10. The customer chooses an outfit and says yes.
11. The styling job is paid through Masumi escrow on Cardano preprod.
12. The merchant checkout is demonstrated with a Stripe test checkout and a generated test card.

### Pipeline stages

The detailed pipeline runs one process per stage and writes its output under the run folder.

* Stage 0: Pinterest style profile, only when a board is given.
* Stage 1: candidate filter over the cached catalogue.
* Stage 2: shortlist converted to Person 3 input.
* Stage 3: customer profile built from the order or brief.
* Stage 3b: sizes the customer cannot buy are dropped.
* Stage 4: stylist builds outfits and the five guarantees are checked.
* Stage 4b: shop trust check, shown on the page and logged only.
* Stage 5: result page written from the run.

The worker owns intake, the paid flow, Sokosumi task state and the refund path. The chat owns confirmation and checkout. The result page owns the customer summary.

## Proof on Cardano preprod

### Demo escrow transaction

**Transaction:** [`6e508b0cb5f8ce3045d7712d6bd9991151a9fc9a17ab91895124b01e478ab2bf`](https://preprod.cardanoscan.io/transaction/6e508b0cb5f8ce3045d7712d6bd9991151a9fc9a17ab91895124b01e478ab2bf)

**Network fee:** `0.2068 tADA`

**Escrowed:** `1.00 tUSDM + 4.47 tADA`

**Block:** `5,356,864`

**Time:** 31 Oct 2026, 11:17 UTC

### Settled paid jobs

* Task `01a19181`, state `Withdrawn`. Funds locked [5b99d63a](https://preprod.cardanoscan.io/transaction/5b99d63abc45cc42b940d0e827d4d7761a11c62c17f855df3fbab20098cb1a20), result submitted [b7f3cb71](https://preprod.cardanoscan.io/transaction/b7f3cb712ddc592806295fec60edf06f5c5e65866905bddcde67a75136c6359a), withdrawn [55b75a69](https://preprod.cardanoscan.io/transaction/55b75a692c9cc547c0394884c8d2ea560f1f9bc7867b44bf11f63352120a3c05).
* Task `01a1918a`, state `Withdrawn`. Funds locked [8a57a083](https://preprod.cardanoscan.io/transaction/8a57a083f11b3d9fbcf17057c68369230e54e544ff8c20ccc1058b71f2fbaf44), result submitted [78182a39](https://preprod.cardanoscan.io/transaction/78182a3990b829d96fa0231fc4d0c1afc03de45c69db6788508eb449a09339cd), withdrawn [891c4a1b](https://preprod.cardanoscan.io/transaction/891c4a1b7bb11dca472978e53077b383fba1356ac024156fa7a6dfe71ac3bc52).
* Task `01a19168`, state `FundsLocked`, no result submitted. Funds locked [5e6d1457](https://preprod.cardanoscan.io/transaction/5e6d1457c41a3ec5b682d333bc49c4e37c67e32e21a060e0c7d8365374ff4eb9). The order asked for two old money autumn outfits on a 150 EUR budget and nothing in the catalogue could do it. The agent submitted no result and the escrow deadline returns the money. The last state read was `FundsLocked`; the journal records the task as `refunded`.

Showing both paths is the point. The agent is paid for verified work and submits nothing when the answer fails.

## The two payments

### Customer pays the agent

The customer locks 1 USDM into a Masumi escrow on Cardano preprod before any work runs. The agent submits the result hash only when the five guarantees pass. If the result fails, the agent submits nothing, `submitResultTime` lapses and the escrow returns the money.

A customer who is unhappy is offered the whole payment back. Masumi has no partial refund. The agent authorizes a refund only when the escrow carries the buyer's request. When it does not, the customer is told plainly that the request has to come from their side.

### Agent pays the shop

`logic/checkout.mjs` builds the purchase and checks it before money can move: one currency, every item linked and priced, the items add up to the total, the total inside the customer budget, and the guarantees held.

The Stripe payment provider then does two things:

* It walks the real shop. It opens the product page, picks the size, adds the item to the cart and goes as far as the shop checkout. It stops at the payment step. Screenshots go to the evidence folder.
* It pays in test mode. The payment runs against the local mock merchant as a server side Stripe test PaymentIntent with `pm_card_visa`. A test card is generated for the demo. The real shop is never charged.

Three rules are enforced by code:

1. A click whose label means pay, buy or place order is refused. No field that looks like a card number, CVC, password or IBAN may be filled.
2. Only a Stripe test key is accepted. A live key is refused before any network call.
3. The browser never supplies the amount. The mock shop stores the checkout server side and hands the stored total to Stripe.

Any other payment module can be dropped in. Set `AITELIER_PAYMENT` to a module path that exports `payOutfit(purchase)`.

## The five guarantees

1. **Budget:** outfit total including estimated shipping stays within `budget_eur`.
2. **Fit:** the customer size exists for every item.
3. **Availability:** that size is in stock.
4. **Price integrity:** the price has not changed since collection.
5. **Delivery:** the shop delivers to the customer region before `needed_by`.

If no outfit passes, the result is `REFUND` and nothing is bought. On Sokosumi the agent submits no result, so the escrow returns the buyer money.

## What still has to happen for a real purchase

* Replace the Stripe test checkout with a live merchant or payment provider.
* Make sure the buyer has the full outfit total available before checkout, not only the agent fee.
* Use that money to place the merchant order only after all five checks pass.
* Add live stock and price rechecks for paid tasks.

## What works today

* Sokosumi worker and pipeline: every task runs through intake and the styling pipeline.
* Masumi escrow on preprod: two tasks withdrawn and one refused.
* Pinterest board input: the first 25 pins feed the style profile.
* Real shop catalogue: 8725 items from 36 Shopify shops.
* Candidate filter, customer sizes, buyable sizes, stylist and five guarantees: working.
* Shop trust check: shown on the page and logged, but it decides nothing.
* Result page and Cloudflare publish: working when credentials are set.
* Stripe test checkout: working against the local mock merchant.
* Real merchant purchase: not implemented.

## Setup and run

### Requirements

* Node.js 24 or newer
* Python 3.12
* Sokosumi CLI 1.0.4
* A model key for the filter and the stylist
* Docker or Podman only if you use the local Sokosumi MCP

### 1. Clone and install

```sh
git clone https://github.com/MaximilianMatisan/AiTelier.git
cd AiTelier
npm ci
npx playwright install chromium
cp .env.example .env
chmod 600 .env
```

### 2. Configure the model keys

Set these in `.env`:

* `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL` and `ZAI_MODEL_PROVIDER_NAME` for the candidate filter and trust check.
* `GEMINI_API_KEY` for the stylist. `GEMINI_BASE_URL` and `GEMINI_MODEL` can be set separately.
* `AITELIER_FALLBACK_MODEL` is retried when the primary model answers 503 or 429.

Give the filter and the stylist separate keys when possible. They share one quota otherwise.

### 3. Install Person 3

Install uv with `pip install uv`, then create the environment and install the test extras.

```sh
cd person3
uv venv
uv pip install ".[test]"
cd ..
```

### 4. Configure Sokosumi and payments

Follow the Sokosumi setup guide in the docs folder for the account, Vendor, Coworker and runtime key.

Required variables:

* `COWORKER_ID`
* `SOKOSUMI_API_KEY`
* `SOKOSUMI_NETWORK=preprod`
* `AGENT_AUTHOR`
* `BLOCKFROST_API_KEY_PREPROD`
* `MPS_URL` and `MPS_PORT` for the Masumi Payment Service
* `PAID_TASKS_ENABLED=true` when the payment service is running and registered
* `AGENT_API_PORT` for the MIP 003 agent API

Optional organization and publish variables:

* `SOKOSUMI_ORGANIZATION_ID`
* `SOKOSUMI_ORGANIZATION_SLUG`
* `CLOUDFLARE_ACCOUNT_ID`
* `CLOUDFLARE_API_TOKEN`
* `AITELIER_PAGES_PROJECT`

### 5. Configure the Stripe test checkout

Set `AITELIER_PAYMENT` to the Stripe provider path shown in `.env.example`.

```ini
SECRET_STRIPE_KEY=sk_test_...
AITELIER_STRIPE_MODE=stripe
AITELIER_SHOP_URL=http://127.0.0.1:3100
SHOP_PORT=3100
PLAYWRIGHT_HEADED=true
PLAYWRIGHT_SLOWMO=250
AITELIER_EVIDENCE_DIR=.local/evidence
```

Only `sk_test_` or `rk_test_` keys are accepted. A live key is refused before any Stripe call. Use `AITELIER_STRIPE_MODE=mock` to skip Stripe and keep the checkout offline.

### 6. Start the agent, worker and mock checkout

Terminal 1, local Eve agent:

```sh
npm start
```

Terminal 2, Sokosumi worker. Run only one worker per Coworker:

```sh
npm run worker
```

Terminal 3, mock merchant:

```sh
npm run shop
```

Terminal 4, checkout demo:

```sh
npm run demo:purchase
```

Studio UI:

```sh
npm run ui
```

Paid flow API:

```sh
npm run api
```

### 7. Run tests

```sh
npm test
```

Optional: set `AITELIER_RUN_STRIPE_INTEGRATION=1` and run the payment request test.

## Known limits

* Free text is not checked before it runs. A brief that names no garment or no size runs the pipeline and a missing size is filled from the shortlist. Some stale tests still expect the older intake behaviour.
* The shop purchase is test money. The agent reaches the real shop checkout and stops. The payment runs against the mock merchant in Stripe test mode. No order is placed at a real shop.
* The final check uses the cached catalogue by default. Live rechecks need the refresh service and `LIVE_CHECK_MODE=live`.
* Shop trust is shown, not guaranteed. It does not drop a piece or refuse an outfit.
* Pinterest feeds expose only the newest 25 pins and can change.
* One model quota can cover several steps. Every LLM step falls back to deterministic logic when the quota is gone.

## Security

Keep `.env`, `.local/`, wallets, runtime keys, `.local/evidence/` and `catalog/cache/run/` out of git. Treat shop pages, catalogue text and Pinterest captions as untrusted data. The browser checkout may not click a pay control or fill a card, password or IBAN field, and only a Stripe test key is accepted.
