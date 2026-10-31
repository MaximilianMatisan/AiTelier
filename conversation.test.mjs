import test from "node:test";
import assert from "node:assert/strict";
import {
  newConversation,
  extractSlots,
  mergeSlots,
  missing,
  orderFrom,
  detectIntent,
  nextTurn,
  presentOutfits,
  recordCheckout,
  normaliseOutfit,
} from "./logic/conversation.mjs";

const FULL = "Zwei Outfits im old money Stil für den Herbst, Budget 400 EUR, Größe M, Hose 32, Schuhe 43, Herren";

const result = {
  status: "APPROVED",
  outfits: [
    {
      outfit_id: "look-1",
      name: "Rainy Munich Classic",
      items: [
        { item_id: "a", title: "Oxford Shirt", brand: "Atelier", size: "M", price: { amount: 89.9, currency: "EUR" }, product_url: "https://shop.example/a" },
        { item_id: "b", title: "Wool Trousers", brand: "Atelier", size: "32", price: { amount: 120, currency: "EUR" }, product_url: "https://shop.example/b" },
      ],
      totals: { items: 209.9, shipping: 4.9, grand_total: 214.8, currency: "EUR" },
      rationale: "Tonal palette, weather ready.",
      guarantees: { ok: true },
    },
    {
      outfit_id: "look-2",
      name: "Quiet Weekend",
      items: [{ item_id: "c", title: "Knit Polo", brand: "Atelier", size: "M", price: { amount: 70, currency: "EUR" }, product_url: "https://shop.example/c" }],
      totals: { items: 70, shipping: 0, grand_total: 70, currency: "EUR" },
      guarantees: { ok: true },
    },
  ],
};

async function conversationAt(status) {
  // Walks the real turns, so the fixtures cannot drift from the state machine.
  let state = newConversation("chat-test");
  ({ state } = await nextTurn(state, FULL));
  const go = await nextTurn(state, "ja bitte");
  assert.equal(go.action.type, "run_pipeline");
  state = go.state;
  if (status === "styling") return state;
  ({ state } = presentOutfits(state, result));
  if (status === "presented") return state;
  ({ state } = await nextTurn(state, "nimm outfit 2"));
  return state;
}

test("a German brief fills every slot an order needs", () => {
  const { draft, rejected } = mergeSlots({}, extractSlots(FULL));
  assert.deepEqual(rejected, []);
  assert.deepEqual(missing(draft), []);
  assert.equal(draft.budget_eur, 400);
  assert.equal(draft.outfits, 2);
  assert.equal(draft.theme, "old_money");
  assert.equal(draft.season, "autumn");
  assert.equal(draft.gender, "men");
  assert.deepEqual(draft.sizes, { top: "M", waist: "32", shoe_eu: "43" });
  assert.equal(orderFrom(draft).ok, true);
});

test("a size needs a cue word, so a city or a temperature is not read as one", () => {
  const slots = extractSlots("Munich is 32 degrees in summer");
  assert.equal(slots.sizes, undefined);
  assert.equal(slots.season, "summer");
});

test("a style the catalogue has no products for is refused, not stored", () => {
  const { draft, rejected } = mergeSlots({}, { theme: "punk" });
  assert.equal(draft.theme, undefined);
  assert.match(rejected[0], /no products for "punk"/);
});

test("an incomplete order is asked about, at most three things at a time", async () => {
  const { state, reply, action } = await nextTurn(newConversation(), "Ich will zwei Outfits, streetwear");
  assert.equal(action.type, "none");
  assert.equal(state.status, "collecting");
  assert.match(reply, /2 outfits · streetwear/);
  assert.equal(reply.match(/^- /gm).length, 3);
  assert.match(reply, /5 things are still missing/);
});

test("a complete order waits for a go-ahead before the pipeline starts", async () => {
  const first = await nextTurn(newConversation(), FULL);
  assert.equal(first.action.type, "none");
  assert.equal(first.state.status, "ready");
  assert.match(first.reply, /Shall I search the shops/);

  const second = await nextTurn(first.state, "ja, such bitte");
  assert.equal(second.action.type, "run_pipeline");
  assert.equal(second.state.status, "styling");
  assert.equal(second.action.order.budget_eur, 400);
  assert.equal(second.action.order.sizes.top, "M");
});

test("a message during styling does not start a second run", async () => {
  const state = await conversationAt("styling");
  const turn = await nextTurn(state, "und wie lange noch?");
  assert.equal(turn.action.type, "none");
  assert.equal(turn.state.status, "styling");
});

