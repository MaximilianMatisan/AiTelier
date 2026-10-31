import Stripe from "stripe";
import { assertTestKey, stripeKey } from "../logic/purchase/stripe-test.mjs";

const key = stripeKey();
assertTestKey(key);
const cardId = String(process.env.STRIPE_ISSUING_CARD_ID ?? "").trim();
const cardholderId = String(process.env.STRIPE_ISSUING_CARDHOLDER_ID ?? "").trim();
const amount = Number(process.env.STRIPE_ISSUING_TEST_AMOUNT_CENTS ?? 100);
if (!cardId) throw new Error("STRIPE_ISSUING_CARD_ID is not set.");
if (!Number.isInteger(amount) || amount <= 0) throw new Error("STRIPE_ISSUING_TEST_AMOUNT_CENTS must be positive integer cents.");

const stripe = new Stripe(key);
const card = await stripe.issuing.cards.retrieve(cardId);
const summary = {
  card: card.id,
  status: card.status,
  type: card.type,
  brand: card.brand,
  last4: card.last4,
  exp: `${String(card.exp_month).padStart(2, "0")}/${card.exp_year}`,
  currency: card.currency,
  livemode: card.livemode,
  cardholder: cardholderId || card.cardholder?.id || null,
};
console.log("Issuing card", summary);

if (card.status !== "active") throw new Error(`Issuing card is ${card.status}, not active.`);

let authorization;
try {
  authorization = await stripe.testHelpers.issuing.authorizations.create({
    amount,
    currency: "eur",
    card: cardId,
    merchant_data: {
      name: "AiTelier Test Merchant",
      city: "Munich",
      country: "DE",
      category: "womens_ready_to_wear_stores",
    },
  });
} catch (error) {
  console.error("Issuing authorization failed:", error.message);
  process.exitCode = 1;
}

if (authorization) {
  const reason = authorization.request_history?.at(-1)?.reason ?? null;
  console.log("Issuing authorization", {
    id: authorization.id,
    status: authorization.status,
    approved: authorization.approved,
    amount: authorization.amount,
    currency: authorization.currency,
    reason,
    livemode: authorization.livemode,
  });
  if (!authorization.approved) {
    console.log(
      reason === "insufficient_funds"
        ? "The card is valid, but the test Issuing balance has no funds. Add test funds in the Stripe Dashboard under Issuing, then rerun."
        : "The authorization was declined. Check the card status, spending controls and test balance.",
    );
    process.exitCode = 2;
  } else if (["pending", "approved"].includes(authorization.status)) {
    const reversed = await stripe.testHelpers.issuing.authorizations.reverse(authorization.id);
    console.log("Issuing authorization reversed", { id: reversed.id, status: reversed.status });
  }
}
