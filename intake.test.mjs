import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readOrder,
  refusal,
  reviewOrder,
  welcome,
  HOW_TO_ORDER,
  ORDER_EXAMPLE,
  TEMPLATE,
} from "./logic/intake.mjs";
import {
  briefToCustomer,
  sizesFromLabels,
  seasonFromDate,
  unifySizes,
} from "./logic/run-pipeline.mjs";

const today = new Date("2026-10-30T12:00:00Z");
const read = (value) => readOrder(typeof value === "string" ? value : JSON.stringify(value), { today });

test("the team's catalog/order.json passes unchanged", () => {
  const order = JSON.parse(readFileSync("catalog/order.json", "utf8"));
  const result = read(order);
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.deepEqual(result.order, order);
});

test("the template a refused customer is shown is itself a valid order", () => {
  assert.equal(read(TEMPLATE).ok, true);
  const shown = refusal({ errors: ["x"] });
  assert.equal(read(shown).ok, true);
});

test("JSON is found in a fence or after a sentence", () => {
  assert.equal(read("Hi, here is my order:\n```json\n" + JSON.stringify(TEMPLATE) + "\n```").ok, true);
  assert.equal(read("Please style me: " + JSON.stringify(TEMPLATE) + " thanks").ok, true);
});

test("German and spoken spellings normalise to catalogue values", () => {
  const result = read({ ...TEMPLATE, theme: "Lässig", season: "Herbst", gender: "Herren", budget_eur: "250,50" });
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.equal(result.order.theme, "casual");
  assert.equal(result.order.season, "autumn");
  assert.equal(result.order.gender, "men");
  assert.equal(result.order.budget_eur, 250.5);
  assert.equal(read({ ...TEMPLATE, theme: "Old Money" }).order.theme, "old_money");
});