test("the looks are presented numbered, with totals from Person 3", async () => {
  const state = await conversationAt("presented");
  const text = state.messages.at(-1).text;
  assert.equal(state.status, "presented");
  assert.equal(state.outfits.length, 2);
  assert.match(text, /\*\*1\. Rainy Munich Classic\*\* — 214\.80 EUR/);
  assert.match(text, /\*\*2\. Quiet Weekend\*\* — 70\.00 EUR/);
  assert.match(text, /Oxford Shirt \(Atelier\), size M, 89\.90 EUR/);
});

test("a run with no outfit that passed is not presented as something to buy", async () => {
  const state = await conversationAt("styling");
  const { state: after, reply } = presentOutfits(state, { status: "REFUND", outfits: [], decision: { reason: "No look passed all five guarantees" } });
  assert.equal(after.status, "ready");
  assert.deepEqual(after.outfits, []);
  assert.match(reply, /No look passed/);
  assert.match(after.messages.at(-1).text, /Nothing was charged/);
});

test("an outfit that failed its guarantees is never offered", () => {
  const { state } = presentOutfits(newConversation(), {
    outfits: [{ ...result.outfits[0], guarantees: { ok: false } }, result.outfits[1]],
  });
  assert.deepEqual(state.outfits.map((outfit) => outfit.name), ["Quiet Weekend"]);
  assert.equal(state.outfits[0].number, 1);
});

test("picking a look asks for one explicit confirmation with its total", async () => {
  const state = await conversationAt("selected");
  assert.equal(state.status, "selected");
  assert.equal(state.outfits[state.selection].name, "Quiet Weekend");
  assert.match(state.messages.at(-1).text, /Shall I pay 70\.00 EUR for this outfit\?/);
});

test("a look that is not on the table cannot be picked", async () => {
  const state = await conversationAt("presented");
  const turn = await nextTurn(state, "outfit 7 bitte");
  assert.equal(turn.state.status, "presented");
  assert.match(turn.reply, /no outfit 7/);
});

test("nothing is bought without a clear yes", async () => {
  const state = await conversationAt("selected");
  for (const text of ["hmm, erzähl mir mehr", "vielleicht", "wie ist der Stoff?"]) {
    const turn = await nextTurn(state, text);
    assert.equal(turn.action.type, "none", `"${text}" must not start a payment`);
    assert.equal(turn.state.status, "selected");
    assert.match(turn.reply, /only buy on a clear yes/);
  }
});

test("a no goes back to the looks and buys nothing", async () => {
  const state = await conversationAt("selected");
  const turn = await nextTurn(state, "nein, doch nicht");
  assert.equal(turn.action.type, "none");
  assert.equal(turn.state.status, "presented");
  assert.equal(turn.state.selection, null);
  assert.match(turn.reply, /Nothing bought/);
});

test("a yes on the confirmation hands the chosen outfit to checkout", async () => {
  const state = await conversationAt("selected");
  const turn = await nextTurn(state, "ja, kauf es");
  assert.equal(turn.action.type, "checkout");
  assert.equal(turn.action.outfit.outfit_id, "look-2");
  assert.equal(turn.action.outfit.total, 70);
  assert.equal(turn.state.status, "paying");
});

test("a paid purchase ends in a receipt, a failed one keeps the outfit on the table", async () => {
  const state = await conversationAt("selected");
  const paying = (await nextTurn(state, "ja")).state;

  const paid = recordCheckout(paying, { status: "paid", txHash: "abc123", mock: false });
  assert.equal(paid.state.status, "paid");
  assert.match(paid.reply, /Paid: \*\*Quiet Weekend\*\*, 70\.00 EUR/);
  assert.match(paid.reply, /abc123/);

  const failed = recordCheckout(paying, { status: "declined", detail: "No payment provider is wired in yet." });
  assert.equal(failed.state.status, "selected");
  assert.match(failed.reply, /nothing was bought/);
  assert.match(failed.reply, /No payment provider/);
});

test("the receipt shows the amount actually charged and the payment detail", async () => {
  const state = await conversationAt("selected");
  const paying = (await nextTurn(state, "ja")).state;
  const { reply } = recordCheckout(paying, {
    status: "paid",
    txHash: "pi_test_123",
    paidAmount: 9.6,
    paidCurrency: "EUR",
    detail: "Stripe test payment pi_test_123; order shop_order_1; real checkout reached payment.",
  });
  assert.match(reply, /Paid: \*\*Quiet Weekend\*\*, 9\.60 EUR/);
  assert.match(reply, /Stripe test payment pi_test_123/);
  assert.match(reply, /real checkout reached payment/);
});

test("a mock payment says that no money moved", async () => {
  const state = await conversationAt("selected");
  const paying = (await nextTurn(state, "ja")).state;
  const { reply } = recordCheckout(paying, { status: "paid", mock: true });
  assert.match(reply, /No money moved/i);
});

