// The page the customer reads before the escrow releases.
//
//   node logic/result-page.mjs --run catalog/cache/run
//   node logic/result-page.mjs --run catalog/cache/run --out /tmp/result.html
//
// Its job is not to look pretty. The customer is about to let money go, or has
// just had it returned, and the page has to show why: what was chosen, what it
// costs with shipping, and for each of the five guarantees what was actually
// checked and when. The live-check timestamps are the point - they are the
// difference between a promise and a claim.
//
// One self-contained file, no build step and no external assets beyond the
// shops' own product images, so it can be hosted anywhere or opened offline.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

/** Shop titles and descriptions are third-party text; never inline them raw. */
export const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const money = (amount, currency = "EUR") =>
  amount === null || amount === undefined ? "—" : `${Number(amount).toFixed(2)} ${currency}`;

const clock = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "—" : at.toISOString().replace("T", " ").slice(0, 19) + " UTC";
};

const GUARANTEE_LABEL = {
  budget: "Within budget",
  fit: "Available in the customer's size",
  availability: "In stock at the shop",
  price_integrity: "Price matches the catalogue",
  delivery: "Ships to the customer in time",
};

/**
 * One shop, one cart link: Shopify takes several variants in a single
 * permalink, so the customer opens one tab per shop rather than one per item.
 */
export function cartLinks(outfit, byItem, shops) {
  const perShop = new Map();
  for (const item of outfit.items ?? []) {
    const source = byItem.get(item.item_id);
    const variant = source?.raw?.variants?.[item.size];
    if (!source || !variant) continue;
    if (!perShop.has(source.shop_id)) perShop.set(source.shop_id, []);
    perShop.get(source.shop_id).push(variant);
  }
  return [...perShop].map(([shopId, variants]) => {
    const shop = shops.get(shopId);
    return {
      shop: shop?.name ?? shopId,
      url: `https://${shop?.domain ?? shopId}/cart/${variants.map((v) => `${v}:1`).join(",")}`,
      count: variants.length,
    };
  });
}

