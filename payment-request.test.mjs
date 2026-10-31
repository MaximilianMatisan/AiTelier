import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import Stripe from "stripe";
import { startShop } from "./mock-shop/server.mjs";
import { runTurn } from "./logic/chat-session.mjs";
import { newConversation, presentOutfits } from "./logic/conversation.mjs";
import { isTestKey, stripeKey } from "./logic/purchase/stripe-test.mjs";

const RESULT = {
  status: "APPROVED",
  outfits: [
    {
      outfit_id: "look-1",
      name: "Payment Test Look",
      items: [
        {
          item_id: "polo-1",
          title: "TT118 Polo Shirt",
          brand: "ThokkThokk",
          size: "M",
          price: { amount: 12, currency: "EUR" },
          product_url: "https://shop.example/polo",
        },
      ],
      totals: { grand_total: 16.9, shipping: 4.9, currency: "EUR" },
      guarantees: { ok: true },
    },
  ],
};

const PAYMENT_ENV = {
  AITELIER_PAYMENT: "./logic/pay-stripe.mjs",
};

async function startHarness(t, mode) {
  const saved = new Map();
  const set = (name, value) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  };

  set("AITELIER_SHOP_URL", "");
  set("AITELIER_STRIPE_MODE", mode);
  set("AITELIER_SHOW_REAL_SITE", "false");
  set("AITELIER_USE_ISSUING_CARD", "false");
  set("PLAYWRIGHT_HEADED", "false");
  set("PLAYWRIGHT_SLOWMO", "0");
  set("AITELIER_HOLD_MS", "0");
  const evidenceName = `.local/evidence/test-payment-${process.pid}-${Date.now()}`;
  const evidence = path.resolve(evidenceName);
  set("AITELIER_EVIDENCE_DIR", evidenceName);

  const shop = await startShop({
    port: 0,
    host: "127.0.0.1",
    paymentMode: mode,
    stripeKey: mode === "stripe" ? stripeKey() : undefined,
  });
  set("AITELIER_SHOP_URL", shop.url);

  t.after(async () => {
    await new Promise((resolve) => shop.server.close(resolve));
    rmSync(evidence, { recursive: true, force: true });
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  return { shop, evidence };
}

function presentedState() {
  return presentOutfits(
    { ...newConversation("chat-payment"), draft: { budget_eur: 30 } },
    RESULT,
  ).state;
}

async function confirmedRequest(shop) {
  const selected = (await runTurn(presentedState(), "outfit 1")).state;
  assert.equal(selected.status, "selected");
  assert.equal(shop.orders.size, 0);

  const vague = await runTurn(selected, "hmm, tell me more", { env: PAYMENT_ENV });
  assert.equal(vague.state.status, "selected");
  assert.equal(shop.orders.size, 0);

  return runTurn(selected, "yes, buy it", { env: PAYMENT_ENV });
}

function assertPaid(turn, shop, paymentPattern) {
  const text = turn.posts.join("\n");
  assert.equal(turn.state.status, "paid");
  assert.match(text, /Paying 16\.90 EUR for Payment Test Look/);
  assert.match(text, /Paid: \*\*Payment Test Look\*\*, 16\.90 EUR/);
  assert.equal(turn.state.checkout.status, "paid");
  assert.equal(turn.state.checkout.paidAmount, 16.9);
  assert.equal(turn.state.checkout.paidCurrency, "EUR");
  assert.match(turn.state.checkout.txHash, paymentPattern);
  assert.equal(shop.orders.size, 1);

  const order = [...shop.orders.values()][0];
  assert.equal(order.purchase_id, "chat-payment:look-1");
  assert.equal(order.total, 16.9);
  assert.equal(order.status, "paid");
  assert.equal(order.payment_intent_id, turn.state.checkout.txHash);
  return order;
}

test("a confirmed request starts and completes the checkout", async (t) => {
  const { shop, evidence } = await startHarness(t, "mock");
  const turn = await confirmedRequest(shop);
  const order = assertPaid(turn, shop, /^pi_mock_/);

  assert.equal(turn.state.checkout.mock, true);
  assert.equal(order.mock, true);

  const receiptFile = path.join(evidence, "chat-payment_look-1", "receipt.json");
  assert.equal(existsSync(receiptFile), true);
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.equal(receipt.amount, 16.9);
  assert.equal(receipt.mock_checkout.order_id, order.id);
  assert.equal(receipt.mock_checkout.payment_intent_id, order.payment_intent_id);
});

const stripeIntegration =
  process.env.AITELIER_RUN_STRIPE_INTEGRATION === "1" && isTestKey(stripeKey());

test(
  "a confirmed request creates a succeeded Stripe test PaymentIntent",
  {
    skip: stripeIntegration
      ? false
      : "Set AITELIER_RUN_STRIPE_INTEGRATION=1 and a test key to run this test.",
  },
  async (t) => {
    const { shop } = await startHarness(t, "stripe");
    const turn = await confirmedRequest(shop);
    const order = assertPaid(turn, shop, /^pi_/);

    assert.equal(turn.state.checkout.mock, false);
    assert.equal(order.mock, false);

    const intent = await new Stripe(stripeKey()).paymentIntents.retrieve(turn.state.checkout.txHash);
    assert.equal(intent.status, "succeeded");
    assert.equal(intent.amount, 1690);
    assert.equal(intent.currency, "eur");
    assert.equal(intent.livemode, false);
    assert.equal(intent.metadata.purchase_id, "chat-payment:look-1");
    assert.equal(intent.metadata.checkout_id, order.checkout_id);
  },
);
