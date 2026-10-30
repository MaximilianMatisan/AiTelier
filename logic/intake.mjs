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

const THEME_ALIASES = {
  casual: "casual", lassig: "casual", laessig: "casual", relaxed: "casual",
  old_money: "old_money", oldmoney: "old_money", preppy: "old_money", classic: "old_money",
  streetwear: "streetwear", street: "streetwear", urban: "streetwear",
};
const SEASON_ALIASES = {
  spring: "spring", fruhling: "spring", fruehling: "spring",
  summer: "summer", sommer: "summer",
  autumn: "autumn", fall: "autumn", herbst: "autumn",
  winter: "winter",
};
const GENDER_ALIASES = {
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
function key(value) {
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
  if (!raw) {
    // Free text is a normal order: Person 2's filter reads it directly and picks
    // budget, style, season and sizes out of it. Only an empty brief is refused.
    const brief = typeof description === "string" ? description.trim() : "";
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

/** What the customer reads in Sokosumi when the order is refused. */
export function refusal({ errors, warnings = [] }) {
  return [
    "AiTelier could not start this order. Nothing was charged for the styling.",
    "",
    ...errors.map((e) => `- ${e}`),
    ...warnings.map((w) => `- Note: ${w}`),
    "",
    "Describe your order in plain words, for example: \"Two autumn outfits, old money style,",
    "budget 400 EUR, top M, waist 32, shoes EU 43.\" Or send it as JSON:",
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
