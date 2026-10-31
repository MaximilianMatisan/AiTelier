import test from "node:test";
import assert from "node:assert/strict";
import {
  isTestKey,
  assertTestKey,
  stripeKey,
  stripeMode,
  toCents,
  createTestPayment,
} from "./logic/purchase/stripe-test.mjs";
import { createShop } from "./mock-shop/server.mjs";
import { forbiddenClick, validateAgentAction, sameOrigin } from "./logic/purchase/agent-browser.mjs";

const TEST_KEY = "sk_test_1234567890";
const RESTRICTED_TEST_KEY = "rk_test_1234567890";
const LIVE_KEY = "sk_live_1234567890";

test("only Stripe test keys are accepted", () => {
  assert.equal(isTestKey(TEST_KEY), true);
  assert.equal(isTestKey(RESTRICTED_TEST_KEY), true);
  assert.equal(isTestKey(LIVE_KEY), false);
  assert.equal(isTestKey("pk_test_123"), false);
  assert.equal(isTestKey(""), false);
  assert.equal(isTestKey(undefined), false);
});

test("a live or missing key is refused before any network call", () => {
  assert.throws(() => assertTestKey(LIVE_KEY), /not a test key/);
  assert.throws(() => assertTestKey(""), /not a test key/);
  assert.equal(assertTestKey(`  ${TEST_KEY}  `), TEST_KEY);
});

test("the secret key can arrive as STRIPE_SECRET_KEY or SECRET_STRIPE_KEY", () => {
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: ` ${TEST_KEY} ` }), TEST_KEY);
  assert.equal(stripeKey({ SECRET_STRIPE_KEY: TEST_KEY }), TEST_KEY);
  assert.equal(stripeKey({ STRIPE_SECRET_KEY: TEST_KEY, SECRET_STRIPE_KEY: "older" }), TEST_KEY);
  assert.equal(stripeKey({}), "");
});

test("stripe mode defaults to test and is mock only when asked", () => {
  assert.equal(stripeMode({}), "stripe");
  assert.equal(stripeMode({ AITELIER_STRIPE_MODE: "stripe" }), "stripe");
  assert.equal(stripeMode({ AITELIER_STRIPE_MODE: "MOCK" }), "mock");
});

test("euro amounts become integer cents", () => {
  assert.equal(toCents(64.9), 6490);
  assert.equal(toCents("12"), 1200);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.throws(() => toCents("not a number"), /finite/);
});

test("mock mode pays without a key and without a network call", async () => {
  const payment = await createTestPayment({
    amountCents: 6490,
    currency: "eur",
    mode: "mock",
    key: undefined,
    metadata: { checkout_id: "chk_1" },
  });
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.livemode, false);
  assert.equal(payment.mock, true);
  assert.equal(payment.amount, 6490);
  assert.equal(payment.currency, "eur");
  assert.match(payment.id, /^pi_mock_/);
});

test("test mode refuses a live key before creating a PaymentIntent", async () => {
  await assert.rejects(
    () => createTestPayment({ amountCents: 1000, mode: "stripe", key: LIVE_KEY }),
    /not a test key/,
  );
});

test("test mode refuses a missing key", async () => {
  await assert.rejects(
    () => createTestPayment({ amountCents: 1000, mode: "stripe", key: "" }),
    /not a test key/,
  );
});

test("payment amounts must be positive integer cents in a three-letter currency", async () => {
  for (const amountCents of [0, -1, 1.5, "1000", undefined]) {
    await assert.rejects(
      () => createTestPayment({ amountCents, mode: "mock" }),
      /positive integer/,
    );
  }
  await assert.rejects(
    () => createTestPayment({ amountCents: 1000, currency: "euro", mode: "mock" }),
    /three-letter/,
  );
});

test("the mock shop computes subtotal, shipping and total server-side", () => {
  const shop = createShop({ paymentMode: "mock", stripeKey: undefined });
  const checkout = shop.newCheckout({
    purchase_id: "demo:look-1",
    items: [
      { title: "Polo", brand: "ThokkThokk", size: "M", quantity: 1, price: 12, currency: "EUR", product_url: "https://shop.example/polo" },
      { title: "Merino zip", brand: "Atelier Nord", size: "M", quantity: 1, price: 64.9, currency: "EUR", product_url: "https://shop.example/zip" },
    ],
    shipping: 4.9,
    total: 81.8,
  });
  assert.equal(checkout.status, "open");
  assert.equal(checkout.subtotal, 76.9);
  assert.equal(checkout.shipping, 4.9);
  assert.equal(checkout.total, 81.8);
  assert.equal(checkout.payment_mode, "mock");
  assert.equal(checkout.items.length, 2);
  assert.equal(checkout.items[1].size, "M");
});

test("the mock shop rejects a browser-supplied total that does not match its own", () => {
  const shop = createShop({ paymentMode: "mock" });
  assert.throws(
    () => shop.newCheckout({
      items: [{ title: "Polo", price: 12, quantity: 1, currency: "EUR" }],
      shipping: 4.9,
      total: 1,
    }),
    /does not match/,
  );
});

test("the agent browser refuses payment and secret actions", () => {
  assert.equal(forbiddenClick("Jetzt kaufen"), true);
  assert.equal(forbiddenClick("Bestellung abschließen"), true);
  assert.equal(forbiddenClick("In den Warenkorb"), false);
  assert.equal(forbiddenClick("Checkout"), false);

  const snapshot = {
    elements: [
      { index: 0, tag: "button", text: "In den Warenkorb", disabled: false },
      { index: 1, tag: "button", text: "Jetzt kaufen", disabled: false },
      { index: 2, tag: "input", name: "address1", id: "shipping-address1", text: "", disabled: false },
      { index: 3, tag: "input", name: "cardNumber", id: "card-number", text: "Card number", disabled: false },
    ],
  };
  assert.equal(validateAgentAction({ action: "click", index: 0 }, snapshot, "https://shop.example/p").ok, true);
  assert.equal(validateAgentAction({ action: "click", index: 1 }, snapshot, "https://shop.example/p").ok, false);
  assert.equal(validateAgentAction({ action: "fill", index: 2, value: "Arcisstrasse 21" }, snapshot, "https://shop.example/p").ok, true);
  assert.equal(validateAgentAction({ action: "fill", index: 3, value: "4242" }, snapshot, "https://shop.example/p").ok, false);
  assert.equal(validateAgentAction({ action: "goto", value: "https://other.example" }, snapshot, "https://shop.example/p").ok, false);
  assert.equal(validateAgentAction({ action: "goto", value: "/cart" }, snapshot, "https://shop.example/p").ok, true);
  assert.equal(sameOrigin("https://shop.example/cart", "https://shop.example/product"), true);
  assert.equal(sameOrigin("javascript:alert(1)", "https://shop.example/product"), false);
});

test("the mock shop refuses non-EUR and oversized carts", () => {
  const shop = createShop({ paymentMode: "mock" });
  assert.throws(
    () => shop.newCheckout({ items: [{ title: "Polo", price: 12, currency: "USD" }] }),
    /only charges EUR/,
  );
  assert.throws(
    () => shop.newCheckout({
      items: Array.from({ length: 11 }, (_, i) => ({ title: `Item ${i}`, price: 1, currency: "EUR" })),
    }),
    /at most 10 items/,
  );
});
