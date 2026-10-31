// Step 8 · checkout. Where the conversation hands a confirmed outfit to the
// payment module, and the only place in the chat that can move money.
//
// Division of work: logic/conversation.mjs takes the customer's confirmation,
// this file turns the chosen look into a purchase and checks it against what
// Person 3 guaranteed, and the payment module executes it.
//
// ## Contract for the payment module
//
// Export one function and set AITELIER_PAYMENT to the module path:
//
//     AITELIER_PAYMENT=./logic/pay-cardano.mjs npm run ui
//
//     /** @param {Purchase} purchase */
//     export async function payOutfit(purchase, { signal } = {}) {
//       return { status: "paid", txHash: "…", paidAmount: 1, paidCurrency: "USDM" };
//     }
//
// A Purchase is what `purchaseFromOutfit()` below builds:
//
//     {
//       conversation_id: "chat-7f3a1c20",   // one conversation, many purchases
//       purchase_id: "chat-7f3a1c20:look-2",// stable: the same outfit twice is
//                                           // the same purchase, never two
//       outfit: { outfit_id, name },
//       items: [{ item_id, title, brand, size, price, currency, product_url }],
//       total: 289.4, shipping: 4.9, currency: "EUR",
//       budget_eur: 400,                     // what the customer agreed to
//       confirmed_at: "2026-10-31T12:04:11.900Z"
//     }
//
// The answer must be one of:
//
//     { status: "paid",     txHash?, paidAmount?, paidCurrency?, detail? }
//     { status: "declined", detail }   the customer or the wallet said no
//     { status: "failed",   detail }   it broke; nothing was bought
//
// Rules the payment module can rely on, because this file enforces them before
// it is called: one currency, every item has a shop link, the items add up to
// the total, the total is inside the budget the customer confirmed, and the
// guarantees Person 3 checked held. A purchase that fails any of these never
// reaches the module — the chat says why instead.
//
// Until a module is wired in, AITELIER_PAYMENT is unset and checkout declines
// with a plain message, or AITELIER_PAYMENT=mock answers "paid" with no
// transaction and `mock: true`, which the chat shows as "no money moved".
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../log.mjs";
const log = logger("checkout");

export const PAYMENT_STATUSES = ["paid", "declined", "failed"];
// Prices come from shops as decimals; totals may round a cent per item.
const CENT_TOLERANCE = 0.05;

/** The purchase the payment module executes, built from the chosen look. */
export function purchaseFromOutfit(outfit, { conversationId, budget_eur = null, now = new Date() } = {}) {
  return {
    conversation_id: String(conversationId ?? "chat"),
    purchase_id: `${conversationId ?? "chat"}:${outfit?.outfit_id ?? "look"}`,
    outfit: { outfit_id: outfit?.outfit_id ?? null, name: outfit?.name ?? "Outfit" },
    items: (outfit?.items ?? []).map((item) => ({
      item_id: item.item_id ?? null,
      title: item.title ?? "",
      brand: item.brand ?? "",
      size: item.size ?? "",
      price: Number(item.price ?? 0),
      currency: item.currency ?? outfit?.currency ?? "EUR",
      product_url: item.product_url ?? "",
    })),
    total: Number(outfit?.total ?? 0),
    shipping: Number(outfit?.shipping ?? 0),
    currency: outfit?.currency ?? "EUR",
    budget_eur: budget_eur == null ? null : Number(budget_eur),
    confirmed_at: new Date(now).toISOString(),
  };
}

/**
 * Everything money depends on, checked by code before a payment starts. An
 * empty list means the purchase may be executed.
 */
