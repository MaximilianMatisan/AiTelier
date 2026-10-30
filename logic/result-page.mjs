// The page the customer reads before the escrow releases.
//
//   node logic/result-page.mjs --run catalog/cache/run
//   node logic/result-page.mjs --run catalog/cache/run --out /tmp/result.html
//
// The customer is about to let money go, or has just had it returned, and the
// page has to show why: what was chosen, what it costs with shipping, and for
// each of the five guarantees what was actually checked and when. The
// live-check timestamps are the point - they are the difference between a
// promise and a claim. Each outfit is one set in a gallery: its pieces hang
// off one line like Person 3's look board, and the facts and links sit below.
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
      return `<li class="${check?.ok ? "ok" : "no"}">
        <span class="mark">${check?.ok ? "✓" : "✕"}</span>
        <strong>${esc(GUARANTEE_LABEL[name] ?? name)}</strong>
        <div class="detail">${esc(check?.detail ?? "")}</div>${evidence}
      </li>`;
    })
    .join("");
}

/** One garment on the set's spine: the picture, what it is, what it costs. */
function itemCard(item, index) {
  const image = item.image_url;
  return `<li class="piece ${index % 2 ? "right" : "left"}">
      <a class="card" href="${esc(item.product_url)}" target="_blank" rel="noopener noreferrer">
        <div class="pic">${image ? `<img src="${esc(image)}" alt="${esc(item.title)}" loading="lazy">` : ""}</div>
        <div class="cap">
          <div class="tag">${esc(item.layer_label ?? item.layer ?? "")} · ${esc(item.brand ?? "")}</div>
          <div class="name"><span>${esc(item.title)}</span><span class="amt">${esc(money(item.price?.amount, item.price?.currency))}</span></div>
        </div>
      </a>
    </li>`;
}

/** The facts under a set: shop, size and the live check for every piece. */
function itemDetail(item, byItem, shops, live) {
  const source = byItem.get(item.item_id);
  const shop = shops.get(source?.shop_id);
  const record = live[item.item_id];
  const fresh = record?.stale === false;
  return `<li>
      <div class="row">
        <span class="layer">${esc(item.layer_label ?? item.layer ?? "")}</span>
        <a href="${esc(item.product_url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
        <span class="amt">${esc(money(item.price?.amount, item.price?.currency))}</span>
      </div>
      <div class="meta">${esc(item.brand ?? "")} · ${esc(shop?.name ?? source?.shop_id ?? "")} · size ${esc(item.size)}
        · <span class="${fresh ? "fresh" : "stale"}">${
          fresh
            ? `checked at the shop ${esc(clock(record.checked_at))} · ${esc(record.availability)}`
            : "not confirmed live"
        }</span></div>
    </li>`;
}

