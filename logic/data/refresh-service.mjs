// The live re-check Person 3's final check calls, as an HTTP service.
//
//   node logic/data/refresh-service.mjs --port 8787
//   PERSON1_REFRESH_URL=http://127.0.0.1:8787/refresh LIVE_CHECK_MODE=live ...
//
// Without this, person3/app/services/checks.py takes the branch
//
//   if live_check_mode == "snapshot" or not person1_refresh_url:
//       return _snapshot(item, stale=False)
//
// and the five guarantees are decided on our cached catalogue while the record
// says `stale: false`. Stock and price would be claimed, not checked. This
// turns refetch() into the service that branch is waiting for.
//
// Contract, from checks.py: POST {"items":[{item_id, shop_id, product_url}]}
// and answer {"items":[ <section 9 record> ]}. Their client allows 20 s per
// call; refetch budgets its live attempts at 8 s and falls back to the raw
// cache, so a slow shop costs latency, never a hang.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { refetch } from "./refetch.js";
import { toPerson3Check } from "./to_person3.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_BODY_BYTES = 1_000_000;

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function load() {
  const [items, seed] = await Promise.all([
    readFile(path.join(ROOT, "catalog/cache/products.json"), "utf8"),
    readFile(path.join(ROOT, "catalog/shops.seed.json"), "utf8"),
  ]);
  return {
    byId: new Map(JSON.parse(items).map((item) => [item.id, item])),
    shops: new Map(JSON.parse(seed).map((shop) => [shop.id, shop])),
  };
}

/**
 * An item we cannot look up is reported as unknown and stale, never as in
 * stock. Guarantee 3 has to fail on a record we cannot stand behind.
 */
function unknown(request) {
  return {
    item_id: request.item_id,
    checked_at: new Date().toISOString(),
    price: null,
    availability: "unknown",
    sizes_in_stock: [],
    product_url: request.product_url ?? null,
    stale: true,
    source: "person1_refresh",
  };
}

/** One request item -> one section 9 record. */
export async function checkOne(request, catalogue) {
  const item = catalogue.byId.get(request.item_id);
  const shop = item && catalogue.shops.get(item.shop_id);
  if (!item || !shop) return unknown(request);
  const fresh = await refetch(item);
  return { ...toPerson3Check(item, fresh, shop), source: "person1_refresh" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createRefreshServer(catalogue) {
  return createServer(async (req, res) => {
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET") return send(200, { ok: true, items: catalogue.byId.size });
    if (req.method !== "POST") return send(405, { error: "POST a list of items" });
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const requested = Array.isArray(body) ? body : (body.items ?? []);
      if (!Array.isArray(requested)) return send(400, { error: "items must be an array" });
      // Sequential: each item may hit its shop, and we stay polite per shop.
      const items = [];
      for (const request of requested) items.push(await checkOne(request, catalogue));
      const live = items.filter((i) => !i.stale).length;
      console.log(`${new Date().toISOString()}  ${items.length} checked, ${live} live`);
      send(200, { items });
    } catch (error) {
      send(400, { error: error.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(flag("--port", 8787));
  const catalogue = await load();
  createRefreshServer(catalogue).listen(port, "127.0.0.1", () => {
    console.log(`refresh service on http://127.0.0.1:${port}  (${catalogue.byId.size} items)`);
    console.log(`point Person 3 at it with:`);
    console.log(`  PERSON1_REFRESH_URL=http://127.0.0.1:${port}/refresh LIVE_CHECK_MODE=live`);
  });
}