export function validatePurchase(purchase) {
  const errors = [];
  const items = purchase?.items ?? [];
  if (!items.length) errors.push("The outfit has no items.");
  if (!Number.isFinite(purchase?.total) || purchase.total <= 0) errors.push("The outfit has no total to pay.");
  const currencies = new Set([purchase?.currency, ...items.map((item) => item.currency)].filter(Boolean));
  if (currencies.size > 1) errors.push(`The outfit mixes currencies (${[...currencies].join(", ")}).`);
  for (const item of items) {
    if (!/^https?:\/\//.test(item.product_url ?? "")) errors.push(`"${item.title || item.item_id || "an item"}" has no shop link.`);
    if (!Number.isFinite(item.price) || item.price <= 0) errors.push(`"${item.title || item.item_id || "an item"}" has no price.`);
  }
  const sum = items.reduce((total, item) => total + (Number(item.price) || 0), 0) + (Number(purchase?.shipping) || 0);
  if (Number.isFinite(purchase?.total) && Math.abs(sum - purchase.total) > CENT_TOLERANCE * items.length + CENT_TOLERANCE)
    errors.push(`The items add up to ${sum.toFixed(2)}, not the ${Number(purchase.total).toFixed(2)} on the total.`);
  if (purchase?.budget_eur != null && Number.isFinite(purchase.total) && purchase.total > purchase.budget_eur + CENT_TOLERANCE)
    errors.push(`${Number(purchase.total).toFixed(2)} ${purchase.currency} is over the ${purchase.budget_eur} EUR budget you confirmed.`);
  return errors;
}

/** The mock provider: it buys nothing and says so, for demos without a wallet. */
export async function mockPay(purchase) {
  return {
    status: "paid",
    txHash: null,
    paidAmount: purchase.total,
    paidCurrency: purchase.currency,
    mock: true,
    detail: "Mock payment provider: no money moved.",
  };
}

/**
 * The payment module AITELIER_PAYMENT names, or null when none is wired in.
 * `mock` selects mockPay(); a path is read from the repository root, as it is
 * written in .env; anything else is taken as a package name. The module must
 * export payOutfit().
 */
export async function paymentProvider(env = process.env) {
  const setting = env.AITELIER_PAYMENT?.trim();
  if (!setting || setting === "off") return null;
  if (setting === "mock") return mockPay;
  const module = await import(
    /^[./]/.test(setting) ? pathToFileURL(path.resolve(process.cwd(), setting)).href : setting
  );
  const pay = module.payOutfit ?? module.default;
  if (typeof pay !== "function") throw new Error(`${setting} does not export payOutfit()`);
  return pay;
}

/** The answer a payment module gave, reduced to the three states the chat knows. */
export function normaliseOutcome(outcome) {
  const status = PAYMENT_STATUSES.includes(outcome?.status) ? outcome.status : "failed";
  return {
    status,
    txHash: typeof outcome?.txHash === "string" && outcome.txHash.trim() ? outcome.txHash.trim().slice(0, 200) : null,
    paidAmount: Number.isFinite(outcome?.paidAmount) ? outcome.paidAmount : null,
    paidCurrency: typeof outcome?.paidCurrency === "string" ? outcome.paidCurrency : null,
    mock: outcome?.mock === true,
    detail: typeof outcome?.detail === "string" ? outcome.detail.slice(0, 400) : "",
  };
}

/**
 * Pays for one confirmed outfit. Never throws: the chat has to be able to tell
 * the customer what happened, and a thrown error in a comment loop reads as a
 * silent agent.
 */
export async function payForOutfit(outfit, { conversationId, budget_eur = null, pay, env = process.env, timeoutMs = 120_000 } = {}) {
  const purchase = purchaseFromOutfit(outfit, { conversationId, budget_eur });
  const errors = validatePurchase(purchase);
  if (errors.length) {
    log.warn("purchase refused by checks", { conversation: purchase.conversation_id, errors });
    return { purchase, outcome: normaliseOutcome({ status: "declined", detail: errors.join(" ") }) };
  }
  let provider = pay;
  if (!provider) {
    try {
      provider = await paymentProvider(env);
    } catch (error) {
      log.error("payment module could not be loaded", { error: error.message });
      return { purchase, outcome: normaliseOutcome({ status: "failed", detail: `The payment module could not be loaded: ${error.message}` }) };
    }
  }
  if (!provider)
    return {
      purchase,
      outcome: normaliseOutcome({
        status: "declined",
        detail: "No payment provider is wired in yet, so I cannot buy this outfit. Every item above is linked, so you can order it yourself in the meantime.",
      }),
    };
  log.info("paying", { conversation: purchase.conversation_id, purchase: purchase.purchase_id, total: purchase.total, currency: purchase.currency });
  try {
    const outcome = normaliseOutcome(await provider(purchase, { signal: AbortSignal.timeout(timeoutMs) }));
    log[outcome.status === "paid" ? "info" : "warn"]("payment answered", {
      purchase: purchase.purchase_id,
      status: outcome.status,
      tx: outcome.txHash ?? null,
      mock: outcome.mock,
    });
    return { purchase, outcome };
  } catch (error) {
    log.error("payment failed", { purchase: purchase.purchase_id, error: error.message });
    return { purchase, outcome: normaliseOutcome({ status: "failed", detail: error.message }) };
  }
}