export function renderPage({ result, envelope, live }) {
  const byItem = new Map((envelope.items ?? []).map((i) => [i.item_id, i]));
  const shops = new Map((envelope.shops ?? []).map((s) => [s.shop_id, s]));
  const approved = result.status === "APPROVED";
  const checks = Object.values(result.guarantees ?? {});
  const held = checks.filter((check) => check?.ok).length;
  const looks = result.outfits ?? [];
  // Item cards fall back to the catalogue's first image when Person 3 gave none.
  const withImage = (item) => ({ ...item, image_url: item.image_url ?? byItem.get(item.item_id)?.images?.[0]?.url });

  const sets = looks
    .map((outfit, n) => {
      const t = outfit.totals ?? {};
      const items = (outfit.items ?? []).map(withImage);
      const carts = cartLinks(outfit, byItem, shops);
      const id = `set-${n + 1}`;
      return `<section class="set" id="${id}">
        <header class="set-head">
          <div class="count">Set ${n + 1} of ${looks.length}</div>
          <h2>${esc(outfit.name ?? "Outfit")}</h2>
          <div class="set-sub">${esc((outfit.style_blend ?? result.style_blend ?? []).join(", "))}</div>
          <div class="set-sub">${items.length} layers · ${esc(money(t.grand_total, t.currency))}</div>
        </header>
        <ol class="spine">${items.map(itemCard).join("")}</ol>
        <div class="below">
          ${outfit.rationale ? `<p class="why">${esc(outfit.rationale)}</p>` : ""}
          <ul class="details">${items.map((i) => itemDetail(i, byItem, shops, live)).join("")}</ul>
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
        </div>
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

  const index =
    looks.length > 1
      ? `<nav class="index">${looks.map((_, n) => `<a href="#set-${n + 1}">Set ${n + 1}</a>`).join("")}</nav>`
      : "";

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AiTelier — ${esc(result.status ?? "result")}</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f0e8; --card:#ffffff; --cap:#f3ede4; --ink:#2b2622; --soft:#7a6f65;
          --line:#c8bcae; --dot:#8a7e72; --ok:#3f6b45; --no:#a2392f; --nobg:#f6e3df; }
  @media (prefers-color-scheme: dark) { :root { --bg:#191613; --card:#23201c; --cap:#2b2723; --ink:#efe8de;
          --soft:#a99d90; --line:#4a423a; --dot:#8a7e72; --ok:#8fbf8f; --no:#e48b80; --nobg:#33201d; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.55 "Helvetica Neue",ui-sans-serif,system-ui,Arial,sans-serif; font-weight:300 }
  a { color:inherit }
  .wrap { max-width:1000px; margin:0 auto; padding:48px 16px 96px }
  .top { margin-bottom:56px }
  .brand { font-size:13px; letter-spacing:.24em; text-transform:uppercase; color:var(--soft) }
  .status { margin-left:10px; font-size:11px; letter-spacing:.14em; padding:3px 10px; border:1px solid var(--ok);
            border-radius:999px; color:var(--ok); vertical-align:2px }
  .status.no { border-color:var(--no); color:var(--no) }
  .sub { color:var(--soft); font-size:13px; margin-top:10px }
  .sub code { font-size:12px }
  .index { display:flex; flex-wrap:wrap; gap:20px; margin-top:22px; font-size:13px; letter-spacing:.06em }
  .index a { text-decoration:none; color:var(--soft); border-bottom:1px solid var(--line); padding-bottom:2px }
  .index a:hover { color:var(--ink) }
  h2 { font-size:clamp(28px,5vw,40px); font-weight:400; letter-spacing:-.01em; line-height:1.15; margin:4px 0 6px }
  h3 { font-size:13px; font-weight:400; letter-spacing:.14em; text-transform:uppercase; color:var(--soft); margin:0 0 14px }
  .checked { margin:0 0 64px; border-top:1px solid var(--line); border-bottom:1px solid var(--line) }
  .checked summary { display:flex; gap:16px; align-items:baseline; padding:14px 0; cursor:pointer; list-style:none; font-size:13px }
  .checked summary::-webkit-details-marker { display:none }
  .checked summary::after { content:"+"; margin-left:auto; color:var(--soft) }
  .checked[open] summary::after { content:"−" }
  .checked h3 { margin:0 }
  .checks { list-style:none; margin:0; padding:0; border-top:1px solid var(--line) }
  .checks li:last-child { border-bottom:0 }
  .checks li { display:grid; grid-template-columns:22px 1fr; gap:4px 10px; padding:12px 0; border-bottom:1px solid var(--line) }
  .checks .mark { color:var(--ok) } .checks li.no .mark { color:var(--no) }
  .checks strong { font-weight:500 }
  .detail, .ev { grid-column:2; color:var(--soft); font-size:13px }
  .ev { color:var(--ok) }
  .set { padding:24px 0 88px; scroll-margin-top:16px }
  .set + .set { border-top:1px solid var(--line); padding-top:72px }
  .count { font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:var(--soft) }
  .set-sub { color:var(--soft); font-size:clamp(16px,2.2vw,20px) }
  /* The spine: one vertical line, each piece hangs off it, left and right in turn. */
  ol.spine { position:relative; list-style:none; margin:36px 0 0; padding:0 }
  ol.spine::before { content:""; position:absolute; top:0; bottom:0; left:50%; width:2px; margin-left:-1px; background:var(--line) }
  .piece { position:relative; width:calc(50% - 56px); margin-bottom:-40px }
  .piece:last-child { margin-bottom:0 }
  .piece.right { margin-left:auto }
  .piece::before { content:""; position:absolute; top:50%; height:2px; width:56px; background:var(--line) }
  .piece.left::before { right:-56px } .piece.right::before { left:-56px }
  .piece::after { content:""; position:absolute; top:50%; width:13px; height:13px; margin-top:-5.5px; border-radius:50%; background:var(--dot) }
  .piece.left::after { right:-62.5px } .piece.right::after { left:-62.5px }
  .card { display:block; text-decoration:none; background:var(--card); border:2px solid var(--line); border-radius:12px;
          overflow:hidden; transition:transform .2s ease, border-color .2s ease }
  .card:hover { transform:translateY(-2px); border-color:var(--dot) }
  .pic { background:#fff; height:240px; display:flex; align-items:center; justify-content:center; padding:8px }
  .pic img { max-width:100%; max-height:100%; object-fit:contain }
  .cap { background:var(--cap); padding:10px 14px 9px }
  .tag { font-size:13px; letter-spacing:.06em; text-transform:uppercase; font-weight:400 }
  .name { display:flex; gap:10px; justify-content:space-between; font-size:12px; color:var(--soft) }
  .name span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .amt { font-variant-numeric:tabular-nums; white-space:nowrap }
  .below { max-width:640px; margin:72px auto 0 }
  .why { margin:0 0 28px; font-size:15px }
  ul.details { list-style:none; margin:0; padding:0; border-top:1px solid var(--line) }
  ul.details li { padding:12px 0; border-bottom:1px solid var(--line) }
  .row { display:flex; gap:12px; align-items:baseline }
  .row a { flex:1; min-width:0; text-decoration:none; font-weight:400 }
  .row a:hover { text-decoration:underline }
  .layer { width:64px; flex:none; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--soft) }
  .meta { color:var(--soft); font-size:12px; margin-left:76px }
  .fresh { color:var(--ok) } .stale { color:var(--no) }
  table.sum { width:100%; margin-top:18px; border-collapse:collapse; font-variant-numeric:tabular-nums }
  table.sum td { padding:4px 0 } table.sum td:last-child { text-align:right }
  tr.grand td { border-top:1px solid var(--line); padding-top:10px; font-weight:500; font-size:17px }
  .est { color:var(--soft); font-size:11px }
  .carts { display:flex; flex-wrap:wrap; gap:10px; margin-top:22px }
  .carts a { background:var(--ink); color:var(--bg); border-radius:999px; padding:9px 18px; font-size:13px;
             text-decoration:none; letter-spacing:.02em }
  .carts a:hover { opacity:.85 }
  .refused { border:1px solid var(--no); background:var(--nobg); border-radius:12px; padding:22px; margin-bottom:56px }
  .refused h2 { font-size:24px }
  footer { border-top:1px solid var(--line); margin-top:24px; padding-top:22px; color:var(--soft); font-size:13px }
  footer ul { padding-left:18px }
  footer li { margin-bottom:6px }
  @media (max-width:680px) {
    ol.spine::before { left:6px }
    .piece, .piece.right { width:auto; margin:0 0 20px 34px }
    .piece::before, .piece.left::before, .piece.right::before { left:-28px; right:auto; width:28px }
    .piece::after, .piece.left::after, .piece.right::after { left:-34.5px; right:auto }
    .pic { height:200px }
    .below { margin-top:40px }
    .meta { margin-left:0 }
  }
  @media (prefers-reduced-motion:reduce) { .card { transition:none } .card:hover { transform:none } }
</style>
<div class="wrap">
<header class="top">
  <span class="brand">AiTelier</span><span class="status ${approved ? "" : "no"}">${esc(result.status ?? "UNKNOWN")}</span>
  <div class="sub">Style: ${esc((result.style_blend ?? []).join(", ") || "—")} · Budget: ${esc(result.budget_label ?? "—")} · Task <code>${esc(result.task_id ?? "")}</code></div>
  ${index}
</header>

<details class="checked"${held === checks.length ? "" : " open"}>
  <summary><h3>What was checked</h3><span class="${held === checks.length ? "fresh" : "stale"}">${
    held === checks.length ? `All ${checks.length} guarantees held` : `${checks.length - held} of ${checks.length} guarantees failed`
  }</span></summary>
  <ul class="checks">${guaranteeRows(result, live)}</ul>
</details>

${refused}
${sets}

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
