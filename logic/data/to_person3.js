// Emits our half of the Person 3 input envelope (PERSON3_INPUT_CONTRACT.md v1.0).
//
// The agreed Frame 16 schema in catalog/cache/products.json stays untouched -
// Person 2 consumes that. This only renames and reshapes on the way out.
//
//   node logic/data/to_person3.js                      whole cache (warns over 100 items)
//   node logic/data/to_person3.js --limit 100          sample 100, spread across shops
//   node logic/data/to_person3.js --in filtered.json   Person 2's shortlist
//   node logic/data/to_person3.js --out envelope.json  somewhere else
//   node logic/data/to_person3.js --no-descriptions    skip reading the raw cache
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACT_VERSION = "1.0";
const MAX_ITEMS = 100; // contract section 11
const MAX_SHOPS = 30; // contract section 11
const MAX_DESCRIPTION = 2000; // contract section 6.2

// Our category -> their slot (section 6.1). `outer` is NOT one of their slots:
// left as-is it normalises to `other` and stops satisfying a required slot.
const SLOT = { top: "top", bottom: "bottom", shoes: "shoes", outer: "outerwear" };
const STYLE_TAG = { old_money: "old-money", streetwear: "streetwear", casual: "casual" };

/** body_html -> plain text, as section 6.2 expects it to arrive. */
function plainText(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

/** handle -> description, read from the raw cache so products.json keeps its agreed shape. */
async function descriptionsFor(shopId) {
  try {
    const raw = JSON.parse(await readFile(path.join(ROOT, `catalog/cache/raw/${shopId}.json`), "utf8"));
    return new Map((raw.products ?? []).map((p) => [p.handle, plainText(p.body_html)]));
  } catch {
    return new Map();
  }
}

export function toPerson3Shop(shop) {
  return {
    shop_id: shop.id,
    name: shop.name,
    domain: shop.domain,
    base_url: `https://${shop.domain}/`,
    // No `guarantee`: that is Person 2's trust check (catalog/trust.json), not ours.
    // Absent means GUARANTEE_ASSUMED in their contract - see catalog/README.md.
    // Hand-entered estimates (`shipping.estimated` in the seed), because the
    // product feed carries no shipping at all and /cart/shipping_rates.json
    // needs a real cart. Both are deliberately conservative: the amount is set
    // high so G1 cannot break on an underestimate, and `regions` is narrowed to
    // the demo's destination so G5 fails closed rather than passing wrongly.
    shipping: {
      default_amount: shop.shipping.amount_eur,
      currency: shop.currency,
      regions: shop.shipping.ships_to,
      min_days: shop.default_delivery_days,
      max_days: shop.default_delivery_days,
      estimated: shop.shipping.estimated,
    },
  };
}

export function toPerson3Item(item, description = null) {
  const sizes = Object.entries(item.stock).map(([label, inStock]) => ({
    label,
    in_stock: inStock === 1,
  }));

  return {
    item_id: item.id,
    shop_id: item.shop_id,
    title: item.name,
    brand: item.vendor,
    category: SLOT[item.category] ?? "other",
    description,
    style: { style_tags: item.themes.map((t) => STYLE_TAG[t] ?? t) },
    size_system: "EU",
    sizes,
    price: { amount: item.price_eur, currency: "EUR" },
    availability: sizes.some((s) => s.in_stock) ? "in_stock" : "sold_out",
    images: item.image ? [{ url: item.image, role: "front" }] : [],
    product_url: item.url,
    collected_at: item.source.fetched_at,
    source: { collector: "person1", method: "shop_json" },
    // Preserved, never sent to the LLM (section 7). `variants` is how the cart
    // permalink https://{domain}/cart/{variant_id}:{qty} gets built.
    raw: {
      variants: item.variants,
      stock_kind: item.stock_kind,
      seasons: item.seasons,
      delivery_days: item.delivery_days,
    },
  };
}

/**
 * refetch() output -> the final-check record of contract section 9.
 *
 * `stale` is true whenever the answer did not come from the live shop. Their
 * section 9 fails strict guarantees on stale records, which is the honest
 * outcome: an offline demo cannot prove live stock. See catalog/README.md.
 */
export function toPerson3Check(item, fresh, shop) {
  const sizesInStock = Object.entries(fresh.stock ?? {})
    .filter(([, inStock]) => inStock === 1)
    .map(([label]) => label);

  return {
    item_id: item.id,
    checked_at: fresh.fetched_at,
    price: fresh.price_eur === null ? null : { amount: fresh.price_eur, currency: "EUR" },
    availability: !fresh.url_ok ? "unknown" : sizesInStock.length ? "in_stock" : "sold_out",
    sizes_in_stock: sizesInStock,
    // Conservative estimates, as in toPerson3Shop.
    shipping: {
      amount: shop.shipping.amount_eur,
      currency: shop.currency,
      regions: shop.shipping.ships_to,
      days: shop.default_delivery_days,
      estimated: shop.shipping.estimated,
    },
    product_url: item.url,
    stale: fresh.source !== "live" || !fresh.url_ok,
    source: "person1_refresh",
  };
}

/** Our half of the envelope. Person 3 adds task_id, customer and options. */
export async function toPerson3(items, seed, { withDescriptions = true } = {}) {
  const shopsById = Object.fromEntries(seed.map((s) => [s.id, s]));
  const usedShopIds = [...new Set(items.map((i) => i.shop_id))];

  const descriptions = new Map();
  if (withDescriptions) {
    for (const shopId of usedShopIds) descriptions.set(shopId, await descriptionsFor(shopId));
  }

  return {
    contract_version: CONTRACT_VERSION,
    currency: "EUR",
    shops: usedShopIds.map((id) => toPerson3Shop(shopsById[id])),
    items: items.map((i) =>
      toPerson3Item(i, descriptions.get(i.shop_id)?.get(i.source.handle) ?? null)
    ),
  };
}

/**
 * Take `n` items round-robin across shops. A head slice would return one shop
 * only, which is useless as a smoke-test sample. This is sampling for the
 * contract's 100-item cap, not candidate filtering - that is Person 2's step.
 */
export function sampleAcrossShops(items, n, maxShops = MAX_SHOPS) {
  const byShop = new Map();
  for (const i of items) {
    if (!byShop.has(i.shop_id)) byShop.set(i.shop_id, []);
    byShop.get(i.shop_id).push(i);
  }
  // Section 11 caps shops per request too, not just items.
  const lists = [...byShop.values()].slice(0, maxShops);
  const out = [];
  for (let round = 0; out.length < n; round++) {
    let added = false;
    for (const list of lists) {
      if (round >= list.length) continue;
      out.push(list[round]);
      added = true;
      if (out.length === n) break;
    }
    if (!added) break; // every shop exhausted
  }
  return out;
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inPath = flag("--in") ?? "catalog/cache/products.json";
  const outPath = flag("--out") ?? "catalog/cache/person3.input.json";
  const limit = Number(flag("--limit") ?? 0);

  const seed = JSON.parse(await readFile(path.join(ROOT, "catalog/shops.seed.json"), "utf8"));
  let items = JSON.parse(await readFile(path.resolve(ROOT, inPath), "utf8"));
  if (limit > 0) items = sampleAcrossShops(items, limit);

  const envelope = await toPerson3(items, seed, {
    withDescriptions: !process.argv.includes("--no-descriptions"),
  });
  await writeFile(path.resolve(ROOT, outPath), JSON.stringify(envelope, null, 1));

  const withDesc = envelope.items.filter((i) => i.description).length;
  const withImg = envelope.items.filter((i) => i.images.length).length;
  const slots = {};
  for (const i of envelope.items) slots[i.category] = (slots[i.category] ?? 0) + 1;

  console.log(`${envelope.items.length} items, ${envelope.shops.length} shops -> ${outPath}`);
  console.log(`slots:        ${Object.entries(slots).sort().map(([s, n]) => `${s}:${n}`).join("  ")}`);
  console.log(`description:  ${withDesc}/${envelope.items.length}`);
  console.log(`image:        ${withImg}/${envelope.items.length}`);
  if (envelope.shops.length > MAX_SHOPS) {
    console.log(
      `\nWARNING: ${envelope.shops.length} shops, the contract caps a request at ${MAX_SHOPS} (section 11).` +
        `\n  Person 2's shortlist has to stay within ${MAX_SHOPS} shops.`
    );
  }
  if (envelope.items.length > MAX_ITEMS) {
    console.log(
      `\nWARNING: the contract caps a request at ${MAX_ITEMS} items (section 11).` +
        `\n  Person 2 filters down to the shortlist; pass --in <shortlist.json> or --limit ${MAX_ITEMS}.`
    );
  }
  if (!envelope.shops.every((s) => s.guarantee)) {
    console.log(
      `NOTE: no shop carries a guarantee (catalog/trust.json is Person 2's).` +
        `\n  Their contract treats an absent guarantee as guaranteed, with a GUARANTEE_ASSUMED warning.`
    );
  }
}
