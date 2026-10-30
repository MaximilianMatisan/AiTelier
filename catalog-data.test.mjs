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

test("fetched_at tells the truth about when the data was collected", () => {
  // An offline rebuild used to stamp "now" on cached data, so week-old items
  // would have looked seconds fresh. This becomes Person 3's `collected_at`.
  const shops = [...new Set(items.map((i) => i.shop_id))];
  for (const id of shops) {
    const raw = JSON.parse(readFileSync(`catalog/cache/raw/${id}.json`, "utf8"));
    const stamped = new Set(items.filter((i) => i.shop_id === id).map((i) => i.source.fetched_at));
    assert.deepEqual([...stamped], [raw.fetched_at], `${id} fetched_at drifted from its raw file`);
  }
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
test("size options are recognised by the words shops actually use", async () => {
  // Exact matching filed 272 pairs of jeans under "ONE" because armedangels
  // calls the option "Waist", and missed "Damen Bekleidung Größe" and
  // "Tamanhos". "Title" is Shopify's name for no options at all.
  const { isSizeOption } = await import("./logic/data/normalize.js");
  for (const name of ["Size", "Größe", "Damen Bekleidung Größe", "Tamanhos", "Waist", "Shoe Size", "Boxer Briefs (Size)"]) {
    assert.ok(isSizeOption(name), `${name} should be a size option`);
  }
  for (const name of ["Title", "Color", "Farbe", "Length", "variant_id", "Amount"]) {
    assert.ok(!isSizeOption(name), `${name} should not be a size option`);
  }
});

test("a combined label covers both of its sizes", async () => {
  // A garment sold as "M/L" fits a customer asking for M. A numeric "32/34"
  // is a waist and a leg length, not two sizes.
  const { sizeLabels } = await import("./logic/data/normalize.js");
  assert.deepEqual(sizeLabels("M/L"), ["M", "L"]);
  assert.deepEqual(sizeLabels("XXS/XS"), ["XXS", "XS"]);
  assert.deepEqual(sizeLabels("32/34"), ["32"]);
  assert.deepEqual(sizeLabels("M"), ["M"]);
  assert.deepEqual(sizeLabels(""), ["ONE"]);
  const combined = items.filter((i) => Object.keys(i.stock).some((k) => k.includes("/")));
  assert.deepEqual(combined.map((i) => i.id), [], "no catalogue label should still hold a slash");
});

test("a sleeve belongs to a top, whatever its length", () => {
  // "short" is a whole word in "Short sleeve shirt", which filed 113 t-shirts
  // as trousers.
  const sleeved = items.filter(
    (i) => i.category === "bottom" && /\b(short|long)[- ]?sleeve/i.test(i.name),
  );
  assert.deepEqual(sleeved.map((i) => i.name), []);
});

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

// --- the live re-check service -------------------------------------------
test("an item we cannot look up is never reported as in stock", async () => {
  // Person 3 decides guarantee 3 on this record. Claiming stock for an item
  // we failed to find would put money behind something we never checked.
  const { checkOne } = await import("./logic/data/refresh-service.mjs");
  const empty = { byId: new Map(), shops: new Map() };
  const record = await checkOne(
    { item_id: "gone-1", shop_id: "gone", product_url: "https://shop.example/x" },
    empty,
  );
  assert.equal(record.availability, "unknown");
  assert.equal(record.stale, true);
  assert.deepEqual(record.sizes_in_stock, []);
  assert.equal(record.price, null);
  assert.equal(record.source, "person1_refresh");
});

test("a cached answer from the service is marked stale", async () => {
  // checks.py only trusts `stale: false`. OFFLINE forces the cache path, and
  // the record has to admit it.
  const { checkOne } = await import("./logic/data/refresh-service.mjs");
  const item = items.find((i) => i.shop_id === "norseprojects");
  const shop = seed.find((s) => s.id === "norseprojects");
  const catalogue = { byId: new Map([[item.id, item]]), shops: new Map([[shop.id, shop]]) };
  const previous = process.env.OFFLINE;
  process.env.OFFLINE = "1";
  try {
    const record = await checkOne({ item_id: item.id, shop_id: item.shop_id }, catalogue);
    assert.equal(record.stale, true);
    assert.equal(record.item_id, item.id);
    assert.ok(record.sizes_in_stock.length >= 0);
  } finally {
    if (previous === undefined) delete process.env.OFFLINE;
    else process.env.OFFLINE = previous;
  }
});

// --- model keys ----------------------------------------------------------
test("sharing one key between the two LLM steps is reported", async () => {
  // Two steps on one key means one quota: a single run spends it twice and
  // both come back 429. The run has to say so instead of looking healthy.
  const { modelKeyReport } = await import("./logic/run-pipeline.mjs");

  const same = modelKeyReport({ ZAI_API_KEY: "k1", GEMINI_API_KEY: "k1" });
  assert.equal(same.shared, true);

  const split = modelKeyReport({ ZAI_API_KEY: "k1", GEMINI_API_KEY: "k2" });
  assert.equal(split.shared, false);
  assert.equal(split.stylist, "GEMINI_API_KEY");

  // No stylist key at all still shares, because config.py falls back to ZAI.
  const fallback = modelKeyReport({ ZAI_API_KEY: "k1" });
  assert.equal(fallback.shared, true);
  assert.match(fallback.stylist, /fallback/);

  const none = modelKeyReport({});
  assert.equal(none.filter, null);
  assert.equal(none.shared, false);
});

// --- size systems --------------------------------------------------------
test("a stated waist also means its letter size", async () => {
  // Bottoms split almost evenly between waist and letter sizing, so a waist 32
  // brief reaches a third of the trousers on a labelling convention alone.
  const { equivalentSizes } = await import("./logic/data/normalize.js");
  assert.deepEqual(equivalentSizes("32"), ["32", "M"]);
  assert.deepEqual(equivalentSizes("M"), ["M", "32", "33"]);
  assert.deepEqual(equivalentSizes("43"), ["43"], "shoe sizes have no letter twin");
  assert.deepEqual(equivalentSizes("ONE"), ["ONE"]);
});

test("the size swap follows the cheapest garment, not the biggest pile", async () => {
  // Picking the label with the most items once traded three waist-sized
  // trousers for fourteen letter-sized ones and lost the only affordable pair.
  const { fitSizesToCatalogue } = await import("./logic/run-pipeline.mjs");
  const envelope = {
    items: [
      { category: "bottom", price: { amount: 59.98 }, sizes: [{ label: "32", in_stock: true }] },
      { category: "bottom", price: { amount: 90 }, sizes: [{ label: "M", in_stock: true }] },
      { category: "bottom", price: { amount: 95 }, sizes: [{ label: "M", in_stock: true }] },
      { category: "bottom", price: { amount: 99 }, sizes: [{ label: "M", in_stock: true }] },
    ],
  };
  const kept = fitSizesToCatalogue({ bottom: "32" }, envelope);
  assert.equal(kept.sizes.bottom, "32", "three dearer items must not outvote one cheap one");
  assert.deepEqual(kept.swaps, []);

  // With nothing reachable under the stated label, the equivalent wins.
  const swapped = fitSizesToCatalogue({ bottom: "32" }, {
    items: [{ category: "bottom", price: { amount: 70 }, sizes: [{ label: "M", in_stock: true }] }],
  });
  assert.equal(swapped.sizes.bottom, "M");
  assert.equal(swapped.swaps.length, 1);
});

// --- who the garment is for ----------------------------------------------
test("the shop's own gender marking is read, tags first", async () => {
  const { genderOf } = await import("./logic/data/normalize.js");
  assert.equal(genderOf({ tags: ["gender:Men", "Category:Hosen"] }), "men");
  assert.equal(genderOf({ tags: ["Women", "Female"] }), "women");
  assert.equal(genderOf({ tags: ["Unisex"] }), "unisex");
  assert.equal(genderOf({ tags: ["Men", "Women"] }), "unisex", "both marked means both");
  assert.equal(genderOf({ tags: [] }, "", "KnowledgeCotton Apparel - WMN"), "women");
  assert.equal(genderOf({ tags: [] }, "Brooke Pleated Skirt"), "women", "a skirt answers itself");
  assert.equal(genderOf({ tags: [] }, "Nike Wmns Air Force 1"), "women");
  assert.equal(genderOf({ tags: [] }, "Oxford Shirt"), null, "silence stays silence");
  // "men" must not be found inside "women", nor "male" inside "female".
  assert.equal(genderOf({ tags: ["Women"] }), "women");
  assert.equal(genderOf({ tags: ["Female"] }), "women");
});

test("only the explicit opposite gender is dropped", async () => {
  // A men's brief came back with a pleated skirt. But 40% of the catalogue
  // says nothing about gender, and requiring a positive match would throw it
  // all away, so unlabelled and unisex items stay.
  const { dropWrongGender } = await import("./logic/run-pipeline.mjs");
  const envelope = {
    items: [
      { item_id: "a", raw: { gender: "men" } },
      { item_id: "b", raw: { gender: "women" } },
      { item_id: "c", raw: { gender: "unisex" } },
      { item_id: "d", raw: {} },
    ],
  };
  const forMen = dropWrongGender(envelope, "men");
  assert.deepEqual(forMen.envelope.items.map((i) => i.item_id), ["a", "c", "d"]);
  assert.equal(forMen.dropped, 1);

  const forWomen = dropWrongGender(envelope, "women");
  assert.deepEqual(forWomen.envelope.items.map((i) => i.item_id), ["b", "c", "d"]);

  // No gender in the brief means no filtering.
  assert.equal(dropWrongGender(envelope, undefined).dropped, 0);
});

test("every catalogue item carries a gender field", () => {
  const allowed = new Set(["men", "women", "unisex", null]);
  const bad = items.filter((i) => !allowed.has(i.gender));
  assert.deepEqual(bad.map((i) => i.id), []);
});
