// Maps a Shopify /products.json product onto the agreed item schema (Frame 16).
// Person 2 and 3: the tables below are the tuning surface. Change keywords here, not the mapper.

/**
 * Words that make an option a size option. Matched as whole words inside the
 * option name, not by equality: shops label the same thing "Size",
 * "Damen Bekleidung Größe", "Tamanhos" or "Classic Boxer Briefs (Size)".
 * Exact matching filed 272 pairs of jeans under "ONE" because armedangels
 * calls the option "Waist".
 */
export const SIZE_OPTION_WORDS = [
  "size", "sizes", "größe", "grösse", "groesse", "grosse", "waist",
  "taille", "talla", "tallas", "tamanho", "tamanhos", "taglia", "maat",
  "storlek", "størrelse", "koko",
];

/** Kept for callers that still import the old name. */
export const SIZE_OPTION_NAMES = SIZE_OPTION_WORDS;

// "Title" is Shopify's option name for a product with no real options, and
// "Length" is the second half of a waist/length pair, never the size itself.
const NOT_A_SIZE_OPTION = new Set(["title", "length", "inseam", "leg", "color", "colour", "farbe"]);

const sizeWord = new RegExp(`(?:^|[^a-zà-ÿ])(?:${SIZE_OPTION_WORDS.join("|")})(?:[^a-zà-ÿ]|$)`, "i");

/** Does this Shopify option name denote a size? */
export function isSizeOption(name) {
  const text = String(name ?? "").trim().toLowerCase();
  if (!text || NOT_A_SIZE_OPTION.has(text)) return false;
  return sizeWord.test(text);
}

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
  shoes: ["loafer", "sneaker", "trainer", "shoe", "schuh", "boot", "stiefel", "derby", "brogue", "mocassin", "sandal", "flip flop", "espadrille"],
  outer: ["coat", "mantel", "jacket", "jacke", "blazer", "parka", "anorak", "trench", "overcoat", "puffer", "abrigo"],
  bottom: ["trouser", "hose", "chino", "jeans", "pant", "short", "skirt", "rock", "denim"],
  top: ["shirt", "hemd", "oxford", "polo", "sweater", "pullover", "knit", "strick", "cardigan", "t-shirt", "tee", "roll-neck", "turtleneck", "jumper", "hoodie", "sweat", "top", "blouse", "vest", "sleeve"],
};

/**
 * Keywords that must appear as whole words. Most match as substrings so German
 * compounds still work ("Strickpullover" -> strick), but these are short enough
 * to collide inside unrelated words and did: "short" matched the tag
 * "style:Shortsleeves" and turned 600+ t-shirts into trousers, "boot" matched
 * "Jeans Boot Cut", and "top" matched the brand name in "Top Senses Flip Flops".
 */
const WHOLE_WORD_ONLY = new Set(["short", "top", "boot", "rock", "tee", "cap"]);

/** Phrases that decide the category outright, ahead of the keyword groups. */
const CATEGORY_PHRASES = [
  [/boot[- ]?cut|bootleg/, "bottom"], // a trouser cut, not footwear
  // "short" is a whole word in "Short sleeve shirt", which filed 113 t-shirts
  // as trousers. A sleeve belongs to a top whatever its length.
  [/\b(?:short|long|half|three[- ]quarter)[- ]?sleeve/, "top"],
];

const matchers = new Map();
function matches(text, word) {
  if (!WHOLE_WORD_ONLY.has(word)) return text.includes(word);
  if (!matchers.has(word)) matchers.set(word, new RegExp(`(?:^|[^a-z])${word}s?(?:[^a-z]|$)`));
  return matchers.get(word).test(text);
}

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

/**
 * The labels a customer can ask for to get this variant. Usually one, but
 * shops sell a single garment as "S/M" or "M/L", and a customer asking for M
 * can wear either. 254 items carry such a label; without this they match no
 * size at all. A numeric "32/34" is a waist and a leg length, not two sizes,
 * so only letter pairs expand.
 */
export function sizeLabels(raw) {
  const text = String(raw ?? "").trim();
  const pair = text.match(/^([A-Za-z]{1,4})\s*\/\s*([A-Za-z]{1,4})$/);
  if (!pair) return [normalizeSize(text)];
  const [a, b] = [normalizeSize(pair[1]), normalizeSize(pair[2])];
  return a === b ? [a] : [a, b];
}