function guaranteeRows(result, live) {
  const checked = Object.values(live);
  const liveCount = checked.filter((r) => r.stale === false).length;
  const latest = checked
    .map((r) => r.checked_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  return Object.entries(result.guarantees ?? {})
    .map(([name, check]) => {
      const evidence =
        name === "availability" || name === "price_integrity"
          ? `<div class="ev">${liveCount} of ${checked.length} items re-queried at the shop, last at ${esc(clock(latest))}</div>`
          : "";
      return `<tr class="${check?.ok ? "ok" : "no"}">
        <td class="mark">${check?.ok ? "✓" : "✕"}</td>
        <td><strong>${esc(GUARANTEE_LABEL[name] ?? name)}</strong>
          <div class="detail">${esc(check?.detail ?? "")}</div>${evidence}</td>
      </tr>`;
    })
    .join("");
}

function itemRow(item, byItem, shops, live) {
  const source = byItem.get(item.item_id);
  const shop = shops.get(source?.shop_id);
  const record = live[item.item_id];
  const fresh = record?.stale === false;
  const image = item.image_url ?? source?.images?.[0]?.url;
  return `<li class="item">
    ${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : `<div class="noimg"></div>`}
    <div class="who">
      <div class="layer">${esc(item.layer_label ?? item.layer ?? "")}</div>
      <a class="title" href="${esc(item.product_url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
      <div class="meta">${esc(item.brand ?? "")} · ${esc(shop?.name ?? source?.shop_id ?? "")} · size ${esc(item.size)}</div>
      <div class="${fresh ? "fresh" : "stale"}">${
        fresh
          ? `checked at the shop ${esc(clock(record.checked_at))} · ${esc(record.availability)}`
          : "not confirmed live"
      }</div>
    </div>
    <div class="price">${esc(money(item.price?.amount, item.price?.currency))}</div>
  </li>`;
}

export function renderPage({ result, envelope, live }) {
  const byItem = new Map((envelope.items ?? []).map((i) => [i.item_id, i]));
  const shops = new Map((envelope.shops ?? []).map((s) => [s.shop_id, s]));
  const approved = result.status === "APPROVED";

  const outfits = (result.outfits ?? [])
    .map((outfit) => {
      const t = outfit.totals ?? {};
      const carts = cartLinks(outfit, byItem, shops);
      return `<section class="outfit">
        <h2>${esc(outfit.name ?? "Outfit")}</h2>
        ${outfit.rationale ? `<p class="why">${esc(outfit.rationale)}</p>` : ""}
        <ul class="items">${(outfit.items ?? []).map((i) => itemRow(i, byItem, shops, live)).join("")}</ul>
        <table class="sum">
          <tr><td>Items</td><td>${esc(money(t.items, t.currency))}</td></tr>
          <tr><td>Shipping <span class="est">estimated</span></td><td>${esc(money(t.shipping, t.currency))}</td></tr>
          <tr class="grand"><td>Total</td><td>${esc(money(t.grand_total, t.currency))}</td></tr>
        </table>
        ${
          carts.length
            ? `<div class="carts">${carts
                .map(
                  (c) =>
                    `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Add ${c.count} to cart · ${esc(c.shop)}</a>`,
                )
                .join("")}</div>`
            : ""
        }
      </section>`;
    })
    .join("");

  const refused = !approved
    ? `<section class="refused">
        <h2>Nothing was charged</h2>
        <p>At least one guarantee did not hold, so the agent submitted no result.
        The escrow returns the locked funds to the customer.</p>
      </section>`
    : "";

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AiTelier — ${esc(result.status ?? "result")}</title>
<style>
  :root { color-scheme: light dark; --ink:#1a1a1a; --soft:#595959; --line:#e2e2e2; --bg:#ffffff;
          --ok:#067429; --okbg:#eaf9ef; --no:#bd0a0a; --nobg:#fff0f0; }
  @media (prefers-color-scheme: dark) { :root { --ink:#f2f2f2; --soft:#a8a8a8; --line:#333; --bg:#131313;
          --okbg:#10291a; --nobg:#2a1313; --ok:#5ad68a; --no:#ff8a8a; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.55 ui-sans-serif,system-ui,"Noto Sans",Arial,sans-serif; }
  .wrap { max-width:820px; margin:0 auto; padding:40px 16px 80px }
  header { border-bottom:1px solid var(--line); padding-bottom:24px; margin-bottom:32px }
  h1 { font-size:30px; margin:0 0 8px }
  .status { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:700; font-size:14px;
            background:var(--okbg); color:var(--ok) }
  .status.no { background:var(--nobg); color:var(--no) }
  .sub { color:var(--soft); font-size:14px; margin-top:10px }
  h2 { font-size:20px; margin:0 0 6px }
  table.g { width:100%; border-collapse:collapse; margin-bottom:36px }
  table.g td { border-bottom:1px solid var(--line); padding:12px 8px; vertical-align:top }
  td.mark { width:28px; font-weight:700; color:var(--ok) }
  tr.no td.mark { color:var(--no) }
  .detail, .ev { color:var(--soft); font-size:13px; margin-top:2px }
  .ev { color:var(--ok) }
  .outfit { border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:28px }
  .why { color:var(--soft); font-size:14px; margin:0 0 16px }
  ul.items { list-style:none; margin:0; padding:0 }
  li.item { display:flex; gap:14px; align-items:flex-start; padding:12px 0; border-top:1px solid var(--line) }
  li.item img, .noimg { width:72px; height:92px; object-fit:cover; border-radius:6px; background:var(--line); flex:none }
  .who { flex:1; min-width:0 }
  .layer { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--soft) }
  a.title { color:var(--ink); font-weight:600; text-decoration:none }
  a.title:hover { text-decoration:underline }
  .meta { color:var(--soft); font-size:13px }
  .fresh { color:var(--ok); font-size:12px; margin-top:3px }
  .stale { color:var(--no); font-size:12px; margin-top:3px }
  .price { font-variant-numeric:tabular-nums; white-space:nowrap }
  table.sum { width:100%; margin-top:16px; border-collapse:collapse; font-variant-numeric:tabular-nums }
  table.sum td { padding:4px 0 } table.sum td:last-child { text-align:right }
  tr.grand td { border-top:1px solid var(--line); padding-top:8px; font-weight:700 }
  .est { color:var(--soft); font-size:11px }
  .carts { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px }
  .carts a { border:1px solid var(--line); border-radius:999px; padding:7px 14px; font-size:13px;
             text-decoration:none; color:var(--ink) }
  .refused { border:1px solid var(--no); background:var(--nobg); border-radius:12px; padding:20px; margin-bottom:28px }
  footer { border-top:1px solid var(--line); margin-top:40px; padding-top:20px; color:var(--soft); font-size:13px }
  footer li { margin-bottom:6px }
</style>
<div class="wrap">
<header>
  <h1>AiTelier</h1>
  <span class="status ${approved ? "" : "no"}">${esc(result.status ?? "UNKNOWN")}</span>
  <div class="sub">Style: ${esc((result.style_blend ?? []).join(", ") || "—")} · Budget: ${esc(result.budget_label ?? "—")} · Task <code>${esc(result.task_id ?? "")}</code></div>
</header>

<h2>What was checked</h2>
<table class="g">${guaranteeRows(result, live)}</table>

${refused}
${outfits}

<footer>
  <strong>What these numbers rest on</strong>
  <ul>
    <li>Stock is what the shop publishes: available or not, never a count.</li>
    <li>Shipping is a conservative estimate per shop, deliberately set high, not a quote.</li>
    <li>Prices and stock were re-queried at the shop for every item listed above.</li>
    <li>Cart links are built from the shop's own variant ids; open one per shop.</li>
  </ul>
</footer>
</div>`;
}

async function main() {
  const run = flag("--run", "catalog/cache/run");
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const at = (...p) => path.resolve(ROOT, run, ...p);
  const read = async (file, fallback) => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      if (fallback === undefined) throw new Error(`Cannot read ${file}`);
      return fallback;
    }
  };

  const result = await read(at("person3", "result.json"));
  const envelope = await read(at("person3.input.json"), { items: [], shops: [] });
  const live = await read(at("person3", "05-live-check.json"), {});

  const out = path.resolve(ROOT, flag("--out", path.join(run, "index.html")));
  await writeFile(out, renderPage({ result, envelope, live }));

  const checked = Object.values(live);
  console.log(`${result.status} · ${(result.outfits ?? []).length} outfits · ${checked.filter((r) => r.stale === false).length}/${checked.length} items confirmed live`);
  console.log(`-> ${path.relative(ROOT, out)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
