import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readOrder, refusal, TEMPLATE } from "./logic/intake.mjs";
import { briefToCustomer, sizesFromLabels } from "./logic/run-pipeline.mjs";

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
