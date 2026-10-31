import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  orderToBrief,
  orderToCustomer,
  missingSlots,
  layerOwned,
  requiredLayersFor,
  layersMinusOwned,
} from "./logic/run-pipeline.mjs";
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

// Person 3 never reads customer.owned, so a brief that mentions a garment the
// customer already has made the model leave that layer out - correctly - and
// the resolver then refused the outfit for a missing layer.
test("an owned garment is placed in the layer it fills", () => {
  assert.equal(layerOwned("black slim jeans"), "bottom");
  assert.equal(layerOwned("navy chinos"), "bottom");
  assert.equal(layerOwned("white sneakers"), "shoes");
  assert.equal(layerOwned("leather loafers"), "shoes");
  assert.equal(layerOwned("trench coat"), "outer");
  assert.equal(layerOwned("white t-shirt"), "base");
  assert.equal(layerOwned("oxford shirt"), "base");
  // The catalogue calls both of these "top"; Person 3 keeps base and mid apart.
  assert.equal(layerOwned("wool sweater"), "mid");
  assert.equal(layerOwned("cashmere cardigan"), "mid");
});

test("an owned thing that is not a garment is left unplaced", () => {
  // Better no answer than the wrong layer: dropping one buys nothing for it.
  assert.equal(layerOwned("a nice watch"), null);
  assert.equal(layerOwned(""), null);
  assert.equal(layerOwned(undefined), null);
});

test("owning the bottom leaves the rest of an autumn outfit to buy", () => {
  const plan = layersMinusOwned({ season: "autumn", owned: ["black slim jeans"] });
  assert.deepEqual(plan, { required: ["base", "mid", "shoes"], covered: ["bottom"] });
});

test("Person 3 is left alone when there is nothing to subtract", () => {
  // No options.required_layers is sent, so Person 3's own rule decides and
  // this duplication stays out of the path of every other order.
  assert.equal(layersMinusOwned({ season: "autumn" }), null);
  assert.equal(layersMinusOwned({ season: "autumn", owned: [] }), null);
  assert.equal(layersMinusOwned({ season: "autumn", owned: ["a nice watch"] }), null);
  // Summer needs no mid layer, so owning a sweater subtracts nothing.
  assert.equal(layersMinusOwned({ season: "summer", owned: ["wool sweater"] }), null);
});

test("owning a whole outfit is not turned into an empty order", () => {
  assert.equal(
    layersMinusOwned({ season: "summer", owned: ["white t-shirt", "navy chinos", "white sneakers"] }),
    null,
  );
});

test("the layers asked for match Person 3's own rule in every branch", () => {
  assert.deepEqual(requiredLayersFor({ season: "summer" }), ["base", "bottom", "shoes"]);
  assert.deepEqual(requiredLayersFor({ season: "winter" }), ["base", "mid", "outer", "bottom", "shoes"]);
  assert.deepEqual(requiredLayersFor({ season: "autumn" }), ["base", "mid", "bottom", "shoes"]);
  assert.deepEqual(requiredLayersFor({ season: "spring" }), ["base", "mid", "bottom", "shoes"]);
  assert.deepEqual(requiredLayersFor({}), ["base", "bottom", "shoes"]);
  // Read from climate and fit_description too, not only the season.
  assert.deepEqual(requiredLayersFor({ climate: "Munich, wet, 8-15 C" }), ["base", "mid", "bottom", "shoes"]);
  assert.deepEqual(requiredLayersFor({ fit_description: "something for freezing weather" }), [
    "base", "mid", "outer", "bottom", "shoes",
  ]);
  // Person 3 tests summer first, so summer wins when both words appear.
  assert.deepEqual(requiredLayersFor({ season: "summer", climate: "cold nights" }), ["base", "bottom", "shoes"]);
});

test("Person 3's rule has not changed under the copy of it", () => {
  // requiredLayersFor mirrors StylistRequest.required_layers because Person 3
  // offers no way to subtract one layer - we must send the whole list. If this
  // fails, Person 3's rule moved and the mirror has to move with it.
  const models = readFileSync("person3/app/models.py", "utf8");
  for (const fragment of [
    '("summer", "hot", "warm", "tropical")',
    '("winter", "cold", "snow", "freezing")',
    '("autumn", "spring", "mild", "rain", "wet")',
    'return ["base", "bottom", "shoes"]',
    'return ["base", "mid", "outer", "bottom", "shoes"]',
    'return ["base", "mid", "bottom", "shoes"]',
  ])
    assert.ok(models.includes(fragment), `person3/app/models.py no longer contains ${fragment}`);
});
