import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeProduct, normalizeSize } from "./logic/data/normalize.js";
import { toPerson3Item, toPerson3Check, sampleAcrossShops } from "./logic/data/to_person3.js";

const seed = JSON.parse(readFileSync("catalog/shops.seed.json", "utf8"));
const items = JSON.parse(readFileSync("catalog/cache/products.json", "utf8"));

const shop = { id: "t", name: "T", domain: "t.example", country: "DE", currency: "EUR",
  default_delivery_days: 4, shipping: { amount_eur: 5, ships_to: ["DE"], estimated: true } };
const product = (over) => ({ id: 1, title: "Thing", handle: "thing", product_type: "", tags: "",
  options: [{ name: "Size" }], images: [{ src: "https://x/i.jpg" }],
  variants: [{ id: 11, option1: "M", price: "49.00", available: true }], ...over });

// --- catalogue invariants -----------------------------------------------
// `--shop <id>` once overwrote the catalogue with that single shop, wiping the
// other 36. This fails the moment that happens again.
test("the catalogue still covers every seeded shop", () => {
  const present = new Set(items.map((i) => i.shop_id));
  const missing = seed.filter((s) => s.products_json_ok && !present.has(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], `shops missing from the catalogue: ${missing}`);
});

test("item ids are unique", () => {
  // Pagination returned the same product twice when a shop's ordering shifted
  // between two page requests.
  const seen = new Set();
  const dupes = items.filter((i) => (seen.has(i.id) ? true : (seen.add(i.id), false)));
  assert.deepEqual(dupes.map((i) => i.id), []);
});

test("every item is priced above zero", () => {
  // A 0.00 "free gift" variant would otherwise enter budget arithmetic, and
  // guarantee 1 is about money.
  const free = items.filter((i) => !(i.price_eur > 0));
  assert.deepEqual(free.map((i) => i.id), []);
});

test("every item matches the agreed schema", () => {
  const cats = new Set(["top", "bottom", "shoes", "outer"]);
  for (const i of items) {
    assert.ok(cats.has(i.category), `${i.id} category ${i.category}`);
    assert.equal(i.stock_kind, "boolean");
    assert.ok(i.themes.length && i.seasons.length, `${i.id} themes/seasons`);
    assert.ok(/^https:\/\/[^/]+\/products\/.+/.test(i.url), `${i.id} url`);
    assert.ok(i.source?.handle && i.source.fetched_at, `${i.id} source`);
    for (const v of Object.values(i.stock)) assert.ok(v === 0 || v === 1, `${i.id} stock`);
  }
});

test("a variant id exists exactly for the sizes that are in stock", () => {
  for (const i of items) {
    const buyable = Object.entries(i.stock).filter(([, v]) => v === 1).map(([s]) => s).sort();
    assert.deepEqual(Object.keys(i.variants).sort(), buyable, `${i.id}`);
  }
});

// --- normalisation ------------------------------------------------------
test("sizes are normalised, unknown values survive", () => {
  assert.deepEqual(
    ["Medium", "EU 43 1/3", "W32", "xxl", "One Size", ""].map(normalizeSize),
    ["M", "43", "32", "XXL", "ONE", "ONE"],
  );
});

test("themes ignore tags, which carry customs codes", () => {
  // asphaltgold tags every jersey tee "knitted or crocheted" (an HS code), which
  // classified Nike t-shirts as old_money until tags were dropped for themes.
  const tee = normalizeProduct(product({
    title: "Nike NSW Loose T-Shirt", product_type: "Apparel",
    tags: ["knitted or crocheted", "Category:T-Shirt", "wool"],
  }), shop);
  assert.equal(tee.category, "top");
  assert.deepEqual(tee.themes, ["casual"]);
  assert.deepEqual(tee.seasons, ["spring", "summer", "autumn", "winter"]);
});

test("a wool knit reads as old_money for the cold half of the year", () => {
  const knit = normalizeProduct(product({ title: "Cable-knit lambswool sweater" }), shop);
  assert.deepEqual(knit.themes, ["old_money"]);
  assert.deepEqual(knit.seasons, ["autumn", "winter"]);
});

test("non-clothing is dropped, including keyword near-misses", () => {
  for (const title of ["Gift Card", "Shoe Care Kit", "Leather Belt"]) {
    assert.equal(normalizeProduct(product({ title }), shop), null, title);
  }
});

test("variants priced at zero do not make an item buyable", () => {
  const gift = normalizeProduct(product({
    title: "Free gift: cotton tee",
    variants: [{ id: 11, option1: "M", price: "0.00", available: true }],
  }), shop);
  assert.equal(gift, null);
});

test("a product with no available size is dropped", () => {
  const soldOut = normalizeProduct(product({
    title: "Oxford shirt",
    variants: [{ id: 11, option1: "M", price: "49.00", available: false }],
  }), shop);
  assert.equal(soldOut, null);
});

// --- Person 3 contract v1.0 ---------------------------------------------
test("outer becomes outerwear, never the dead `other` slot", () => {
  // `other` does not satisfy a required slot, so every coat would drop out.
  const coat = toPerson3Item(normalizeProduct(product({ title: "Wool trench coat" }), shop));
  assert.equal(coat.category, "outerwear");
  const slots = new Set(items.map((i) => toPerson3Item(i).category));
  assert.ok(!slots.has("other"), `items landed in \`other\`: ${[...slots]}`);
});

test("converted items carry every required contract field", () => {
  const out = toPerson3Item(normalizeProduct(product({ title: "Oxford shirt" }), shop), "desc");
  for (const f of ["item_id", "shop_id", "title", "category", "price", "product_url"]) {
    assert.ok(out[f], `required field ${f} missing`);
  }
  assert.deepEqual(out.price, { amount: 49, currency: "EUR" });
  assert.deepEqual(out.sizes, [{ label: "M", in_stock: true }]);
  assert.equal(out.images[0].role, "front");
});

test("variant ids survive in raw, so cart links can still be built", () => {
  const out = toPerson3Item(normalizeProduct(product({ title: "Oxford shirt" }), shop));
  assert.deepEqual(out.raw.variants, { M: 11 });
});

test("a cached final-check record is marked stale", () => {
  // Section 9 fails strict guarantees on stale records: a cached answer cannot
  // prove live stock.
  const item = { id: "t-1", shop_id: "t", url: "https://t.example/products/thing" };
  const fresh = { fetched_at: "2026-10-30T13:10:00Z", url_ok: true, price_eur: 49,
    stock: { S: 0, M: 1 }, source: "cache" };
  const rec = toPerson3Check(item, fresh, shop);
  assert.equal(rec.stale, true);
  assert.equal(rec.availability, "in_stock");
  assert.deepEqual(rec.sizes_in_stock, ["M"]);
  assert.equal(toPerson3Check(item, { ...fresh, source: "live" }, shop).stale, false);
});

test("an unreachable product is unknown, not sold out", () => {
  const rec = toPerson3Check({ id: "t-1", shop_id: "t", url: "https://t.example/products/thing" },
    { fetched_at: "x", url_ok: false, price_eur: null, stock: {}, source: "cache" }, shop);
  assert.equal(rec.availability, "unknown");
  assert.equal(rec.price, null);
});

test("sampling respects the 100-item and 30-shop caps", () => {
  const sample = sampleAcrossShops(items, 100);
  assert.equal(sample.length, 100);
  assert.ok(new Set(sample.map((i) => i.shop_id)).size <= 30);
});
