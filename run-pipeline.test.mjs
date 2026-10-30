import test from "node:test";
import assert from "node:assert/strict";
import { orderToBrief, orderToCustomer, missingSlots } from "./logic/run-pipeline.mjs";
import { keepBuyable } from "./logic/buyable.mjs";

const order = {
  budget_eur: 300,
  outfits: 2,
  theme: "old_money",
  season: "autumn",
  sizes: { top: "M", waist: "32", shoe_eu: "43" },
};

test("every slot of customer.json filters on the customer's size", () => {
  // buyable.mjs keeps every item of a slot customer.json has no size for. A
  // renamed key would switch the size filter off without an error, and sold-out
  // sizes would reach the stylist and end in a refund.
  const wrongSize = (category) => ({ category, sizes: [{ label: "XXS", in_stock: true }] });
  const envelope = { items: ["top", "outer", "bottom", "shoes"].map(wrongSize) };
  const { envelope: out } = keepBuyable(envelope, orderToCustomer(order));
  assert.deepEqual(out.items, []);
});

test("without item_count the stylist gets three pieces per outfit", () => {
  assert.equal(orderToCustomer(order).customer.item_count, 6);
  assert.equal(orderToCustomer({ ...order, item_count: 4 }).customer.item_count, 4);
});

test("the brief leaves out what the order does not say", () => {
  // `avoid.length && …` yields 0 for an empty list; it must not reach the filter.
  const brief = orderToBrief({ ...order, avoid: [], owned: [] });
  assert.doesNotMatch(brief, /undefined|null|, 0\b/);
  assert.match(brief, /old money style/);
  assert.match(brief, /shoes EU 43/);
});

test("a shortlist without shoes is reported before the stylist runs", () => {
  assert.deepEqual(missingSlots([{ category: "top" }, { category: "bottom" }]), ["shoes"]);
  assert.deepEqual(missingSlots([{ category: "top" }, { category: "bottom" }, { category: "shoes" }]), []);
});
