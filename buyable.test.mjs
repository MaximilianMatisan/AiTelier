import test from "node:test";
import assert from "node:assert/strict";
import { unbuyable, keepBuyable } from "./logic/buyable.mjs";

// The customer.json shape run-pipeline.mjs writes: tops, mid and outer use the top size.
const sizes = { base: "M", mid: "M", outer: "M", bottom: "32", shoes: "43" };
const item = (category, ...labels) => ({
  category,
  sizes: labels.map((l) => (typeof l === "string" ? { label: l, in_stock: true } : l)),
});

test("a sold-out customer size is dropped: the refund cause seen on real runs", () => {
  assert.equal(unbuyable(item("top", { label: "M", in_stock: false }, "L"), sizes), "size M sold out");
  assert.equal(unbuyable(item("shoes", { label: "43", in_stock: false }), sizes), "size 43 sold out");
});

test("a letter-sized bottom cannot serve a waist-32 customer", () => {
  assert.equal(unbuyable(item("bottom", "S", "M", "L"), sizes), "size 32 not offered");
  assert.equal(unbuyable(item("bottom", "30", "32"), sizes), null);
});

test("matching ignores case, as Person 3's resolver does", () => {
  assert.equal(unbuyable(item("outerwear", "m"), sizes), null);
});

test("items and slots the resolver accepts without a match are kept", () => {
  assert.equal(unbuyable(item("top"), sizes), null, "no sizes listed");
  assert.equal(unbuyable(item("accessory", "ONE"), sizes), null, "no customer size for the slot");
  assert.equal(unbuyable(item("top", { label: "M", in_stock: null }), sizes), null, "stock unknown");
});

test("keepBuyable counts what each category loses", () => {
  const envelope = { items: [item("top", "M"), item("top", "S"), item("shoes", "43")] };
  const { envelope: out, counts } = keepBuyable(envelope, { customer: { sizes } });
  assert.equal(out.items.length, 2);
  assert.deepEqual(counts, { top: { kept: 1, dropped: 1 }, shoes: { kept: 1, dropped: 0 } });
});
