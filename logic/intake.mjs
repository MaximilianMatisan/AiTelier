// Step 1 · Auftrag lesen und prüfen. Turns a Sokosumi task description into the
// order logic/run-pipeline.mjs reads, or into the reasons it cannot.
//
//   node logic/intake.mjs --in task.txt                  print the order or the errors
//   node logic/intake.mjs --in task.txt --out order.json write the order for the pipeline
//   echo '{"budget_eur": 300, ...}' | node logic/intake.mjs
//
// Code checks, the LLM does not. Everything money depends on (budget, sizes,
// dates, a theme the catalogue can serve) is settled here, before the escrow
// is locked. An order that fails here costs the customer nothing.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Only what catalog/cache/products.json actually carries. A theme with no
// products guarantees a refund three steps later, so it is refused here.
export const THEMES = ["casual", "old_money", "streetwear"];
export const SEASONS = ["spring", "summer", "autumn", "winter"];
export const TOP_SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];

export const THEME_ALIASES = {
  casual: "casual", lassig: "casual", laessig: "casual", relaxed: "casual",
  old_money: "old_money", oldmoney: "old_money", preppy: "old_money", classic: "old_money",
  streetwear: "streetwear", street: "streetwear", urban: "streetwear",
};
export const SEASON_ALIASES = {
  spring: "spring", fruhling: "spring", fruehling: "spring",
  summer: "summer", sommer: "summer",
  autumn: "autumn", fall: "autumn", herbst: "autumn",
  winter: "winter",
};
export const GENDER_ALIASES = {
  men: "men", man: "men", male: "men", m: "men", herren: "men", herr: "men",
  women: "women", woman: "women", female: "women", w: "women", f: "women", damen: "women",
};

export const TEMPLATE = {
  budget_eur: 300,
  outfits: 2,
  theme: "old_money",
  season: "autumn",
  sizes: { top: "M", waist: "32", shoe_eu: "43" },
  fit: "slim",
  needed_by: "2026-11-06",
  owned: ["black slim jeans"],
  avoid: ["neon", "polyester"],
  gender: "men",
  climate: "Munich, wet, 8-15 C",
};

/** "Old Money", "old-money", "Lässig" -> "old_money", "old_money", "lassig". */
export function key(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** The first JSON object in the text: bare, in a ``` fence, or after a sentence. */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [text.trim(), fenced?.[1]?.trim()];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

function number(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value.replace(",", "."))))
    return Number(value.replace(",", "."));
  return NaN;
}

function strings(value, field, errors, { max = 20, length = 80 } = {}) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > max) errors.push(`${field} may hold at most ${max} entries.`);
  const out = [];
  for (const item of list.slice(0, max)) {
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${field} must contain only text.`);
      return [];
    }
    if (item.length > length) errors.push(`${field}: "${item.slice(0, 20)}…" is longer than ${length} characters.`);
    out.push(item.trim());
  }
  return out;
}

/**
 * Reads one Sokosumi task description.
 * Returns { ok: true, order, warnings } or { ok: false, errors, warnings }.
 * `today` is injectable so deadline checks are testable.
 */
