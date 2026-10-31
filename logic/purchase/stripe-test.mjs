// Stripe test-mode payment for the mock merchant.
//
// Two rules matter more than anything else here:
//   1. Only a test key is accepted. A live key is refused before a network call.
//   2. The browser never supplies the amount. The mock shop stores the checkout
//      server-side and passes the stored total to this module.
//
// The card digits the browser types are theatre for the demo. The actual test
// payment uses Stripe's `pm_card_visa` token, so no PAN is stored or logged.
import { randomUUID } from "node:crypto";
import Stripe from "stripe";

const TEST_KEY = /^(?:sk|rk)_test_/;
const CURRENCY = /^[a-z]{3}$/;

/** The secret key under either name this repo has used. */
export function stripeKey(env = process.env) {
  return String(env.STRIPE_SECRET_KEY ?? env.SECRET_STRIPE_KEY ?? "").trim();
}

/** True only for Stripe test-mode secret or restricted keys. */
export function isTestKey(key) {
  return typeof key === "string" && TEST_KEY.test(key.trim());
}

export function assertTestKey(key) {
  if (!isTestKey(key))
    throw new Error(
      "Stripe is in test mode but STRIPE_SECRET_KEY is missing or is not a test key (sk_test_... or rk_test_...).",
    );
  return key.trim();
}

/** `mock` keeps the whole checkout offline; anything else uses Stripe test mode. */
export function stripeMode(env = process.env) {
  return String(env.AITELIER_STRIPE_MODE ?? "stripe").trim().toLowerCase() === "mock"
    ? "mock"
    : "stripe";
}

export function toCents(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error("Amount is not a finite number.");
  return Math.round(value * 100);
}

/**
 * Creates and confirms a Stripe test PaymentIntent, or a deterministic fake in
 * mock mode. `amountCents` must come from server-side state, never from the
 * browser's form.
 */
export async function createTestPayment(
  { amountCents, currency = "eur", description = "", metadata = {}, key = stripeKey(), mode = stripeMode(), idempotencyKey } = {},
) {
  if (!Number.isInteger(amountCents) || amountCents <= 0)
    throw new Error("Payment amount must be a positive integer number of cents.");
  const cur = String(currency).toLowerCase();
  if (!CURRENCY.test(cur)) throw new Error("Payment currency must be a three-letter code.");

  if (mode === "mock") {
    return {
      id: `pi_mock_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      status: "succeeded",
      livemode: false,
      amount: amountCents,
      currency: cur,
      mock: true,
    };
  }

  const secret = assertTestKey(key);
  const stripe = new Stripe(secret);
  const safeMetadata = Object.fromEntries(
    Object.entries({ ...metadata, mode: "test" })
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => [name, String(value).slice(0, 500)]),
  );
  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: cur,
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: String(description).slice(0, 500),
      metadata: safeMetadata,
    },
    idempotencyKey ? { idempotencyKey: String(idempotencyKey).slice(0, 255) } : undefined,
  );
  if (paymentIntent.livemode)
    throw new Error("Stripe answered with a live PaymentIntent; refusing to continue.");
  if (paymentIntent.status !== "succeeded")
    throw new Error(`Stripe test PaymentIntent is ${paymentIntent.status}, not succeeded.`);
  return {
    id: paymentIntent.id,
    status: paymentIntent.status,
    livemode: paymentIntent.livemode,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    mock: false,
  };
}