/**
 * Men's waist in inches against the letter size the same trouser carries in
 * shops that label by letter. Bottoms split almost evenly between the two
 * systems - 894 waist-sized against 713 letter-sized - so a customer who
 * states a waist reaches only a third of the trousers without this.
 *
 * It is an inference and it varies by brand, so it never enters the catalogue:
 * `stock` keeps the labels the shop published. It translates what the
 * *customer* asked for into the label the shops in front of them use, which is
 * what a person does when they shop.
 */
export const WAIST_TO_LETTER = {
  28: "XS", 29: "XS", 30: "S", 31: "S", 32: "M", 33: "M",
  34: "L", 35: "L", 36: "XL", 37: "XL", 38: "XXL", 40: "XXL",
};

/** Every label that means the same size as `label`, the label itself first. */
export function equivalentSizes(label) {
  const size = normalizeSize(label);
  const letter = WAIST_TO_LETTER[Number(size)];
  if (letter) return [size, letter];
  const waists = Object.entries(WAIST_TO_LETTER)
    .filter(([, value]) => value === size)
    .map(([waist]) => waist);
  return waists.length ? [size, ...waists] : [size];
}

/**
 * What the shop itself calls the product. Themes and seasons use only this -
 * shops mix customs and logistics junk into tags, and asphaltgold tags every
 * jersey tee "knitted or crocheted" (an HS code), which made Nike t-shirts read
 * as old_money.
 */
function styleText(product) {
  return [product.title, product.product_type].join(" ").toLowerCase();
}

/** Tags, as a fallback for category only: they carry "Category:Oberteile" hints. */
function tagText(product) {
  const tags = Array.isArray(product.tags)
    ? product.tags
    : String(product.tags ?? "").split(",");
  return tags.join(" ").toLowerCase();
}

/**
 * Tags are the last resort, as they are for themes. "Not Listening T-Shirt" has
 * product_type "T-Shirts" and would classify correctly from that alone; it only
 * went wrong because a tag was thrown into the same bag.
 */
export function categoryOf(primary, tagText = "") {
  for (const text of [primary, tagText]) {
    if (!text) continue;
    if (NOT_APPAREL.some((w) => matches(text, w))) return null;
    for (const [pattern, category] of CATEGORY_PHRASES) {
      if (pattern.test(text)) return category;
    }
    for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
      if (words.some((w) => matches(text, w))) return category;
    }
  }
  return null;
}

export function themesOf(text) {
  const themes = Object.entries(THEME_KEYWORDS)
    .filter(([, words]) => words.some((w) => matches(text, w)))
    .map(([theme]) => theme);
  return themes.length ? themes : ["casual"];
}

export function seasonsOf(text) {
  const cold = SEASON_KEYWORDS.cold.some((w) => matches(text, w));
  const warm = SEASON_KEYWORDS.warm.some((w) => matches(text, w));
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
    isSizeOption(typeof o === "string" ? o : o?.name)
  );
}

/**
 * Shopify body_html -> plain text. The catalogue keeps the full text; each
 * consumer caps it to whatever its own contract allows.
 */
export function plainText(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * One Shopify product -> one item, or null when it is not clothing we can use.
 * Items with no buyable variant are dropped: every item in the cache is in stock
 * in at least one size, so guarantee 2 can only fail on the customer's size.
 */
export function normalizeProduct(product, shop, fetchedAt = new Date().toISOString()) {
  const style = styleText(product);
  const category = categoryOf(style, tagText(product));
  if (!category) return null;

  const idx = sizeIndexOf(product.options);
  const stock = {};
  const variants = {};
  const prices = {}; // size -> cheapest available price, so `variants` and `price_eur` agree

  for (const v of product.variants ?? []) {
    const labels = idx === -1 ? ["ONE"] : sizeLabels(v[`option${idx + 1}`]);
    const price = Number(v.price);
    // A 0.00 variant is a free gift or a placeholder, not something to budget for.
    if (!Number.isFinite(price) || price <= 0) continue;

    for (const size of labels) {
      if (!(size in stock)) stock[size] = 0;
      if (!v.available) continue;

      stock[size] = 1;
      if (prices[size] === undefined || price < prices[size]) {
        prices[size] = price;
        variants[size] = v.id;
      }
    }
  }

  const available = Object.values(prices);
  if (!available.length) return null;

  return {
    id: `${shop.id}-${product.id}`,
    shop_id: shop.id,
    name: String(product.title ?? "").trim(),
    vendor: product.vendor ?? shop.name,
    description: plainText(product.body_html),
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
