import { purchaseFromOutfit } from "../logic/checkout.mjs";
import { payOutfit } from "../logic/pay-stripe.mjs";
import { startShop } from "../mock-shop/server.mjs";

const SHOP_URL = (process.env.AITELIER_SHOP_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const REAL_URL = process.env.AITELIER_DEMO_PRODUCT_URL || "https://thokkthokk.com/products/tt118-polo-shirt-pique";
const IMAGE_URL = process.env.AITELIER_DEMO_IMAGE_URL || "https://cdn.shopify.com/s/files/1/0698/4781/0315/files/PREORDER--TT118-Polo-Shirt-PIQUe-5749_18.jpg?v=1747232047";

async function shopIsRunning() {
  try {
    const response = await fetch(`${SHOP_URL}/health`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

let shop;
if (!(await shopIsRunning())) {
  const url = new URL(SHOP_URL);
  shop = await startShop({ port: Number(url.port || 3100), host: url.hostname });
  console.log(`Started mock shop at ${shop.url}`);
}

const outfit = {
  outfit_id: "demo-look",
  name: "ThokkThokk Polo Demo",
  items: [
    {
      item_id: "thokkthokk-8229184798987",
      title: "TT118 Polo Shirt PIQUÉ (GOTS)",
      brand: "ThokkThokk",
      size: "M",
      price: 12,
      currency: "EUR",
      product_url: REAL_URL,
      image_url: IMAGE_URL,
    },
  ],
  total: 16.9,
  shipping: 4.9,
  currency: "EUR",
  guaranteed: true,
};

const purchase = purchaseFromOutfit(outfit, {
  conversationId: `demo-${Date.now()}`,
  budget_eur: 30,
});

console.log("Starting two-phase purchase:", purchase.purchase_id);
console.log("Real checkout:", REAL_URL);
console.log("Mock checkout:", SHOP_URL);
console.log("Browser:", process.env.PLAYWRIGHT_HEADED === "true" ? "headed" : "headless");

const outcome = await payOutfit(purchase);
console.log("Outcome:", JSON.stringify(outcome, null, 2));

if (shop) await new Promise((resolve) => shop.server.close(resolve));
if (outcome.status !== "paid") process.exitCode = 1;
