import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readOrder, refusal, TEMPLATE } from "./logic/intake.mjs";

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

test("free text without JSON is refused with the template", () => {
  const result = read("Budget 600 EUR, 3 outfits, old money, autumn.");
  assert.equal(result.ok, false);
  assert.match(refusal(result), /"budget_eur": 300/);
});