export function readOrder(description, { today = new Date() } = {}) {
  const raw = extractJson(description);
  // {"brief": "..."} is a free-text order the Lead-Agent saved for the pipeline.
  const saved = raw && Object.keys(raw).length === 1 && typeof raw.brief === "string" ? raw.brief : null;
  if (!raw || saved !== null) {
    // Free text is a normal order: Person 2's filter reads it directly and picks
    // budget, style, season and sizes out of it. Only an empty brief is refused.
    const text = saved ?? (typeof description === "string" ? description : "");
    // Sokosumi descriptions sometimes arrive wrapped in a ``` fence.
    const brief = text.replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, "").trim();
    if (!brief)
      return { ok: false, errors: ["The task description is empty. Describe the outfits you would like."], warnings: [] };
    if (brief.length > 4000)
      return { ok: false, errors: ["The task description may be at most 4000 characters."], warnings: [] };
    return { ok: true, order: { brief }, warnings: [] };
  }
  const errors = [];
  const warnings = [];
  const order = {};

  const budget = number(raw.budget_eur ?? raw.budget);
  if (!Number.isFinite(budget) || budget <= 0) errors.push("budget_eur must be a positive number of euros.");
  else if (budget > 10000) errors.push("budget_eur may be at most 10000.");
  else order.budget_eur = Math.round(budget * 100) / 100;

  const outfits = number(raw.outfits ?? raw.outfit_count);
  if (!Number.isInteger(outfits) || outfits < 1 || outfits > 10) errors.push("outfits must be a whole number from 1 to 10.");
  else order.outfits = outfits;

  if (raw.item_count != null) {
    const items = number(raw.item_count);
    if (!Number.isInteger(items) || items < 1 || items > 40) errors.push("item_count must be a whole number from 1 to 40.");
    else if (order.outfits && items < order.outfits) errors.push("item_count must be at least the number of outfits.");
    else order.item_count = items;
  }

  const theme = raw.theme == null ? null : THEME_ALIASES[key(raw.theme)];
  if (raw.theme == null) errors.push(`theme is required: one of ${THEMES.join(", ")}.`);
  else if (!theme)
    errors.push(`theme "${raw.theme}" has no products in the catalogue. Choose one of ${THEMES.join(", ")}.`);
  else order.theme = theme;

  const season = raw.season == null ? null : SEASON_ALIASES[key(raw.season)];
  if (!season) errors.push(`season must be one of ${SEASONS.join(", ")}.`);
  else order.season = season;

  const sizes = raw.sizes;
  if (!sizes || typeof sizes !== "object" || Array.isArray(sizes)) {
    errors.push("sizes is required, with top, waist and shoe_eu: a top, a bottom and shoes make one outfit.");
  } else {
    order.sizes = {};
    const top = String(sizes.top ?? "").trim().toUpperCase();
    if (!TOP_SIZES.includes(top)) errors.push(`sizes.top must be one of ${TOP_SIZES.join(", ")}.`);
    else order.sizes.top = top;

    const waist = number(sizes.waist);
    if (!Number.isInteger(waist) || waist < 24 || waist > 50) errors.push("sizes.waist must be a waist size in inches, 24 to 50.");
    else order.sizes.waist = String(waist);

    const shoe = number(sizes.shoe_eu ?? sizes.shoes);
    if (!Number.isFinite(shoe) || shoe < 34 || shoe > 50 || (shoe * 2) % 1 !== 0)
      errors.push("sizes.shoe_eu must be an EU shoe size, 34 to 50, in whole or half sizes.");
    else order.sizes.shoe_eu = String(shoe);
  }

  if (raw.fit != null) {
    if (typeof raw.fit !== "string" || !raw.fit.trim() || raw.fit.length > 40) errors.push("fit must be a short text, at most 40 characters.");
    else order.fit = raw.fit.trim().toLowerCase();
  }

  if (raw.needed_by != null) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw.needed_by));
    const date = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    const valid = date && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (!valid) errors.push("needed_by must be a date written as YYYY-MM-DD.");
    else if (date < start) errors.push(`needed_by ${raw.needed_by} is already in the past.`);
    else order.needed_by = String(raw.needed_by);
  }

  const owned = strings(raw.owned, "owned", errors);
  if (owned.length) order.owned = owned;
  const avoid = strings(raw.avoid, "avoid", errors);
  if (avoid.length) order.avoid = avoid;

  if (raw.gender != null) {
    const gender = GENDER_ALIASES[key(raw.gender)];
    if (!gender) errors.push("gender must be men or women.");
    else order.gender = gender;
  }

  if (raw.climate != null) {
    if (typeof raw.climate !== "string" || raw.climate.length > 80) errors.push("climate must be a short text, at most 80 characters.");
    else order.climate = raw.climate.trim();
  }

  const known = new Set([...Object.keys(TEMPLATE), "budget", "outfit_count", "item_count"]);
  const ignored = Object.keys(raw).filter((k) => !known.has(k));
  if (ignored.length) warnings.push(`Ignored unknown fields: ${ignored.join(", ")}.`);

  return errors.length ? { ok: false, errors, warnings } : { ok: true, order, warnings };
}

/**
 * How to write an order, in the customer's own words. One copy, read by the
 * form they fill in before submitting (agent-api.mjs), by the greeting the
 * worker posts when it picks a Task up, and by the refusal when an order
 * cannot be filled, so the three can never drift apart.
 */
export const ORDER_EXAMPLE = [
  "Two autumn outfits, old money style.",
  "Budget 400 EUR in total.",
  "Top M, waist 32, shoes EU 43.",
  "I already own black slim jeans. Avoid neon.",
].join("\n");

/** One paragraph, for a form field where newlines may be collapsed. */
export const HOW_TO_ORDER =
  "Describe the outfits you want in plain words, and include your sizes: top (S, M, L), " +
  "waist in inches, shoes in EU. Add your budget in EUR, how many outfits, the style and " +
  "the season. Sizes are the one thing AiTelier will not guess.";

/**
 * The first thing the customer reads, posted before any payment is requested.
 * It says what they are about to buy, what they are not charged for, and shows
 * the shape of an order they can copy.
 */
export function welcome() {
  return [
    "## AiTelier",
    "",
    "I build complete outfits out of garments that are really in stock in European shops,",
    "and I check every one of them before you are asked for anything.",
    "",
    "**You pay only if all five guarantees hold:** it fits your budget, it comes in your",
    "size, the shop still has it, the price matches the quote, and it arrives in time.",
    "If any one of them fails I submit no result at all, and the escrow returns your money.",
    "",
    "### How to write your order",
    "",
    HOW_TO_ORDER,
    "",
    "Copy this and change the values:",
    "",
    "```",
    ORDER_EXAMPLE,
    "```",
    "",
    "A structured JSON order works too: send the same facts as an object.",
  ].join("\n");
}