test("a change while the looks are up restyles instead of buying", async () => {
  const state = await conversationAt("presented");
  const turn = await nextTurn(state, "mach es lieber streetwear und Budget 600 EUR");
  assert.equal(turn.state.status, "ready");
  assert.equal(turn.state.draft.theme, "streetwear");
  assert.equal(turn.state.draft.budget_eur, 600);
  assert.deepEqual(turn.state.outfits, []);
  assert.match(turn.reply, /Shall I search the shops/);

  const again = await nextTurn(turn.state, "ja");
  assert.equal(again.action.type, "run_pipeline");
  assert.equal(again.action.order.theme, "streetwear");
});

test("starting over empties the draft and the looks", async () => {
  const state = await conversationAt("selected");
  const turn = await nextTurn(state, "lass uns von vorne anfangen");
  assert.equal(turn.state.status, "collecting");
  assert.deepEqual(turn.state.draft, {});
  assert.deepEqual(turn.state.outfits, []);
  assert.equal(turn.state.selection, null);
});

test("a model may propose slots, and the code validates them", async () => {
  const ask = async () => ({ reply: "Noted!", slots: { theme: "old money", budget_eur: 250, season: "autumn", outfits: 1, sizes: { top: "L", waist: 34, shoe_eu: 44 } } });
  const { state, reply } = await nextTurn(newConversation(), "etwas ruhiges für Herbst, ich bin L", { ask });
  assert.equal(state.status, "ready");
  assert.equal(state.draft.theme, "old_money");
  assert.deepEqual(state.draft.sizes, { top: "L", waist: "34", shoe_eu: "44" });
  assert.match(reply, /Noted!/);
});

test("a model that proposes nonsense cannot put it in the order", async () => {
  const ask = async () => ({ reply: "sure", slots: { theme: "cyberpunk", budget_eur: 99999, sizes: { top: "XXXXL" } } });
  const { state, reply } = await nextTurn(newConversation(), "überrasch mich", { ask });
  assert.equal(state.draft.theme, undefined);
  assert.equal(state.draft.budget_eur, undefined);
  assert.equal(state.draft.sizes?.top, undefined);
  assert.match(reply, /still missing/);
});

test("a model that fails costs wording, not the turn", async () => {
  const ask = async () => {
    throw new Error("429 rate limited");
  };
  const { state, action } = await nextTurn(newConversation(), FULL, { ask });
  assert.equal(action.type, "none");
  assert.equal(state.status, "ready");
  assert.equal(state.draft.budget_eur, 400);
});

test("every turn is recorded for both sides", async () => {
  const state = await conversationAt("presented");
  assert.deepEqual(
    state.messages.map((message) => message.role),
    ["customer", "agent", "customer", "agent", "agent"],
  );
  assert.ok(state.messages.every((message) => typeof message.at === "string" && message.text));
});

test("intents a purchase depends on are read without a model", () => {
  assert.deepEqual(detectIntent("ja"), { kind: "yes" });
  assert.deepEqual(detectIntent("Nein danke"), { kind: "no" });
  assert.deepEqual(detectIntent("nimm die zweite"), { kind: "pick", index: 2 });
  assert.deepEqual(detectIntent("outfit 3"), { kind: "pick", index: 3 });
  assert.deepEqual(detectIntent("zeig sie nochmal"), { kind: "show" });
  assert.deepEqual(detectIntent("von vorne"), { kind: "restart" });
  assert.deepEqual(detectIntent("was kostet der Versand?"), { kind: "message" });
});

test("an outfit without totals still carries a payable sum", () => {
  const outfit = normaliseOutfit({ name: "No totals", items: [{ title: "Tee", price: { amount: 30, currency: "EUR" }, product_url: "https://shop.example/t" }] }, 0);
  assert.equal(outfit.total, 30);
  assert.equal(outfit.currency, "EUR");
  assert.equal(outfit.number, 1);
});

test("the looks carry the link to the result page, also when shown again", async () => {
  const page = "https://aitelier.pages.dev/runs/abc/";
  const { state, reply } = presentOutfits(newConversation(), result, { page });
  assert.match(reply, /\*\*Your AiTelier page:\*\* \[every look with its boards and checks\]\(https:\/\/aitelier\.pages\.dev\/runs\/abc\/\)/);
  const again = await nextTurn(state, "zeig sie nochmal");
  assert.match(again.reply, /aitelier\.pages\.dev\/runs\/abc/);
});

test("without a published page the looks are still shown", () => {
  const { reply } = presentOutfits(newConversation(), result);
  assert.doesNotMatch(reply, /Your AiTelier page/);
  assert.match(reply, /Rainy Munich Classic/);
});
