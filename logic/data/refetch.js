// Fresh state for one item, for the final check (guarantees 2 and 4).
// Live first, raw cache as the fallback, so the demo survives a dead network.
//
//   node logic/data/refetch.js <item-id>
//   OFFLINE=1 node logic/data/refetch.js <item-id>
//   node logic/data/refetch.js <item-id> --person3   contract section 9 shape
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeSize, sizeIndexOf } from "./normalize.js";
import { fetchJson } from "./collect.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Total time the live attempts may take before we fall back to the cache.
 * A shop that accepts the connection and then stalls costs a full timeout per
 * attempt, and refetch makes up to three. Unbudgeted that is ~30 s for one
 * item, and Person 3's contract allows 90 s for the whole request.
 * A dead network is not the problem - DNS fails in milliseconds.
 */
const LIVE_BUDGET_MS = 8000;

let shopsById = null;
async function shopFor(shopId) {
  shopsById ??= Object.fromEntries(
    JSON.parse(await readFile(path.join(ROOT, "catalog/shops.seed.json"), "utf8")).map((s) => [s.id, s])
  );
  const shop = shopsById[shopId];
  if (!shop) throw new Error(`unknown shop ${shopId}`);
  return shop;
}

/** Collapse variants into { stock, price } for one product shape. `toEur` differs per endpoint. */
function readVariants(options, variants, toEur) {
  const idx = sizeIndexOf(options);
  const stock = {};
  const prices = [];
  for (const v of variants ?? []) {
    const size = idx === -1 ? "ONE" : normalizeSize(v[`option${idx + 1}`] ?? v.options?.[idx]);
    stock[size] ??= 0;
    if (!v.available) continue;
    stock[size] = 1;
    const price = toEur(v.price);
    if (Number.isFinite(price)) prices.push(price);
  }
  return { stock, price_eur: prices.length ? Math.min(...prices) : null };
}

// /products/{handle}.js reports prices in cents; /products.json reports decimal strings.
const fromCents = (p) => Number(p) / 100;
const fromDecimal = (p) => Number(p);

// Both take the deadline, not a duration: fromProductsJson makes up to two
// requests, and a per-request timeout would let them overrun the budget together.
async function fromStorefront(item, shop, deadline) {
  const url = `https://${shop.domain}/products/${item.source.handle}.js`;
  const p = await fetchJson(url, deadline - Date.now());
  return { ...readVariants(p.options, p.variants, fromCents), url_ok: true };
}

async function fromProductsJson(item, shop, deadline) {
  for (let page = 1; page <= 2; page++) {
    const left = deadline - Date.now();
    if (left < 500) break;
    const body = await fetchJson(`https://${shop.domain}/products.json?limit=250&page=${page}`, left);
    const list = body.products ?? [];
    const p = list.find((x) => x.handle === item.source.handle);
    if (p) return { ...readVariants(p.options, p.variants, fromDecimal), url_ok: true };
    if (list.length < 250) break;
  }
  throw new Error(`handle ${item.source.handle} not found in /products.json`);
}

// `url_ok` here only means the product record was found. A cached read cannot
// prove the page still answers, so guarantee 4 needs `source === "live"` too.
async function fromCache(item) {
  const raw = JSON.parse(await readFile(path.join(ROOT, `catalog/cache/raw/${item.shop_id}.json`), "utf8"));
  const p = (raw.products ?? []).find((x) => x.handle === item.source.handle);
  if (!p) throw new Error(`handle ${item.source.handle} not in raw cache`);
  return { ...readVariants(p.options, p.variants, fromDecimal), url_ok: true };
}

/**
 * Fresh availability and price for one catalogue item.
 * `url_ok` false means the product no longer resolves at all - guarantee 4 must fail then.
 */
export async function refetch(item) {
  const shop = await shopFor(item.shop_id);
  const base = { id: item.id, fetched_at: new Date().toISOString() };

  if (process.env.OFFLINE !== "1") {
    const deadline = Date.now() + LIVE_BUDGET_MS;
    for (const attempt of [fromStorefront, fromProductsJson]) {
      if (deadline - Date.now() < 500) break; // out of budget, the cache beats stalling
      try {
        return { ...base, ...(await attempt(item, shop, deadline)), source: "live" };
      } catch { /* fall through to the next strategy */ }
    }
  }
  try {
    return { ...base, ...(await fromCache(item)), source: "cache" };
  } catch {
    return { ...base, url_ok: false, price_eur: null, stock: {}, source: "cache" };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  if (!id) throw new Error("usage: node logic/data/refetch.js <item-id>");
  const items = JSON.parse(await readFile(path.join(ROOT, "catalog/cache/products.json"), "utf8"));
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no item ${id} in catalog/cache/products.json`);
  const fresh = await refetch(item);
  if (process.argv.includes("--person3")) {
    const { toPerson3Check } = await import("./to_person3.js");
    console.log(JSON.stringify(toPerson3Check(item, fresh, await shopFor(item.shop_id)), null, 2));
  } else {
    console.log(JSON.stringify(fresh, null, 2));
  }
}
