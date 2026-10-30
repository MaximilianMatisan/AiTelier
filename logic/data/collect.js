// Fetches the public Shopify product feed of every seeded shop, caches the raw
// responses for offline replay, and writes the normalised catalogue.
//
//   node logic/data/collect.js                 all shops with products_json_ok
//   node logic/data/collect.js --shop afew     one shop
//   OFFLINE=1 node logic/data/collect.js       rebuild from catalog/cache/raw only
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeProduct } from "./normalize.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEED = path.join(ROOT, "catalog/shops.seed.json");
const RAW_DIR = path.join(ROOT, "catalog/cache/raw");
const OUT = path.join(ROOT, "catalog/cache/products.json");

export const UA = "OutfitAgent-Hackathon/0.1 (TUM Blockchain Hackathon)";
const TIMEOUT_MS = 10_000;
const PAGE_DELAY_MS = 500;
const LIMIT = 250;
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 2); // brief caps at 4; 2 is plenty for the demo
const SHOP_CONCURRENCY = 4; // across shops; still one request at a time per shop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with a timeout and our User-Agent. Returns parsed JSON, or throws. */
export async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON for ${url}`);
  }
}

async function fetchShop(shop) {
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const url = `https://${shop.domain}/products.json?limit=${LIMIT}&page=${page}`;
    const body = await fetchJson(url);
    const batch = body.products ?? [];
    products.push(...batch);
    if (batch.length < LIMIT) break; // last page
  }
  return products;
}

const rawPath = (shopId) => path.join(RAW_DIR, `${shopId}.json`);

async function loadRaw(shop) {
  const raw = JSON.parse(await readFile(rawPath(shop.id), "utf8"));
  return { products: raw.products ?? [], fetchedAt: raw.fetched_at };
}

async function saveRaw(shop, products, fetchedAt) {
  await mkdir(RAW_DIR, { recursive: true });
  await writeFile(
    rawPath(shop.id),
    JSON.stringify({ shop_id: shop.id, domain: shop.domain, fetched_at: fetchedAt, products }, null, 0)
  );
}

async function collectShop(shop, offline) {
  const fetchedAt = new Date().toISOString();
  let products, source;
  if (offline) {
    ({ products } = await loadRaw(shop));
    source = "cache";
  } else {
    products = await fetchShop(shop);
    await saveRaw(shop, products, fetchedAt);
    source = "live";
  }

  const items = [];
  for (const p of products) {
    const item = normalizeProduct(p, shop, fetchedAt);
    if (item) items.push(item);
  }
  const byCategory = {};
  for (const i of items) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;

  return { shop, source, seen: products.length, kept: items.length, byCategory, items };
}

async function main() {
  const only = process.argv.includes("--shop")
    ? process.argv[process.argv.indexOf("--shop") + 1]
    : null;
  const offline = process.env.OFFLINE === "1";

  const seed = JSON.parse(await readFile(SEED, "utf8"));
  const shops = seed.filter((s) => s.products_json_ok && (!only || s.id === only));
  if (!shops.length) throw new Error(only ? `no shop with id ${only}` : "no usable shops in seed");

  const results = [];
  const queue = [...shops];
  await Promise.all(
    Array.from({ length: Math.min(SHOP_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const shop = queue.shift();
        try {
          results.push(await collectShop(shop, offline));
        } catch (err) {
          results.push({ shop, error: err.message, seen: 0, kept: 0, byCategory: {}, items: [] });
        }
      }
    })
  );

  results.sort((a, b) => a.shop.id.localeCompare(b.shop.id));
  const items = results.flatMap((r) => r.items);
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(items, null, 1));

  console.log(`mode: ${offline ? "OFFLINE (raw cache)" : "live"}   max pages/shop: ${MAX_PAGES}\n`);
  for (const r of results) {
    const cats = Object.entries(r.byCategory).sort().map(([c, n]) => `${c}:${n}`).join(" ");
    console.log(
      `${(r.error ? "FAIL" : "ok  ").padEnd(5)}${r.shop.id.padEnd(18)}` +
        `seen ${String(r.seen).padStart(4)}  kept ${String(r.kept).padStart(3)}  ` +
        `skipped ${String(r.seen - r.kept).padStart(4)}  ${r.error ?? cats}`
    );
  }
  const totals = {};
  for (const i of items) totals[i.category] = (totals[i.category] ?? 0) + 1;
  console.log(`\n${items.length} items -> ${path.relative(ROOT, OUT)}`);
  console.log(`by category: ${Object.entries(totals).sort().map(([c, n]) => `${c}:${n}`).join("  ")}`);
  const themes = {};
  for (const i of items) for (const t of i.themes) themes[t] = (themes[t] ?? 0) + 1;
  console.log(`by theme:    ${Object.entries(themes).sort().map(([t, n]) => `${t}:${n}`).join("  ")}`);
  console.log(`shops with items: ${new Set(items.map((i) => i.shop_id)).size}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
