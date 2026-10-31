import test from "node:test";
import assert from "node:assert/strict";
import {
  purchaseFromOutfit,
  validatePurchase,
  normaliseOutcome,
  paymentProvider,
  payForOutfit,
  mockPay,
} from "./logic/checkout.mjs";

const outfit = {
  number: 1,
  outfit_id: "look-1",
  name: "Rainy Munich Classic",
  items: [
    { item_id: "a", title: "Oxford Shirt", brand: "Atelier", size: "M", price: 89.9, currency: "EUR", product_url: "https://shop.example/a" },
    { item_id: "b", title: "Wool Trousers", brand: "Atelier", size: "32", price: 120, currency: "EUR", product_url: "https://shop.example/b" },
  ],
  total: 214.8,
  shipping: 4.9,
  currency: "EUR",
  guaranteed: true,
};

test("a purchase carries what a payment module needs, and nothing else", () => {
  const purchase = purchaseFromOutfit(outfit, { conversationId: "chat-1", budget_eur: 400, now: new Date("2026-10-31T12:00:00Z") });
  assert.equal(purchase.conversation_id, "chat-1");
  assert.equal(purchase.purchase_id, "chat-1:look-1");
  assert.deepEqual(purchase.outfit, { outfit_id: "look-1", name: "Rainy Munich Classic" });
  assert.equal(purchase.total, 214.8);
  assert.equal(purchase.currency, "EUR");
  assert.equal(purchase.budget_eur, 400);
  assert.equal(purchase.confirmed_at, "2026-10-31T12:00:00.000Z");
  assert.deepEqual(Object.keys(purchase.items[0]), ["item_id", "title", "brand", "size", "price", "currency", "product_url"]);
});

test("the same outfit confirmed twice is the same purchase id", () => {
  const first = purchaseFromOutfit(outfit, { conversationId: "chat-1" });
  const second = purchaseFromOutfit(outfit, { conversationId: "chat-1" });
  assert.equal(first.purchase_id, second.purchase_id);
});

test("a sound purchase passes the checks", () => {
  assert.deepEqual(validatePurchase(purchaseFromOutfit(outfit, { conversationId: "chat-1", budget_eur: 400 })), []);
});

test("a purchase over the confirmed budget is refused", () => {
  const errors = validatePurchase(purchaseFromOutfit(outfit, { conversationId: "chat-1", budget_eur: 200 }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /over the 200 EUR budget/);
});

test("a purchase whose items do not add up to its total is refused", () => {
  const errors = validatePurchase(purchaseFromOutfit({ ...outfit, total: 999 }, { conversationId: "chat-1" }));
  assert.match(errors[0], /add up to 214\.80, not the 999\.00/);
});

test("mixed currencies, missing links and missing prices are refused", () => {
  const broken = purchaseFromOutfit(
    {
      ...outfit,
      items: [
        { ...outfit.items[0], currency: "USD" },
        { ...outfit.items[1], product_url: "", price: 0 },
      ],
    },
    { conversationId: "chat-1" },
  );
  const errors = validatePurchase(broken);
  assert.ok(errors.some((error) => /mixes currencies/.test(error)));
  assert.ok(errors.some((error) => /no shop link/.test(error)));
  assert.ok(errors.some((error) => /no price/.test(error)));
});

test("an empty outfit is refused", () => {
  const errors = validatePurchase(purchaseFromOutfit({ ...outfit, items: [], total: 0 }, { conversationId: "chat-1" }));
  assert.ok(errors.some((error) => /no items/.test(error)));
  assert.ok(errors.some((error) => /no total/.test(error)));
});

test("with no provider wired in, checkout declines and says so", async () => {
  const { outcome } = await payForOutfit(outfit, { conversationId: "chat-1", budget_eur: 400, env: {} });
  assert.equal(outcome.status, "declined");
  assert.match(outcome.detail, /No payment provider is wired in yet/);
  assert.equal(outcome.txHash, null);
});

test("a refused purchase never reaches the payment module", async () => {
  let called = false;
  const { outcome } = await payForOutfit(outfit, {
    conversationId: "chat-1",
    budget_eur: 50,
    pay: async () => ((called = true), { status: "paid" }),
  });
  assert.equal(called, false);
  assert.equal(outcome.status, "declined");
  assert.match(outcome.detail, /over the 50 EUR budget/);
});

test("the mock provider pays nothing and marks itself", async () => {
  const { outcome } = await payForOutfit(outfit, { conversationId: "chat-1", budget_eur: 400, env: { AITELIER_PAYMENT: "mock" } });
  assert.equal(outcome.status, "paid");
  assert.equal(outcome.mock, true);
  assert.equal(outcome.txHash, null);
  assert.equal(outcome.paidAmount, 214.8);
});

test("a real provider gets the purchase and its answer is passed on", async () => {
  let seen;
  const { purchase, outcome } = await payForOutfit(outfit, {
    conversationId: "chat-1",
    budget_eur: 400,
    pay: async (p) => ((seen = p), { status: "paid", txHash: "deadbeef", paidAmount: 1, paidCurrency: "USDM" }),
  });
  assert.equal(seen.purchase_id, purchase.purchase_id);
  assert.equal(seen.items.length, 2);
  assert.equal(outcome.status, "paid");
  assert.equal(outcome.txHash, "deadbeef");
  assert.equal(outcome.paidCurrency, "USDM");
  assert.equal(outcome.mock, false);
});

test("a provider that throws becomes a failed payment, not a crash", async () => {
  const { outcome } = await payForOutfit(outfit, {
    conversationId: "chat-1",
    budget_eur: 400,
    pay: async () => {
      throw new Error("wallet offline");
    },
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail, /wallet offline/);
});

test("an unknown status from a provider counts as failed", () => {
  assert.equal(normaliseOutcome({ status: "maybe" }).status, "failed");
  assert.equal(normaliseOutcome(undefined).status, "failed");
  assert.equal(normaliseOutcome({ status: "paid", txHash: "  abc  " }).txHash, "abc");
});

test("AITELIER_PAYMENT selects the provider", async () => {
  assert.equal(await paymentProvider({}), null);
  assert.equal(await paymentProvider({ AITELIER_PAYMENT: "off" }), null);
  assert.equal(await paymentProvider({ AITELIER_PAYMENT: "mock" }), mockPay);
  await assert.rejects(() => paymentProvider({ AITELIER_PAYMENT: "./logic/intake.mjs" }), /does not export payOutfit/);
});

test("a module that cannot be loaded is a failed payment with its reason", async () => {
  const { outcome } = await payForOutfit(outfit, {
    conversationId: "chat-1",
    budget_eur: 400,
    env: { AITELIER_PAYMENT: "./logic/does-not-exist.mjs" },
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail, /could not be loaded/);
});
