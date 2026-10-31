import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestKey, stripeKey, stripeMode } from "./purchase/stripe-test.mjs";
import { agentReachCheckout, agentBrowserEnabled, heuristicReachCheckout } from "./purchase/agent-browser.mjs";
import { logger } from "../log.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = logger("pay-stripe");
const DEFAULT_SHOP = "http://127.0.0.1:3100";
const DEFAULT_HOLD_MS = 2500;

function envValue(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function envBool(name, fallback = false) {
  const value = envValue(name, "");
  if (!value) return fallback;
  return /^(?:1|true|yes|on)$/i.test(value);
}

function numberValue(name, fallback = 0) {
  const value = Number(envValue(name, ""));
  return Number.isFinite(value) ? value : fallback;
}

function safeName(value) {
  return String(value || "purchase").replace(/[^\w.-]+/g, "_").slice(0, 120);
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll("\\", "/");
}

function moneyOf(text) {
  const matches = [...String(text ?? "").matchAll(/(\d+(?:[.,]\d{2})?)\s*€/g)];
  if (!matches.length) return null;
  const raw = matches.at(-1)[1].replace(",", ".");
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function shipping() {
  return {
    name: envValue("AITELIER_DEMO_SHIPPING_NAME", "Dmytro Dmytro"),
    line1: envValue("AITELIER_DEMO_SHIPPING_LINE1", "Arcisstrasse 21"),
    postal_code: envValue("AITELIER_DEMO_SHIPPING_POSTAL", "80333"),
    city: envValue("AITELIER_DEMO_SHIPPING_CITY", "Munich"),
    country: envValue("AITELIER_DEMO_SHIPPING_COUNTRY", "DE").toUpperCase().slice(0, 2),
    email: envValue("AITELIER_DEMO_SHIPPING_EMAIL", "demo@aitelier.test"),
    phone: envValue("AITELIER_DEMO_SHIPPING_PHONE", "+4915123456789"),
  };
}

function splitName(name) {
  const parts = String(name || "Dmytro Dmytro").trim().split(/\s+/);
  return { first: parts[0] || "Dmytro", last: parts.slice(1).join(" ") || parts[0] || "Dmytro" };
}

function cardForDemo() {
  if (envBool("AITELIER_USE_ISSUING_CARD", false) && envValue("STRIPE_ISSUING_CARD_NUMBER")) {
    const month = String(envValue("STRIPE_ISSUING_CARD_EXP_MONTH", "10")).padStart(2, "0");
    const year = envValue("STRIPE_ISSUING_CARD_EXP_YEAR", "2029");
    return {
      number: envValue("STRIPE_ISSUING_CARD_NUMBER"),
      expiry: `${month}/${year.slice(-2)}`,
      cvc: envValue("STRIPE_ISSUING_CARD_CVC", "123"),
      label: `Issuing card ending ${envValue("STRIPE_ISSUING_CARD_NUMBER").replace(/\s+/g, "").slice(-4)}`,
    };
  }
  return { number: "4242424242424242", expiry: "12/34", cvc: "123", label: "Stripe test card 4242" };
}

async function firstVisible(page, selector) {
  const locator = page.locator(selector);
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return locator.nth(index);
  }
  return locator.first();
}

async function fillVisible(page, selector, value) {
  const field = await firstVisible(page, selector);
  await field.fill(String(value), { timeout: 12000 });
}

async function dismissCookies(page) {
  for (const pattern of [/alle akzeptieren/i, /accept all/i, /akzeptieren/i, /zustimmen/i, /allow all/i]) {
    const button = page.getByRole("button", { name: pattern });
    if (await button.count()) {
      try {
        await button.first().click({ timeout: 2500 });
        await page.waitForTimeout(400);
        return true;
      } catch {}
    }
  }
  return false;
}

async function screenshot(page, directory, name, options = {}) {
  const file = path.join(directory, name);
  await page.screenshot({ path: file, ...options });
  return file;
}

async function ensureShop(shopUrl) {
  let response;
  try {
    response = await fetch(`${shopUrl}/health`, { signal: AbortSignal.timeout(4000) });
  } catch (error) {
    throw new Error(`Mock shop is not reachable at ${shopUrl}. Start it with: npm run shop (${error.message})`);
  }
  if (!response.ok) throw new Error(`Mock shop health check failed with HTTP ${response.status}.`);
  const health = await response.json();
  if (stripeMode() === "stripe" && !health.stripe_key)
    throw new Error("Mock shop is in Stripe test mode but has no test secret key.");
  return health;
}

async function selectRealVariant(page, item) {
  const size = String(item.size || "M").trim();
  const color = envValue("AITELIER_DEMO_COLOR", "Black");
  const host = new URL(item.product_url).hostname;
  if (host.endsWith("thokkthokk.com")) {
    const colorOption = page.locator(`li.select-option[data-value="${color}"] label`).first();
    if (await colorOption.count()) {
      await colorOption.click({ timeout: 12000 });
      await page.waitForTimeout(700);
    }
    const sizeOption = page.locator(`li.select-option[data-value="${size}"] label`).first();
    if (!(await sizeOption.count()))
      throw new Error(`The real shop has no visible ${size} size.`);
    await sizeOption.click({ timeout: 12000 });
    await page.waitForTimeout(1200);
    const selected = await page.locator('input[name="id"]').last().inputValue().catch(() => "");
    if (!selected) throw new Error("The real shop did not select a variant.");
    return;
  }
  let selected = false;
  const select = page.locator("select").filter({ has: page.locator(`option:text-is("${size}")`) }).first();
  if (await select.count()) {
    try {
      await select.selectOption({ label: size });
      selected = true;
    } catch {}
  }
  if (!selected) {
    const option = page.getByText(size, { exact: true });
    if (await option.count()) {
      try {
        await option.first().click({ timeout: 5000 });
        selected = true;
      } catch {}
    }
  }
  if (!selected) throw new Error(`Could not select size ${size} on the real shop.`);
  await page.waitForTimeout(800);
}

async function addToCart(page) {
  const button = page.locator('button[name="add"], button[type="submit"]:has-text("In den Warenkorb"), button[type="submit"]:has-text("Add to cart"), button[type="submit"]:has-text("Add to bag")').first();
  if (!(await button.count())) throw new Error("Could not find the add-to-cart button on the real shop.");
  await button.click({ timeout: 15000 });
  await page.waitForTimeout(2500);
}

async function openCheckout(page) {
  const drawer = page.locator("#CartDrawer-Checkout");
  if (await drawer.count()) {
    try {
      await drawer.first().click({ timeout: 8000 });
    } catch {
      await page.goto(new URL("/cart", page.url()).href, { waitUntil: "domcontentloaded", timeout: 45000 });
      const fallback = page.locator('button[name="checkout"], a[href*="/checkout"]').first();
      if (!(await fallback.count())) throw new Error("Could not find the checkout button in the real cart.");
      await fallback.click({ timeout: 12000 });
    }
  } else {
    await page.goto(new URL("/cart", page.url()).href, { waitUntil: "domcontentloaded", timeout: 45000 });
    const fallback = page.locator('button[name="checkout"], a[href*="/checkout"]').first();
    if (!(await fallback.count())) throw new Error("Could not find the checkout button in the real cart.");
    await fallback.click({ timeout: 12000 });
  }
  await page.waitForURL(/\/checkouts?\//, { timeout: 45000 });
}

async function fillRealCheckout(page, address) {
  const name = splitName(address.name);
  const fill = async (selector, value) => {
    try {
      await fillVisible(page, selector, value);
      return true;
    } catch {
      return false;
    }
  };
  await page.waitForSelector('input[name="email"], input', { timeout: 20000 }).catch(() => {});
  await fill('input[name="email"]', address.email);
  await fill('input[name="firstName"]', name.first);
  await fill('input[name="lastName"]', name.last);
  await fill('#shipping-address1, input[name="address1"]', address.line1);
  await fill('input[name="postalCode"]', address.postal_code);
  await fill('input[name="city"]', address.city);
  await fill('input[name="phone"]', address.phone);

  const patterns = [
    { pattern: /e-?mail/i, value: address.email },
    { pattern: /first.?name|vorname/i, value: name.first },
    { pattern: /last.?name|nachname/i, value: name.last },
    { pattern: /address|adresse|strasse|street/i, value: address.line1 },
    { pattern: /postal|postcode|plz|zip/i, value: address.postal_code },
    { pattern: /city|stadt|ort/i, value: address.city },
    { pattern: /phone|telefon|mobile/i, value: address.phone },
  ];
  const inputs = page.locator("input");
  const count = await inputs.count();
  for (let index = 0; index < Math.min(count, 80); index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const attrs = await input.evaluate((element) => ({
      name: element.getAttribute("name") ?? "",
      id: element.id ?? "",
      placeholder: element.getAttribute("placeholder") ?? "",
      aria: element.getAttribute("aria-label") ?? "",
      type: element.getAttribute("type") ?? "text",
    })).catch(() => null);
    if (!attrs || ["hidden", "password", "checkbox", "radio", "submit"].includes(attrs.type)) continue;
    const field = [attrs.name, attrs.id, attrs.placeholder, attrs.aria].join(" ");
    if (/card|kartennummer|cvc|cvv|security|sicherheit|expiry|gultig|gültig/i.test(field)) continue;
    if (/address2|address_2|addressline2|wohnung|apartment|company|firma/i.test(field)) continue;
    const match = patterns.find(({ pattern }) => pattern.test(field));
    if (!match) continue;
    if (await input.inputValue().catch(() => "")) continue;
    await input.fill(match.value, { timeout: 5000 }).catch(() => {});
  }

  await page.waitForTimeout(6000);
  const body = await page.locator("body").innerText();
  if (/captcha|sicherheitsüberprüfung|verify you are human|zugriff verweigert/i.test(body))
    throw new Error("The real checkout asked for a captcha or human verification.");
  if (/anmelden|sign in|passwort|password/i.test(body) && !/konto erstellen|create account/i.test(body)) {
    const hasEmail = await page.locator('input[name="email"]').count();
    if (!hasEmail) throw new Error("The real checkout requires an account.");
  }
}

async function readRealTotal(page) {
  const pay = page.locator("#checkout-pay-button");
  if (await pay.count()) {
    for (const text of [
      await pay.first().getAttribute("aria-label").catch(() => ""),
      await pay.first().innerText().catch(() => ""),
    ]) {
      const amount = moneyOf(text);
      if (Number.isFinite(amount)) return amount;
    }
  }
  const label = page.getByText("Gesamt", { exact: true }).last();
  if (await label.count()) {
    const texts = await label.evaluate((element) => {
      const chain = [];
      let node = element;
      for (let index = 0; index < 6 && node; index += 1, node = node.parentElement)
        chain.push(node.innerText ?? "");
      return chain;
    }).catch(() => []);
    for (const text of texts) {
      const match = String(text).match(/Gesamt\s*(?:EUR)?\s*(\d+[.,]\d{2})/i);
      if (match) return Number(match[1].replace(",", "."));
    }
  }
  const body = await page.locator("body").innerText();
  const matches = [...body.matchAll(/(?:Gesamt|Total|Summe|Order total)\s*[:：]?\s*(?:EUR)?\s*(\d+[.,]\d{2})/gi)];
  return matches.length ? Number(matches.at(-1)[1].replace(",", ".")) : null;
}

async function realCheckoutPage(page, item, address, evidenceDir, signal) {
  const screenshots = [];
  let via = "adapter";
  try {
    await page.goto(item.product_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await dismissCookies(page);
    screenshots.push(await screenshot(page, evidenceDir, "real-product.png", { fullPage: false }));
    await selectRealVariant(page, item);
    screenshots.push(await screenshot(page, evidenceDir, "real-selected.png", { fullPage: false }));
    await addToCart(page);
    screenshots.push(await screenshot(page, evidenceDir, "real-cart.png", { fullPage: false }));
    await openCheckout(page);
  } catch (error) {
    if (!agentBrowserEnabled()) throw error;
    log.warn("real adapter failed; trying heuristic browser", { reason: error.message, url: page.url() });
    let fallback = await heuristicReachCheckout(page, { evidenceDir, shot: screenshot, signal });
    screenshots.push(...(fallback.screenshots ?? []));
    if (!fallback.ok) {
      log.warn("heuristic browser failed; trying agent browser", { reason: fallback.reason, url: page.url() });
      fallback = await agentReachCheckout(page, { item, evidenceDir, signal, shot: screenshot });
      screenshots.push(...(fallback.screenshots ?? []));
    }
    if (!fallback.ok) throw new Error(`${error.message}; agent fallback: ${fallback.reason}`);
    via = fallback.via ?? "agent";
  }
  try {
    await fillRealCheckout(page, address);
  } catch (error) {
    log.warn("real checkout address not filled", { reason: error.message, url: page.url() });
  }
  const total = await readRealTotal(page).catch(() => null);
  const title = await page.title().catch(() => "");
  const cleaned = title.replace(/^checkout\s*[-–—]\s*/i, "").trim();
  const merchant = !cleaned || /^(?:checkout|kasse|warenkorb|cart|payment)$/i.test(cleaned)
    ? new URL(page.url()).hostname
    : cleaned;
  screenshots.push(await screenshot(page, evidenceDir, "real-checkout.png", { fullPage: true }));
  return {
    ok: true,
    reached: "payment",
    merchant,
    total: Number.isFinite(total) ? total : null,
    currency: "EUR",
    url: page.url(),
    via,
    screenshots: screenshots.map(relative),
  };
}

async function createMockCheckout(shopUrl, purchase, real, address) {
  const source = purchase.items?.[0];
  if (!source) throw new Error("The purchase has no item.");
  const total = real.ok && Number.isFinite(real.total) && real.total > 0 ? real.total : Number(purchase.total);
  if (!Number.isFinite(total) || total <= 0) throw new Error("The purchase has no amount to pay.");
  const budget = Number(purchase.budget_eur);
  if (Number.isFinite(budget) && total > budget + 0.05)
    return { declined: `The real checkout total ${total.toFixed(2)} EUR is over the ${budget.toFixed(2)} EUR budget.` };
  const host = (() => {
    try {
      return new URL(source.product_url).hostname.replace(/^www\./, "");
    } catch {
      return "merchant";
    }
  })();
  const merchant = real.ok && real.merchant ? real.merchant : envValue("AITELIER_DEMO_MERCHANT", host);
  const item = {
    title: source.title || "Item",
    brand: source.brand || "",
    size: source.size || "",
    quantity: 1,
    price: total,
    currency: "EUR",
    product_url: source.product_url || "",
    image: source.image_url || "",
  };
  const response = await fetch(`${shopUrl}/api/checkouts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      purchase_id: purchase.purchase_id,
      merchant_name: merchant,
      items: [item],
      shipping: 0,
      total,
      currency: "EUR",
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`The mock shop refused the checkout: ${body.error || `HTTP ${response.status}`}`);
  return { url: body.url, checkout: body.checkout, merchant, total, address };
}

async function payMock(page, checkoutUrl, address, evidenceDir) {
  await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('[data-testid="shipping-name"]').fill(address.name);
  await page.locator('[data-testid="shipping-line1"]').fill(address.line1);
  await page.locator('[data-testid="shipping-postal"]').fill(address.postal_code);
  await page.locator('[data-testid="shipping-city"]').fill(address.city);
  await page.locator('[data-testid="shipping-country"]').fill(address.country);
  await page.locator('[data-testid="shipping-email"]').fill(address.email);
  const card = cardForDemo();
  const cardNumber = page.locator('[data-testid="card-number"]');
  await cardNumber.fill("");
  await cardNumber.pressSequentially(card.number.replace(/\s+/g, ""), { delay: 35 });
  await page.locator('[data-testid="card-expiry"]').fill(card.expiry);
  await page.locator('[data-testid="card-cvc"]').fill(card.cvc);
  const filledShot = await screenshot(page, evidenceDir, "mock-checkout.png", { fullPage: true });
  await page.locator('[data-testid="pay-now"]').click();
  await page.waitForURL(/\/order\//, { timeout: 45000 });
  await page.waitForSelector('[data-testid="order-confirmation"]', { timeout: 30000 });
  const orderId = (await page.locator('[data-testid="order-id"]').innerText()).trim();
  const paymentIntentId = (await page.locator('[data-testid="payment-intent-id"]').innerText()).trim();
  const totalText = (await page.locator('[data-testid="order-total"]').innerText()).trim();
  const confirmationShot = await screenshot(page, evidenceDir, "mock-confirmation.png", { fullPage: true });
  return {
    orderId,
    paymentIntentId,
    total: moneyOf(totalText) ?? Number(totalText.replace(/[^\d,.]/g, "").replace(",", ".")),
    currency: "EUR",
    card: card.label,
    screenshots: [filledShot, confirmationShot].map(relative),
  };
}

export async function payOutfit(purchase, { signal } = {}) {
  if (!purchase || !Array.isArray(purchase.items) || !purchase.items.length)
    return { status: "failed", detail: "There is no outfit to pay for." };
  const mode = stripeMode();
  if (mode === "stripe") assertTestKey(stripeKey());
  const shopUrl = envValue("AITELIER_SHOP_URL", DEFAULT_SHOP).replace(/\/+$/, "");
  await ensureShop(shopUrl);
  const address = shipping();
  const evidenceDir = path.join(ROOT, envValue("AITELIER_EVIDENCE_DIR", ".local/evidence"), safeName(purchase.purchase_id));
  await mkdir(evidenceDir, { recursive: true });
  const headed = envBool("PLAYWRIGHT_HEADED", false);
  const slowMo = Math.max(0, numberValue("PLAYWRIGHT_SLOWMO", 0));
  const holdMs = Math.max(0, numberValue("AITELIER_HOLD_MS", headed ? DEFAULT_HOLD_MS : 0));
  const browser = await chromium.launch({ headless: !headed, slowMo });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-DE", timezoneId: "Europe/Berlin" });
  let realPage;
  let mockPage;
  let real = { ok: false, reason: "Real-site checkout disabled." };
  try {
    const first = purchase.items[0];
    const realEnabled = envBool("AITELIER_SHOW_REAL_SITE", true);
    if (realEnabled && /^https?:\/\//i.test(first.product_url || "") && !first.product_url.startsWith(shopUrl)) {
      realPage = await context.newPage();
      realPage.setDefaultTimeout(20000);
      try {
        real = await realCheckoutPage(realPage, first, address, evidenceDir, signal);
        log.info("real checkout reached", { purchase: purchase.purchase_id, merchant: real.merchant, total: real.total });
      } catch (error) {
        if (signal?.aborted) throw error;
        real = { ok: false, reason: error.message };
        await screenshot(realPage, evidenceDir, "real-failure.png", { fullPage: false }).catch(() => {});
        log.warn("real checkout stopped", { purchase: purchase.purchase_id, reason: error.message });
      }
    }

    const mock = await createMockCheckout(shopUrl, purchase, real, address);
    if (mock.declined) return { status: "declined", detail: mock.declined };
    mockPage = await context.newPage();
    mockPage.setDefaultTimeout(20000);
    const paid = await payMock(mockPage, mock.url, address, evidenceDir);
    const receipt = {
      purchase_id: purchase.purchase_id,
      paid_at: new Date().toISOString(),
      currency: "EUR",
      amount: paid.total,
      merchant: mock.merchant,
      real_checkout: real,
      mock_checkout: {
        order_id: paid.orderId,
        payment_intent_id: paid.paymentIntentId,
        total: paid.total,
        card: paid.card,
        screenshots: paid.screenshots,
      },
      screenshots: [...(real.screenshots ?? []), ...paid.screenshots],
      stripe_mode: mode,
      issuing_card_id: envValue("STRIPE_ISSUING_CARD_ID", "") || null,
      issuing_cardholder_id: envValue("STRIPE_ISSUING_CARDHOLDER_ID", "") || null,
      address,
    };
    const receiptFile = path.join(evidenceDir, "receipt.json");
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    log.info("mock checkout paid", {
      purchase: purchase.purchase_id,
      order: paid.orderId,
      payment: paid.paymentIntentId,
      amount: paid.total,
      realReached: real.ok,
    });
    const realText = real.ok ? "real checkout reached payment" : `real checkout stopped: ${real.reason}`;
    return {
      status: "paid",
      txHash: paid.paymentIntentId,
      paidAmount: paid.total,
      paidCurrency: "EUR",
      mock: mode === "mock",
      detail: `${mode === "mock" ? "Mock" : "Stripe test"} payment ${paid.paymentIntentId}; order ${paid.orderId}; ${realText}; evidence ${relative(evidenceDir)}`,
    };
  } catch (error) {
    if (mockPage) await screenshot(mockPage, evidenceDir, "mock-failure.png", { fullPage: false }).catch(() => {});
    log.error("payment failed", { purchase: purchase.purchase_id, error: error.message });
    return { status: "failed", detail: error.message };
  } finally {
    if (holdMs && headed) await new Promise((resolve) => setTimeout(resolve, holdMs));
    await browser.close().catch(() => {});
  }
}

export default payOutfit;
