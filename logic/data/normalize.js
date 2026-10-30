// Maps a Shopify /products.json product onto the agreed item schema (Frame 16).
// Person 2 and 3: the tables below are the tuning surface. Change keywords here, not the mapper.

export const SIZE_OPTION_NAMES = ["size", "größe", "groesse", "grosse", "taille", "talla", "shoe size", "eu size"];

// Checked first: these never become clothing, even when they contain a category keyword
// ("Shoe Care Kit" would otherwise land in `shoes`).
export const NOT_APPAREL = [
  "gift card", "giftcard", "gift certificate", "voucher", "e-card",
  "care kit", "cleaning", "shoe tree", "shoe horn", "laces", "insole", "protector spray",
  "mug", "cup", "bottle", "candle", "sticker", "poster", "book", "magazine", "keyring",
  "fragrance", "perfume", "soap", "towel", "blanket", "cushion", "bag", "backpack", "wallet",
  "cap", "beanie", "hat", "scarf", "glove", "belt", "sock", "sunglasses", "jewel", "necklace",
];

export const CATEGORY_KEYWORDS = {
  // order matters: first match wins, so the more specific groups come first
  shoes: ["loafer", "sneaker", "trainer", "shoe", "schuh", "boot", "stiefel", "derby", "brogue", "mocassin", "sandal"],
  outer: ["coat", "mantel", "jacket", "jacke", "blazer", "parka", "anorak", "trench", "overcoat", "puffer"],
  bottom: ["trouser", "hose", "chino", "jeans", "pant", "short", "skirt", "rock", "denim"],
  top: ["shirt", "hemd", "oxford", "polo", "sweater", "pullover", "knit", "strick", "cardigan", "t-shirt", "tee", "roll-neck", "turtleneck", "jumper", "hoodie", "sweat", "top", "blouse", "vest"],
};

export const THEME_KEYWORDS = {
  old_money: ["cashmere", "merino", "wool", "lambswool", "tweed", "oxford", "loafer", "cable", "chino", "blazer", "camel", "polo", "cardigan", "corduroy", "flannel", "herringbone", "knit", "trench", "pleated", "tailored", "linen", "suede", "mohair"],
  streetwear: ["hoodie", "cargo", "oversized", "graphic", "sneaker", "track", "baggy", "logo", "puffer", "jordan", "dunk", "varsity"],
};

export const SEASON_KEYWORDS = {
  cold: ["wool", "cashmere", "merino", "lambswool", "knit", "cardigan", "coat", "boot", "fleece", "puffer", "parka", "corduroy", "flannel", "tweed", "down", "quilted", "thermal", "mohair"],
  warm: ["linen", "short", "sandal", "tank", "swim", "poplin", "seersucker", "mesh"],
};

const ALL_SEASONS = ["spring", "summer", "autumn", "winter"];

const LETTER_SIZES = {
  "one size": "ONE", onesize: "ONE", os: "ONE", uni: "ONE", universal: "ONE", "no size": "ONE",
  xxs: "XXS", "xx-small": "XXS", "2xs": "XXS",
  xs: "XS", "x-small": "XS", "extra small": "XS",
  s: "S", small: "S",
  m: "M", medium: "M",
  l: "L", large: "L",
  xl: "XL", "x-large": "XL", "extra large": "XL",
  xxl: "XXL", "xx-large": "XXL", "2xl": "XXL",
};

/** "Medium" -> "M", "EU 43 1/3" -> "43", "W32" -> "32". Unparseable values are kept as-is. */
export function normalizeSize(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "ONE";
  const lower = s.toLowerCase();
  if (LETTER_SIZES[lower]) return LETTER_SIZES[lower];
  const num = lower.match(/\d+(?:[.,]\d+)?/);
  if (num) return num[0].replace(",", ".").replace(/\.0$/, "");
  return s.toUpperCase();
}

/** Category may use tags: they carry useful "Category:Oberteile" style hints. */
function categoryText(product) {
  const tags = Array.isArray(product.tags)
    ? product.tags
    : String(product.tags ?? "").split(",");
  return [product.title, product.product_type, ...tags].join(" ").toLowerCase();
}

/**
 * Themes and seasons must NOT use tags. Shops mix customs and logistics junk in
 * there - asphaltgold tags every jersey tee "knitted or crocheted" (HS code),
 * which made Nike t-shirts read as old_money.
 */
function styleText(product) {
  return [product.title, product.product_type].join(" ").toLowerCase();
}

export function categoryOf(text) {
  if (NOT_APPAREL.some((w) => text.includes(w))) return null;
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) return category;
  }
  return null;
}

export function themesOf(text) {
  const themes = Object.entries(THEME_KEYWORDS)
    .filter(([, words]) => words.some((w) => text.includes(w)))
    .map(([theme]) => theme);
  return themes.length ? themes : ["casual"];
}

export function seasonsOf(text) {
  const cold = SEASON_KEYWORDS.cold.some((w) => text.includes(w));
  const warm = SEASON_KEYWORDS.warm.some((w) => text.includes(w));
  if (cold && !warm) return ["autumn", "winter"];
  if (warm && !cold) return ["spring", "summer"];
  return [...ALL_SEASONS];
}

/**
 * Which option holds the size, or -1 for one-size products.
 * `options` is objects in /products.json but can be plain strings in /products/{handle}.js,
 * so refetch can share this.
 */
export function sizeIndexOf(options) {
  return (options ?? []).findIndex((o) =>
    SIZE_OPTION_NAMES.includes(String(typeof o === "string" ? o : o?.name ?? "").trim().toLowerCase())
  );
}

/**
 * One Shopify product -> one item, or null when it is not clothing we can use.
 * Items with no buyable variant are dropped: every item in the cache is in stock
 * in at least one size, so guarantee 2 can only fail on the customer's size.
 */
export function normalizeProduct(product, shop, fetchedAt = new Date().toISOString()) {
  const category = categoryOf(categoryText(product));
  if (!category) return null;
  const style = styleText(product);

  const idx = sizeIndexOf(product.options);
  const stock = {};
  const variants = {};
  const prices = {}; // size -> cheapest available price, so `variants` and `price_eur` agree

  for (const v of product.variants ?? []) {
    const size = idx === -1 ? "ONE" : normalizeSize(v[`option${idx + 1}`]);
    const price = Number(v.price);
    // A 0.00 variant is a free gift or a placeholder, not something to budget for.
    if (!Number.isFinite(price) || price <= 0) continue;

    if (!(size in stock)) stock[size] = 0;
    if (!v.available) continue;

    stock[size] = 1;
    if (prices[size] === undefined || price < prices[size]) {
      prices[size] = price;
      variants[size] = v.id;
    }
  }

  const available = Object.values(prices);
  if (!available.length) return null;

  return {
    id: `${shop.id}-${product.id}`,
    shop_id: shop.id,
    name: String(product.title ?? "").trim(),
    vendor: product.vendor ?? shop.name,
    category,
    themes: themesOf(style),
    seasons: seasonsOf(style),
    price_eur: Math.min(...available),
    stock,
    stock_kind: "boolean",
    variants,
    delivery_days: shop.default_delivery_days,
    url: `https://${shop.domain}/products/${product.handle}`,
    image: product.images?.[0]?.src ?? null,
    source: { type: "shopify_products_json", handle: product.handle, fetched_at: fetchedAt },
  };
}
