// Step 4 · Shop trust check, for information only.
//
//   node logic/trust-shops.mjs --run catalog/cache/run/<task-id>
//
// After the stylist has chosen, each shop a chosen piece comes from is checked
// with Person 2's trustcheck.mjs: imprint, policies, domain and a model's
// verdict. The result is logged and shown on the result page. It decides
// nothing: no piece is dropped, no outfit refused and no refund caused by it.
// The check reads third-party websites and asks a model, so it can be wrong
// or unavailable; a guarantee the customer pays on cannot rest on that.
//
// Every shop is checked inside its own try/catch and time limit. A shop that
// cannot be checked is "unchecked"; the run carries on. trustcheck.mjs keeps a
// verdict for 24 hours in trustCache/, so a shop seen today costs nothing.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { doTrustCheck } from "../trustcheck.mjs";
import { logger } from "../log.mjs";

const log = logger("trust");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SHOP_TIMEOUT_MS = 60_000;
// The pipeline gives every stage three minutes; this stays inside it, so the
// stage always ends with a written trust.json rather than being killed.
export const TOTAL_BUDGET_MS = 150_000;
const CONCURRENCY = 1;

/**
 * The shops behind the chosen pieces, once each, in the order they first
 * appear. A REFUND has no outfits and so no shops.
 */
export function shopsInResult(result, envelope) {
  const items = new Map((envelope?.items ?? []).map((item) => [item.item_id, item]));
  const shops = new Map((envelope?.shops ?? []).map((shop) => [shop.shop_id, shop]));
  const seen = new Map();
  for (const outfit of result?.outfits ?? []) {
    for (const piece of outfit.items ?? []) {
      const shopId = items.get(piece.item_id)?.shop_id;
      if (!shopId || seen.has(shopId)) continue;
      const shop = shops.get(shopId);
      let url = shop?.base_url ?? (shop?.domain ? `https://${shop.domain}/` : null);
      if (!url) {
        try {
          url = new URL(piece.product_url).origin;
        } catch {
          url = null;
        }
      }
      seen.set(shopId, { shop_id: shopId, name: shop?.name ?? shopId, url });
    }
  }
  return [...seen.values()];
}

/** The part of a verdict the page and the log use. Model text is kept short. */
function summarise(shop, verdict) {
  const trusted = verdict?.verdict === "a";
  return {
    ...shop,
    status: trusted ? "trusted" : "flagged",
    verdict: trusted ? "a" : "b",
    label: trusted ? "trustworthy" : "not trustworthy",
    confidence: Number.isFinite(verdict?.confidence) ? verdict.confidence : null,
    summary: String(verdict?.summary ?? "").slice(0, 400),
    redFlags: (Array.isArray(verdict?.redFlags) ? verdict.redFlags : []).slice(0, 3).map((f) => String(f).slice(0, 200)),
    checkedAt: verdict?.checkedAt ?? null,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Checks every shop, a few at a time. Never throws: a shop whose check fails
 * comes back as { status: "unchecked", error }.
 */
export async function checkShops(
  shops,
  { check = doTrustCheck, timeoutMs = SHOP_TIMEOUT_MS, budgetMs = TOTAL_BUDGET_MS, concurrency = CONCURRENCY, now = Date.now } = {},
) {
  const results = new Array(shops.length);
  const deadline = now() + budgetMs;
  let next = 0;
  async function worker() {
    while (next < shops.length) {
      const index = next++;
      const shop = shops[index];
      try {
        if (!shop.url) throw new Error("no shop address known");
        const left = deadline - now();
        if (left < 1_000) throw new Error("the time for the trust check was used up");
        const verdict = await withTimeout(Promise.resolve().then(() => check(shop.url)), Math.min(timeoutMs, left));
        results[index] = summarise(shop, verdict);
      } catch (error) {
        results[index] = { ...shop, status: "unchecked", error: String(error?.message ?? error).slice(0, 200) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, shops.length) }, worker));
  return results;
}

/** One log line per shop: what the page will show. */
export function trustLine(shop) {
  if (shop.status === "unchecked") return `trust: ${shop.name} not checked (${shop.error})`;
  const percent = shop.confidence == null ? "" : `, ${Math.round(shop.confidence * 100)}%`;
  return `trust: ${shop.name} ${shop.label}${percent}${shop.redFlags.length ? ` · ${shop.redFlags[0]}` : ""}`;
}

async function main() {
  const i = process.argv.indexOf("--run");
  const run = i === -1 ? null : process.argv[i + 1];
  if (!run) {
    console.error("Usage: node logic/trust-shops.mjs --run <run folder>");
    process.exitCode = 1;
    return;
  }
  const at = (...p) => path.resolve(ROOT, run, ...p);
  const out = at("trust.json");
  let report;
  try {
    const result = JSON.parse(await readFile(at("person3", "result.json"), "utf8"));
    const envelope = JSON.parse(await readFile(at("person3.input.json"), "utf8"));
    const shops = shopsInResult(result, envelope);
    report = { checkedAt: new Date().toISOString(), shops: await checkShops(shops) };
  } catch (error) {
    report = { checkedAt: new Date().toISOString(), shops: [], error: String(error?.message ?? error).slice(0, 200) };
  }
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  if (report.error) console.log(`trust: not run, ${report.error}`);
  else if (!report.shops.length) console.log("trust: no shops to check");
  for (const shop of report.shops) console.log(trustLine(shop));
  const counts = { trusted: 0, flagged: 0, unchecked: 0 };
  for (const shop of report.shops) counts[shop.status]++;
  log.info("shop trust checked (shown only, decides nothing)", counts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