test("punk is refused before payment: the catalogue has no punk products", () => {
  const result = read({ ...TEMPLATE, theme: "punk" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /punk.*no products/);
});

test("every problem is reported at once, not one per retry", () => {
  const result = read({ budget_eur: -5, outfits: 0, theme: "old_money", season: "monsoon", needed_by: "2026-10-01" });
  assert.equal(result.ok, false);
  for (const field of ["budget_eur", "outfits", "season", "sizes", "needed_by"])
    assert.ok(result.errors.some((e) => e.includes(field)), `missing error for ${field}`);
});

test("a free-text order survives the file the Lead-Agent hands the pipeline", () => {
  // lead-agent.mjs writes intake.order to order.json; run-pipeline.mjs reads it back.
  const first = read("```\nmale, 150cm, Small; Slim; Old Money\n```");
  assert.deepEqual(first.order, { brief: "male, 150cm, Small; Slim; Old Money" }, "the fence is dropped");
  assert.deepEqual(read(JSON.stringify(first.order, null, 2)), first);
});

test("free text is an order: it goes to the filter as written", () => {
  const brief = "180cm, feet 40; winter; old money";
  assert.deepEqual(read(brief), { ok: true, order: { brief }, warnings: [] });
});

test("only an empty description is refused", () => {
  const result = read("   ");
  assert.equal(result.ok, false);
  assert.match(refusal(result), /plain words/);
});

test("a free-text brief becomes Person 3's customer from the filter's reading", () => {
  const selection = { budgetEur: 450, themes: ["old_money"], seasons: ["winter"], stock: ["M", "32", "43"] };
  const { envelope, budgetAssumed } = briefToCustomer("Three looks for winter, old money, men", selection);
  assert.equal(budgetAssumed, false);
  assert.equal(envelope.customer.budget.amount, 450);
  assert.equal(envelope.customer.outfit_count, 3);
  assert.deepEqual(envelope.customer.style, ["old money"]);
  assert.equal(envelope.customer.season, "winter");
  assert.equal(envelope.customer.gender, "men");
  assert.deepEqual([envelope.customer.sizes.base, envelope.customer.sizes.bottom, envelope.customer.sizes.shoes], ["M", "32", "43"]);
});

test("without a filter reading the budget comes from the text, or is assumed and said so", () => {
  assert.equal(briefToCustomer("winter coat, budget 300 €").envelope.customer.budget.amount, 300);
  const none = briefToCustomer("180cm, feet 40; winter; old money");
  assert.equal(none.budgetAssumed, true);
  assert.ok(none.envelope.customer.budget.amount > 0);
});

test("sizes the customer wrote out win over a broad filter reading", () => {
  const broad = { stock: ["32", "34", "36", "38", "40", "42", "L", "M", "S"] };
  const { sizes } = briefToCustomer("180cm, feet 40; winter; old money", broad).envelope.customer;
  assert.equal(sizes.shoes, "40");
  assert.equal(sizes.base, undefined, "height alone is not a top size");
  const all = briefToCustomer("top M, waist 32, shoes EU 43", broad).envelope.customer.sizes;
  assert.deepEqual([all.base, all.bottom, all.shoes], ["M", "32", "43"]);
});

test("sizes are only assigned when the labels are unambiguous", () => {
  assert.deepEqual(sizesFromLabels(["40"]), { top: undefined, waist: undefined, shoe_eu: "40" });
  assert.deepEqual(sizesFromLabels(["XS", "S", "M", "L", "36", "38", "40", "42"]), { top: undefined, waist: undefined, shoe_eu: undefined });
});

// The order is read before the escrow is requested, so an order AiTelier
// cannot fill costs the customer nothing. Before this, a description of
// "shopping" reached APPROVED on a guessed budget and a guessed size.
test("a description that names no garment or style is refused", () => {
  const review = reviewOrder("shopping", { today });
  assert.equal(review.action, "refuse");
  assert.match(review.message, /Nothing was charged/);
  assert.match(review.message, /does not describe clothing/);
});

test("groceries are not an outfit order", () => {
  assert.equal(reviewOrder("Buy groceries and household items", { today }).action, "refuse");
});

test("a clothing order with no size is asked about, never guessed", () => {
  // A guessed size is a return, not an outfit, so this must not reach payment.
  const review = reviewOrder("Organize black clothing collection", { today });
  assert.equal(review.action, "ask");
  assert.match(review.message, /top size/);
  assert.match(review.message, /waist/);
  assert.match(review.message, /shoe size/);
  assert.match(review.message, /Nothing was charged/);
});

test("a brief that states its sizes runs straight through", () => {
  assert.equal(reviewOrder("male, 150cm, Small; Slim; Old Money", { today }).action, "proceed");
  assert.equal(
    reviewOrder("Two autumn outfits, old money, top M, waist 32, shoes EU 43", { today }).action,
    "proceed",
  );
});

test("a malformed JSON order is refused, not answered at the customer's expense", () => {
  const review = reviewOrder(JSON.stringify({ ...TEMPLATE, sizes: undefined }), { today });
  assert.equal(review.action, "refuse");
  assert.match(review.message, /sizes is required/);
});

// The greeting is the first thing the customer reads, before the payment
// request and before any refusal.
test("the greeting states the bargain and shows an order to copy", () => {
  const text = welcome();
  assert.match(text, /pay only if all five guarantees hold/);
  assert.match(text, /returns your money/);
  assert.match(text, /will not guess/);
  assert.ok(text.includes(ORDER_EXAMPLE), "it shows the example order verbatim");
});

test("the form, the greeting and the refusal cannot drift apart", () => {
  // One copy of how to order, read by the form the customer fills in, the
  // greeting posted when the Task is picked up, and every refusal.
  assert.ok(welcome().includes(HOW_TO_ORDER));
  assert.ok(refusal({ errors: ["x"] }).includes(ORDER_EXAMPLE));
  assert.ok(reviewOrder("Organize black clothing collection", { today }).message.includes(ORDER_EXAMPLE));
});

test("how to order names every size the pipeline needs", () => {
  for (const needed of [/top/i, /waist/i, /shoes/i, /EUR/])
    assert.match(HOW_TO_ORDER, needed);
});

// Person 3 needs a season to leave shorts out of an October order. Given null
// it kept every season open, and a Munich autumn brief came back with shorts.
test("a season nobody stated is read from the date", () => {
  assert.equal(seasonFromDate(new Date("2026-10-31T09:00:00Z")), "autumn");
  assert.equal(seasonFromDate(new Date("2026-07-15T09:00:00Z")), "summer");
  assert.equal(seasonFromDate(new Date("2026-01-15T09:00:00Z")), "winter");
  assert.equal(seasonFromDate(new Date("2026-04-15T09:00:00Z")), "spring");
});

test("a season named in the brief beats the date", () => {
  assert.equal(seasonFromDate(new Date("2026-07-15T09:00:00Z"), "a winter coat for Munich"), "winter");
});

test("a stated temperature can only make the season colder", () => {
  // A cold June is a reason not to buy shorts, not a reason to buy a parka.
  assert.equal(seasonFromDate(new Date("2026-06-15T09:00:00Z"), "Munich, wet, 5-12 C"), "autumn");
  assert.equal(seasonFromDate(new Date("2026-06-15T09:00:00Z"), "Munich, 2 C"), "winter");
  // A warm October stays autumn: nothing here makes it warmer.
  assert.equal(seasonFromDate(new Date("2026-10-31T09:00:00Z"), "Munich, 24 C"), "autumn");
});

test("an October Munich brief reaches Person 3 as autumn, and says it was assumed", () => {
  const read = briefToCustomer("old money outfits, top M, waist 32, shoes EU 43, Munich wet 8-15 C", null, {
    today: new Date("2026-10-31T09:00:00Z"),
  });
  assert.equal(read.envelope.customer.season, "autumn");
  assert.equal(read.seasonAssumed, true);
});

test("a season the filter read is used as given", () => {
  const read = briefToCustomer("summer outfits", { seasons: ["summer"] }, {
    today: new Date("2026-10-31T09:00:00Z"),
  });
  assert.equal(read.envelope.customer.season, "summer");
  assert.equal(read.seasonAssumed, false);
});

// Person 3 matches one size per slot exactly, so a slot left open let it pick
// any: one result had shoes in 37 and 43 and trousers in 31 and 38.
const stocked = (category, sizes) => ({
  category,
  sizes: sizes.map(([label, in_stock]) => ({ label, in_stock })),
});

test("a slot the customer left open is settled on one size", () => {
  const envelope = {
    items: [
      stocked("shoes", [["43", true], ["43", true], ["37", true]]),
      stocked("shoes", [["43", true]]),
      stocked("bottom", [["32", true], ["32", true], ["31", true]]),
    ],
  };
  const { sizes, assumed } = unifySizes({ base: "M", mid: "M", outer: "M" }, envelope);
  assert.equal(sizes.shoes, "43", "the most stocked label wins");
  assert.equal(sizes.bottom, "32");
  assert.equal(sizes.base, "M", "a stated size is never replaced");
  assert.equal(assumed.length, 2, "both assumptions are reported");
  assert.match(assumed.join(" "), /was not stated/);
});

test("sizes out of stock do not win a slot", () => {
  const envelope = { items: [stocked("shoes", [["37", false], ["37", false], ["43", true]])] };
  assert.equal(unifySizes({}, envelope).sizes.shoes, "43");
});

test("a slot with nothing in the shortlist is left alone", () => {
  const { sizes, assumed } = unifySizes({}, { items: [] });
  assert.deepEqual(sizes, {});
  assert.deepEqual(assumed, []);
});

test("an equal tie is broken the same way every run", () => {
  // Two labels stocked equally must not depend on object or array order, or
  // the same order styled twice would come back in different sizes.
  const envelope = { items: [stocked("shoes", [["43", true], ["37", true]])] };
  const once = unifySizes({}, envelope).sizes.shoes;
  const again = unifySizes({}, { items: [stocked("shoes", [["37", true], ["43", true]])] }).sizes.shoes;
  assert.equal(once, again);
});
