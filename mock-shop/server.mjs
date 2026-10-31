import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestPayment, isTestKey, stripeKey as resolveStripeKey, stripeMode } from "../logic/purchase/stripe-test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = JSON.parse(readFileSync(path.join(HERE, "catalog.json"), "utf8"));
const DEFAULT_SHIPPING = 4.9;
const MAX_ITEMS = 10;
const MAX_BODY = 1_000_000;
const money = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clean(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function eur(value) {
  return money.format(Number(value) || 0);
}

function page(title, body, { wide = false, merchant = "AiTelier Test Merchant" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AiTelier Test Merchant</title>
<style>
:root{--ink:#17211f;--muted:#64706b;--line:#d9ded9;--paper:#f7f5ef;--card:#fffdf8;--green:#315c49;--gold:#b28a4b;--red:#9b3d34}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
header{border-bottom:1px solid var(--line);background:rgba(255,253,248,.9);position:sticky;top:0;z-index:5}
.wrap{width:min(${wide ? "1180" : "980"}px,calc(100% - 40px));margin:0 auto}
.bar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0}
.brand{font:600 20px/1.1 Georgia,serif;letter-spacing:.08em;text-transform:uppercase}
.brand small{display:block;font:500 10px/1.4 ui-sans-serif,system-ui;letter-spacing:.2em;color:var(--muted);margin-top:4px}
.testmode{background:#fff1d6;border-bottom:1px solid #e7c98d;color:#5b431b;font:600 12px/1.4 ui-sans-serif,system-ui;letter-spacing:.12em;text-transform:uppercase;text-align:center;padding:9px 16px}
.hero{padding:54px 0 28px}
.hero h1{font:600 clamp(34px,5vw,56px)/.98 Georgia,serif;margin:0 0 14px;letter-spacing:-.02em}
.hero p{max-width:620px;color:var(--muted);margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:22px;padding:24px 0 70px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden;box-shadow:0 12px 30px rgba(23,33,31,.05)}
.swatch{height:230px;display:flex;align-items:flex-end;padding:18px;color:#fff;font:600 12px/1.2 ui-sans-serif;letter-spacing:.14em;text-transform:uppercase}
.swatch.navy{background:linear-gradient(145deg,#1d2b46,#4e6384)}
.swatch.camel{background:linear-gradient(145deg,#9a7449,#d2b184)}
.swatch.ivory{background:linear-gradient(145deg,#d7d0bf,#f2eee4);color:#4c473c}
.swatch.black{background:linear-gradient(145deg,#161616,#3a3a3a)}
.swatch.ecru{background:linear-gradient(145deg,#c9bda2,#e9e0cb);color:#4c473c}
.card .body{padding:18px}
.card h3{font:600 20px/1.2 Georgia,serif;margin:0 0 5px}
.card .brandline{color:var(--muted);font-size:13px;margin-bottom:12px}
.price{font-weight:700}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--ink);background:var(--ink);color:#fff;padding:12px 18px;border-radius:999px;font:600 14px/1 ui-sans-serif;cursor:pointer;text-decoration:none}
.btn:hover{background:var(--green);border-color:var(--green)}
.btn.light{background:transparent;color:var(--ink)}
.btn:disabled{opacity:.35;cursor:not-allowed}
.product{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr);gap:42px;padding:42px 0 80px;align-items:start}
.product .art{border-radius:24px;min-height:520px;display:flex;align-items:flex-end;padding:30px;color:#fff;font:600 12px/1.3 ui-sans-serif;letter-spacing:.16em;text-transform:uppercase}
.product .art.navy{background:linear-gradient(145deg,#1d2b46,#4e6384)}
.product .art.camel{background:linear-gradient(145deg,#9a7449,#d2b184)}
.product .art.ivory{background:linear-gradient(145deg,#d7d0bf,#f2eee4);color:#4c473c}
.product .art.black{background:linear-gradient(145deg,#161616,#3a3a3a)}
.product .art.ecru{background:linear-gradient(145deg,#c9bda2,#e9e0cb);color:#4c473c}
.product h1{font:600 clamp(30px,4vw,46px)/1.02 Georgia,serif;margin:0 0 10px}
.product .meta{color:var(--muted);margin-bottom:24px}
.product .desc{color:#43504b;margin:18px 0 24px;max-width:480px}
label{display:block;font:600 12px/1.4 ui-sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#43504b;margin-bottom:7px}
input,select{width:100%;border:1px solid #c9d0ca;background:#fff;border-radius:12px;padding:13px 14px;font:inherit;color:var(--ink);outline:none}
input:focus,select:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(49,92,73,.13)}
.field{margin-bottom:16px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.checkout{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(320px,.92fr);gap:42px;padding:34px 0 80px;align-items:start}
.panel{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px}
.panel h2{font:600 26px/1.15 Georgia,serif;margin:0 0 18px}
.panel h3{font:600 16px/1.3 ui-sans-serif;margin:22px 0 12px}
.line{display:flex;justify-content:space-between;gap:18px;padding:10px 0;border-bottom:1px solid #e8ebe6}
.line:last-child{border-bottom:0}
.line small{display:block;color:var(--muted)}
.line .item{display:flex;align-items:center;gap:12px}
.thumb{width:48px;height:60px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:#eee}
.merchant{color:var(--muted);font-size:13px;margin:-6px 0 18px}
.merchant strong{color:var(--ink)}
.summary{position:sticky;top:92px}
.total{display:flex;justify-content:space-between;font:700 22px/1.2 Georgia,serif;padding-top:16px;margin-top:8px;border-top:1px solid var(--line)}
.test-note{background:#fff1d6;border:1px solid #e7c98d;border-radius:12px;padding:12px 14px;color:#5b431b;font-size:13px;margin:18px 0}
.error{background:#fdecea;border:1px solid #e7b4ae;color:#7d2b23;border-radius:12px;padding:12px 14px;margin-bottom:18px}
.success{padding:70px 0 100px;text-align:center}
.success .tick{width:82px;height:82px;border-radius:50%;background:#e4efe8;color:var(--green);display:grid;place-items:center;font-size:38px;margin:0 auto 22px}
.success h1{font:600 clamp(32px,5vw,48px)/1 Georgia,serif;margin:0 0 12px}
.success p{color:var(--muted);margin:0 auto 24px;max-width:560px}
.receipt{display:inline-grid;grid-template-columns:auto auto;gap:10px 28px;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 26px;margin:10px auto 24px;font-size:14px}
.receipt dt{color:var(--muted)}
.receipt dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
.footer{border-top:1px solid var(--line);color:var(--muted);font-size:12px;padding:26px 0 50px}
@media(max-width:800px){.product,.checkout{grid-template-columns:1fr}.summary{position:static}.product .art{min-height:340px}.row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="testmode">Stripe test mode · no real money · test card 4242 4242 4242 4242</div>
<header><div class="wrap bar"><a class="brand" href="/">AiTelier<small>Test checkout · ${esc(merchant)}</small></a><a class="btn light" href="/">Shop</a></div></header>
${body}
<footer><div class="wrap footer">AiTelier test merchant · checkout runs against Stripe test mode · local demo only</div></footer>
</body>
</html>`;
}

function productSwatch(product) {
  return `<div class="swatch ${esc(product.slug)}">${esc(product.color)}</div>`;
}

function catalogPage(catalog) {
  const cards = catalog.map((product) => `
    <article class="card" data-testid="product-${esc(product.slug)}">
      ${productSwatch(product)}
      <div class="body">
        <h3>${esc(product.title)}</h3>
        <div class="brandline">${esc(product.brand)} · ${esc(product.color)}</div>
        <div class="price">${eur(product.price)}</div>
        <p><a class="btn" href="/product/${esc(product.slug)}">View item</a></p>
      </div>
    </article>`).join("");
  return page("Shop", `<main class="wrap"><section class="hero"><h1>A small shop for a large idea.</h1><p>A realistic test merchant for AiTelier. Choose a garment, choose a size, and the agent can take it through a Stripe test checkout.</p></section><section class="grid">${cards}</section></main>`, { wide: true });
}

function productPage(product, { error = "" } = {}) {
  const sizes = Object.entries(product.sizes ?? {})
    .map(([size, stock]) => `<option value="${esc(size)}" ${stock > 0 ? "" : "disabled"}>${esc(size)}${stock > 0 ? "" : " · sold out"}</option>`)
    .join("");
  const firstAvailable = Object.entries(product.sizes ?? {}).find(([, stock]) => stock > 0)?.[0] ?? "";
  return page(product.title, `<main class="wrap"><section class="product">
    <div class="art ${esc(product.slug)}">${esc(product.title)} · ${esc(product.brand)}</div>
    <div>
      <h1>${esc(product.title)}</h1>
      <div class="meta">${esc(product.brand)} · ${esc(product.color)} · ${eur(product.price)}</div>
      <p class="desc">${esc(product.description)}</p>
      ${error ? `<div class="error">${esc(error)}</div>` : ""}
      <form method="POST" action="/checkout/new">
        <input type="hidden" name="slug" value="${esc(product.slug)}">
        <div class="field"><label for="size">Size</label><select id="size" name="size" data-testid="size-select" required>${sizes}</select></div>
        <button class="btn" type="submit" data-testid="add-to-cart">Add to bag · ${eur(product.price)}</button>
      </form>
      <div class="test-note">This is a test merchant. Adding to bag is local. Payment is a Stripe test PaymentIntent.</div>
    </div>
  </section></main>`, { wide: true });
}

function checkoutPage(checkout, { error = "", form = {} } = {}) {
  const items = checkout.items.map((item) => `
    <div class="line" data-testid="checkout-item">
      <div class="item">${item.image ? `<img class="thumb" src="${esc(item.image)}" alt="">` : ""}<div><strong>${esc(item.title)}</strong><small>${esc(item.brand)}${item.size ? ` · size ${esc(item.size)}` : ""} · qty ${esc(item.quantity)}</small></div></div>
      <div>${eur(item.price * item.quantity)}</div>
    </div>`).join("");
  const value = (name, fallback = "") => esc(form[name] ?? fallback);
  const issuing = process.env.AITELIER_USE_ISSUING_CARD === "true" && process.env.STRIPE_ISSUING_CARD_NUMBER;
  const demoNumber = issuing ? process.env.STRIPE_ISSUING_CARD_NUMBER : "4242 4242 4242 4242";
  const demoMonth = issuing ? process.env.STRIPE_ISSUING_CARD_EXP_MONTH : "12";
  const demoYear = issuing ? process.env.STRIPE_ISSUING_CARD_EXP_YEAR : "34";
  const demoCvc = issuing ? process.env.STRIPE_ISSUING_CARD_CVC : "123";
  const expiry = `${String(demoMonth || "12").padStart(2, "0")}/${String(demoYear || "34").slice(-2)}`;
  const last4 = String(demoNumber).replace(/\s+/g, "").slice(-4);
  return page("Checkout", `<main class="wrap"><section class="checkout">
    <div>
      <div class="panel">
        <h2>Checkout</h2>
        ${error ? `<div class="error" data-testid="checkout-error">${esc(error)}</div>` : ""}
        <form method="POST" action="/checkout/${esc(checkout.id)}/pay">
          <h3>Delivery address</h3>
          <div class="field"><label for="shipping-name">Full name</label><input id="shipping-name" name="shipping-name" data-testid="shipping-name" autocomplete="name" value="${value("shipping-name")}" required></div>
          <div class="field"><label for="shipping-line1">Street and number</label><input id="shipping-line1" name="shipping-line1" data-testid="shipping-line1" autocomplete="address-line1" value="${value("shipping-line1")}" required></div>
          <div class="row">
            <div class="field"><label for="shipping-postal">Postal code</label><input id="shipping-postal" name="shipping-postal" data-testid="shipping-postal" autocomplete="postal-code" value="${value("shipping-postal")}" required></div>
            <div class="field"><label for="shipping-city">City</label><input id="shipping-city" name="shipping-city" data-testid="shipping-city" autocomplete="address-level2" value="${value("shipping-city")}" required></div>
          </div>
          <div class="row">
            <div class="field"><label for="shipping-country">Country</label><input id="shipping-country" name="shipping-country" data-testid="shipping-country" autocomplete="country" value="${value("shipping-country", "DE")}" required></div>
            <div class="field"><label for="shipping-email">Email</label><input id="shipping-email" name="shipping-email" data-testid="shipping-email" type="email" autocomplete="email" value="${value("shipping-email", "demo@aitelier.test")}" required></div>
          </div>
          <h3>Card</h3>
          <div class="field"><label for="card-number">Card number</label><input id="card-number" name="card-number" data-testid="card-number" type="password" inputmode="numeric" autocomplete="cc-number" placeholder="Card number" value="${value("card-number", demoNumber)}" required></div>
          <div class="row">
            <div class="field"><label for="card-expiry">Expiry</label><input id="card-expiry" name="card-expiry" data-testid="card-expiry" autocomplete="cc-exp" placeholder="MM/YY" value="${value("card-expiry", expiry)}" required></div>
            <div class="field"><label for="card-cvc">CVC</label><input id="card-cvc" name="card-cvc" data-testid="card-cvc" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="CVC" value="${value("card-cvc", demoCvc)}" required></div>
          </div>
          <div class="test-note">Test mode only. Visa ending <strong>${esc(last4)}</strong>. The card fields are a demo; the server confirms a Stripe test PaymentIntent with <code>pm_card_visa</code> and never stores the number.</div>
          <button class="btn" type="submit" data-testid="pay-now">Pay ${eur(checkout.total)}</button>
        </form>
      </div>
    </div>
    <aside class="panel summary">
      <h2>Order summary</h2>
      <div class="merchant">Test checkout for <strong>${esc(checkout.merchant_name)}</strong></div>
      ${items}
      <div class="line"><span>Subtotal</span><span>${eur(checkout.subtotal)}</span></div>
      <div class="line"><span>Shipping</span><span>${eur(checkout.shipping)}</span></div>
      <div class="total" data-testid="checkout-total"><span>Total</span><span>${eur(checkout.total)}</span></div>
      <div class="test-note">Mode: <strong>${esc(checkout.payment_mode)}</strong> · Stripe test mode · no real charge.</div>
    </aside>
  </section></main>`, { wide: true, merchant: checkout.merchant_name });
}

function orderPage(order) {
  return page("Order confirmed", `<main class="wrap"><section class="success" data-testid="order-confirmation">
    <div class="tick">✓</div>
    <h1>Order confirmed</h1>
    <p>${order.mock ? "The mock payment provider answered. No money moved." : "The Stripe test PaymentIntent succeeded. No real money moved."}</p>
    <dl class="receipt">
      <dt>Order</dt><dd data-testid="order-id">${esc(order.id)}</dd>
      <dt>Payment</dt><dd data-testid="payment-intent-id">${esc(order.payment_intent_id)}</dd>
      <dt>Total</dt><dd data-testid="order-total">${eur(order.total)}</dd>
      <dt>Status</dt><dd>${esc(order.status)}</dd>
      <dt>Ship to</dt><dd>${esc(order.shipping.name)}, ${esc(order.shipping.line1)}, ${esc(order.shipping.postal_code)} ${esc(order.shipping.city)}</dd>
    </dl>
    <p><a class="btn" href="/">Back to the shop</a></p>
  </section></main>`, { wide: true, merchant: order.merchant_name });
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("A checkout needs at least one item.");
  if (items.length > MAX_ITEMS) throw new Error(`A checkout may hold at most ${MAX_ITEMS} items.`);
  return items.map((item, index) => {
    const price = Number(item.price);
    const quantity = item.quantity == null ? 1 : Number(item.quantity);
    if (!Number.isFinite(price) || price < 0) throw new Error(`Item ${index + 1} has no valid price.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error(`Item ${index + 1} has an invalid quantity.`);
    const currency = clean(item.currency || "EUR", 3).toUpperCase();
    if (currency !== "EUR") throw new Error("This test merchant only charges EUR.");
    return {
      title: clean(item.title || `Item ${index + 1}`, 120),
      brand: clean(item.brand || "", 80),
      size: clean(item.size || "", 20),
      quantity,
      price: round2(price),
      currency,
      product_url: clean(item.product_url || "", 600),
      image: clean(item.image || "", 700),
    };
  });
}

function totals(items, shipping) {
  const subtotal = round2(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
  const ship = round2(shipping == null ? DEFAULT_SHIPPING : Number(shipping));
  if (!Number.isFinite(ship) || ship < 0) throw new Error("Shipping is not a valid amount.");
  return { subtotal, shipping: ship, total: round2(subtotal + ship) };
}

export function createShop({
  catalog = DEFAULT_CATALOG,
  paymentMode = stripeMode(),
  stripeKey = resolveStripeKey(),
  host = process.env.SHOP_HOST || "127.0.0.1",
  port = Number(process.env.SHOP_PORT || 3100),
} = {}) {
  const checkouts = new Map();
  const orders = new Map();

  function newCheckout(input) {
    const items = normalizeItems(input.items);
    const sums = totals(items, input.shipping);
    if (input.total != null) {
      const reported = Number(input.total);
      if (!Number.isFinite(reported) || Math.abs(reported - sums.total) > 0.05 * items.length + 0.05)
        throw new Error(`Reported total ${reported} does not match the merchant total ${sums.total}.`);
    }
    const checkout = {
      id: `chk_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      created_at: new Date().toISOString(),
      status: "open",
      purchase_id: clean(input.purchase_id || "", 120),
      merchant_name: clean(input.merchant_name || "AiTelier Test Merchant", 100),
      items,
      ...sums,
      currency: "EUR",
      payment_mode: paymentMode,
      shipping_address: null,
      order_id: null,
      payment_intent_id: null,
    };
    checkouts.set(checkout.id, checkout);
    return checkout;
  }

  function findProduct(slug) {
    return catalog.find((product) => product.slug === slug);
  }

  function saveOrder(checkout, payment, shipping) {
    const order = {
      id: `shop_order_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      checkout_id: checkout.id,
      purchase_id: checkout.purchase_id,
      merchant_name: checkout.merchant_name,
      payment_intent_id: payment.id,
      payment_mode: payment.mock ? "mock" : "stripe",
      mock: payment.mock,
      status: "paid",
      currency: checkout.currency,
      subtotal: checkout.subtotal,
      shipping_cost: checkout.shipping,
      total: checkout.total,
      items: checkout.items,
      shipping,
      created_at: new Date().toISOString(),
    };
    checkout.status = "paid";
    checkout.order_id = order.id;
    checkout.payment_intent_id = payment.id;
    checkout.shipping_address = shipping;
    orders.set(order.id, order);
    return order;
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error("Request body is too large.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function readJson(req) {
    const text = await readBody(req);
    if (!text.trim()) return {};
    return JSON.parse(text);
  }

  async function readForm(req) {
    const text = await readBody(req);
    return Object.fromEntries(new URLSearchParams(text));
  }

  function send(res, status, body, type = "text/html; charset=utf-8") {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; img-src 'self' data: https:; base-uri 'none'",
    });
    res.end(body);
  }

  function json(res, status, value) {
    send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
  }

  function redirect(res, location) {
    res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
    res.end();
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/") return send(res, 200, catalogPage(catalog));
      if (req.method === "GET" && pathname === "/health")
        return json(res, 200, {
          ok: true,
          service: "aitelier-test-merchant",
          payment_mode: paymentMode,
          stripe_key: isTestKey(stripeKey),
          checkouts: checkouts.size,
          orders: orders.size,
        });

      const productMatch = pathname.match(/^\/product\/([\w-]+)$/);
      if (req.method === "GET" && productMatch) {
        const product = findProduct(productMatch[1]);
        if (!product) return send(res, 404, page("Not found", "<main class=\"wrap\"><h1>Not found</h1></main>"));
        return send(res, 200, productPage(product));
      }

      if (req.method === "POST" && pathname === "/checkout/new") {
        const form = await readForm(req);
        const product = findProduct(clean(form.slug, 80));
        const size = clean(form.size, 20);
        if (!product) return send(res, 404, page("Not found", "<main class=\"wrap\"><h1>Not found</h1></main>"));
        if (!size || !(size in (product.sizes ?? {})) || product.sizes[size] <= 0)
          return send(res, 400, productPage(product, { error: "Choose a size that is in stock." }));
        const checkout = newCheckout({
          purchase_id: `shop:${product.slug}:${size}`,
          items: [{ title: product.title, brand: product.brand, size, quantity: 1, price: product.price, currency: product.currency, product_url: `${publicUrl()}/product/${product.slug}` }],
          shipping: DEFAULT_SHIPPING,
        });
        return redirect(res, `/checkout/${checkout.id}`);
      }

      if (req.method === "POST" && pathname === "/api/checkouts") {
        const body = await readJson(req);
        const checkout = newCheckout(body);
        return json(res, 201, { id: checkout.id, url: `${publicUrl()}/checkout/${checkout.id}`, checkout });
      }

      const checkoutApi = pathname.match(/^\/api\/checkouts\/([\w-]+)$/);
      if (req.method === "GET" && checkoutApi) {
        const checkout = checkouts.get(checkoutApi[1]);
        if (!checkout) return json(res, 404, { error: "Checkout not found." });
        return json(res, 200, { checkout });
      }

      const checkoutMatch = pathname.match(/^\/checkout\/([\w-]+)$/);
      if (req.method === "GET" && checkoutMatch) {
        const checkout = checkouts.get(checkoutMatch[1]);
        if (!checkout) return send(res, 404, page("Not found", "<main class=\"wrap\"><h1>Checkout not found</h1></main>"));
        return send(res, 200, checkoutPage(checkout));
      }

      const payMatch = pathname.match(/^\/checkout\/([\w-]+)\/pay$/);
      if (req.method === "POST" && payMatch) {
        const checkout = checkouts.get(payMatch[1]);
        if (!checkout) return send(res, 404, page("Not found", "<main class=\"wrap\"><h1>Checkout not found</h1></main>"));
        if (checkout.status === "paid" && checkout.order_id) return redirect(res, `/order/${checkout.order_id}`);
        const form = await readForm(req);
        const required = ["shipping-name", "shipping-line1", "shipping-postal", "shipping-city", "shipping-country", "shipping-email"];
        const missing = required.filter((name) => !clean(form[name], 200));
        if (missing.length) return send(res, 400, checkoutPage(checkout, { error: "Fill in the delivery address.", form }));
        const card = clean(form["card-number"], 40).replace(/\s+/g, "");
        const acceptedCards = new Set(["4242424242424242"]);
        if (process.env.STRIPE_ISSUING_CARD_NUMBER)
          acceptedCards.add(process.env.STRIPE_ISSUING_CARD_NUMBER.replace(/\s+/g, ""));
        if (!acceptedCards.has(card))
          return send(res, 402, checkoutPage(checkout, { error: "Use the configured test card or 4242 4242 4242 4242.", form }));
        if (!/^\d{2}\/\d{2}$/.test(clean(form["card-expiry"], 10)) || !/^\d{3,4}$/.test(clean(form["card-cvc"], 5)))
          return send(res, 402, checkoutPage(checkout, { error: "Use a future expiry (MM/YY) and a 3 or 4 digit CVC.", form }));
        const shipping = {
          name: clean(form["shipping-name"], 120),
          line1: clean(form["shipping-line1"], 160),
          postal_code: clean(form["shipping-postal"], 20),
          city: clean(form["shipping-city"], 80),
          country: clean(form["shipping-country"], 2).toUpperCase(),
          email: clean(form["shipping-email"], 160),
        };
        try {
          const payment = await createTestPayment({
            amountCents: Math.round(checkout.total * 100),
            currency: checkout.currency,
            description: `AiTelier test order ${checkout.id}`,
            metadata: {
              checkout_id: checkout.id,
              purchase_id: checkout.purchase_id,
              issuing_card_id: process.env.STRIPE_ISSUING_CARD_ID || undefined,
              issuing_cardholder_id: process.env.STRIPE_ISSUING_CARDHOLDER_ID || undefined,
            },
            key: stripeKey,
            mode: paymentMode,
            idempotencyKey: `aitelier-shop-${checkout.id}`,
          });
          const order = saveOrder(checkout, payment, shipping);
          return redirect(res, `/order/${order.id}`);
        } catch (error) {
          return send(res, 402, checkoutPage(checkout, { error: `Payment failed: ${error.message}`, form }));
        }
      }

      const orderMatch = pathname.match(/^\/order\/([\w-]+)$/);
      if (req.method === "GET" && orderMatch) {
        const order = orders.get(orderMatch[1]);
        if (!order) return send(res, 404, page("Not found", "<main class=\"wrap\"><h1>Order not found</h1></main>"));
        return send(res, 200, orderPage(order));
      }

      if (req.method === "POST" && pathname === "/admin/reset") {
        checkouts.clear();
        orders.clear();
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/orders") return json(res, 200, { orders: [...orders.values()] });

      return json(res, 404, { error: "Not found." });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  function publicUrl() {
    return process.env.AITELIER_SHOP_URL?.replace(/\/+$/, "") || `http://${host}:${port}`;
  }

  const server = createServer(handler);
  return { server, host, port, catalog, checkouts, orders, newCheckout, publicUrl };
}

export async function startShop(options = {}) {
  const shop = createShop(options);
  await new Promise((resolve, reject) => {
    shop.server.once("error", reject);
    shop.server.listen(shop.port, shop.host, resolve);
  });
  const address = shop.server.address();
  shop.port = address.port;
  shop.url = process.env.AITELIER_SHOP_URL?.replace(/\/+$/, "") || `http://${shop.host}:${shop.port}`;
  return shop;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const shop = await startShop();
  console.log(`AiTelier test merchant: ${shop.url} (payment mode: ${stripeMode()})`);
  const close = () => shop.server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