// A free-text brief is accepted as an order, but the pipeline still has to know
// what to buy and in which size. Without a size Person 2's filter invents one
// and the customer pays for clothes that do not fit; with no garment or style
// named at all ("shopping") it is not a clothing order in the first place.
// Both are decided here so the answer arrives before the escrow is requested.
const LETTER_SIZE =
  /\b(?:xxs|xs|s|m|l|xl|xxl|xxxl|small|medium|large|extra\s?large)\b/i;
const NUMERIC_SIZE =
  /\b(?:waist|taille|bundweite|w|shoes?|schuhe?|schuhgr[oö]ss?e|eu|feet|foot|size|gr[oö]ss?e|talla)\s*(?:size\s*|eu\s*)?\d{2}(?:[.,]5)?\b/i;
const GARMENT_OR_STYLE =
  /\b(?:outfits?|looks?|wardrobe|garderobe|clothes|clothing|kleidung|shirts?|t-?shirts?|tops?|trousers|pants|jeans|chinos|shorts|skirts?|dress(?:es)?|jackets?|coats?|blazers?|knitwear|sweaters?|jumpers?|hoodies?|shoes|sneakers|boots|loafers|suits?|styl(?:e|ing)|aesthetic|streetwear|old\s?money|preppy|casual|minimal|smart|formal|business)\b/i;

/** Does the brief name a size we can shop with? */
export function namesSize(brief) {
  return LETTER_SIZE.test(brief) || NUMERIC_SIZE.test(brief);
}

/** Does the brief name a garment, a style or anything we could dress someone in? */
export function namesGarment(brief) {
  return GARMENT_OR_STYLE.test(brief);
}

/**
 * The decision taken before any money is requested:
 *   proceed · the order can be filled
 *   ask     · it is a clothing order but something we must not guess is missing
 *   refuse  · it cannot be filled at all
 * `message` is what the customer reads in either case. Nothing is charged for
 * an `ask` or a `refuse`, because the escrow has not been requested yet.
 */
export function reviewOrder(description, options = {}) {
  const intake = readOrder(description, options);
  if (!intake.ok)
    return { action: "refuse", message: refusal(intake), reasons: intake.errors, intake };
  const brief = intake.order.brief;
  if (!brief) return { action: "proceed", intake };
  if (!namesGarment(brief))
    return {
      action: "refuse",
      reasons: ["The description names no garment, style or outfit."],
      message: [
        "AiTelier could not start this order. Nothing was charged.",
        "",
        `This task asks for "${brief.slice(0, 80)}", which does not describe clothing.`,
        "AiTelier builds outfits from real garments in real shops, so it needs to know",
        "what to dress you in.",
        "",
        'Try: "Two autumn outfits, old money style, budget 400 EUR, top M, waist 32, shoes EU 43."',
      ].join("\n"),
      intake,
    };
  if (!namesSize(brief))
    return {
      action: "ask",
      reasons: ["The description names no size."],
      message: [
        "AiTelier needs your sizes before it can request payment. Nothing was charged.",
        "",
        "Guessing a size is the one thing it will not do: the shops sell single",
        "garments, and a wrong size is a return, not an outfit.",
        "",
        "Please add:",
        "- top size, for example S, M or L",
        "- waist in inches, for example 32",
        "- shoe size in EU, for example 43",
        "",
        "So the whole order reads like this:",
        "",
        "```",
        ORDER_EXAMPLE,
        "```",
        "",
        "Start the order again with your sizes included and it will run straight through.",
      ].join("\n"),
      intake,
    };
  return { action: "proceed", intake };
}

/** What the customer reads in Sokosumi when the order is refused. */
export function refusal({ errors, warnings = [] }) {
  return [
    "AiTelier could not start this order. Nothing was charged for the styling.",
    "",
    ...errors.map((e) => `- ${e}`),
    ...warnings.map((w) => `- Note: ${w}`),
    "",
    "Describe your order in plain words, for example:",
    "",
    "```",
    ORDER_EXAMPLE,
    "```",
    "",
    "Or send it as JSON:",
    "",
    "```json",
    JSON.stringify(TEMPLATE, null, 2),
    "```",
  ].join("\n");
}

async function main() {
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const input = flag("--in");
  let text = "";
  if (input) text = await readFile(input, "utf8");
  else for await (const chunk of process.stdin) text += chunk;

  const result = readOrder(text);
  for (const w of result.warnings) console.error(`warning: ${w}`);
  if (!result.ok) {
    console.error(refusal(result));
    process.exitCode = 1;
    return;
  }
  const json = JSON.stringify(result.order, null, 2) + "\n";
  const out = flag("--out");
  if (out) {
    await writeFile(out, json);
    console.error(`wrote ${out}`);
  } else process.stdout.write(json);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
