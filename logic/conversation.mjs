// Step 0 · the conversation. A customer talks to AiTelier over several turns:
// the agent collects what an order needs, runs the pipeline, shows the looks it
// found, and takes one explicit confirmation before any money moves.
//
// Surface-agnostic on purpose. comments.mjs drives it from Sokosumi task
// comments and ui/server.mjs from the studio page, and both keep the same
// state. Nothing here touches the network or the disk: a turn returns the new
// state, what the customer reads, and the one `action` the caller must perform
// (run the pipeline, pay for an outfit). That makes the dialogue testable
// without a model, a worker or a wallet.
//
// The LLM decides, the code checks — the same split as the rest of the agent:
//
//   - a model may read a message and propose slots, and may write the wording
//     while the order is still being collected;
//   - every slot it proposes goes through the validators a typed order goes
//     through, and the order itself through logic/intake.mjs;
//   - what a customer is told about products, prices and totals is written by
//     code from Person 3's result, never by a model;
//   - "yes" is read by code (`detectIntent`). No purchase depends on a model
//     reading a confirmation.
import { z } from "zod";
import {
  THEMES,
  SEASONS,
  TOP_SIZES,
  THEME_ALIASES,
  SEASON_ALIASES,
  GENDER_ALIASES,
  key,
  readOrder,
  extractJson,
} from "./intake.mjs";
import { logger } from "../log.mjs";
const log = logger("conversation");

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_MESSAGES = 60;
// Asking for seven things at once reads like a form, not a conversation.
const MAX_ASKS = 3;

/** What an order cannot start without, in the order the agent asks for it. */
export const REQUIRED = [
  ["budget_eur", "your budget in euros — each outfit has to fit in it"],
  ["outfits", "how many outfits you would like"],
  ["theme", `the style you want: ${THEMES.join(", ")}`],
  ["season", `the season: ${SEASONS.join(", ")}`],
  ["sizes.top", `your top size (${TOP_SIZES.join(", ")})`],
  ["sizes.waist", "your waist size in inches"],
  ["sizes.shoe_eu", "your shoe size, EU"],
];

/**
 * collecting  still missing something an order needs
 * ready       the order is complete and waiting for a go-ahead
 * styling     the pipeline is running for this conversation
 * presented   looks are on the table, waiting for a choice
 * selected    one look is chosen, waiting for the purchase confirmation
 * paying      the payment module has the purchase
 * paid        the purchase went through
 */
export const STATUSES = ["collecting", "ready", "styling", "presented", "selected", "paying", "paid"];

export function newConversation(id = "chat") {
  return {
    id: String(id),
    status: "collecting",
    draft: {},
    messages: [],
    run: null,
    outfits: [],
    selection: null,
    checkout: null,
  };
}

function get(draft, path) {
  return path.split(".").reduce((value, part) => (value == null ? value : value[part]), draft);
}

function set(draft, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let target = draft;
  for (const part of parts) target = target[part] ??= {};
  target[last] = value;
}

/** The slots an order still needs, as REQUIRED names them. */
export function missing(draft) {
  return REQUIRED.filter(([path]) => get(draft, path) == null || get(draft, path) === "");
}

/** Adds one line to the transcript; the surfaces use it for their own notes. */
export function appendMessage(state, role, text) {
  return say(state, role, text);
}

function say(state, role, text) {
  state.messages = [...state.messages, { role, text, at: new Date().toISOString() }].slice(-MAX_MESSAGES);
  return state;
}

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  ein: 1, eine: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6,
};

/** A sentence as the plain words intake's vocabularies are keyed by. */
function words(text) {
  return key(text).replace(/_/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The first vocabulary entry a sentence contains. Pairs are tried before single
 * words, so "old money" finds old_money where neither word alone would.
 */
function word(text, map) {
  const list = words(text);
  for (let i = 0; i < list.length; i++) {
    const [one, two] = [list[i], list[i + 1]];
    if (two && map[`${one}_${two}`] != null) return map[`${one}_${two}`];
    if (two && map[`${one}${two}`] != null) return map[`${one}${two}`];
    if (map[one] != null) return map[one];
  }
  return undefined;
}

const HALF = (value) => Number(String(value).replace(",", "."));

/**
 * What a message says about the order, read by code alone: budget, counts,
 * style, season, sizes. A cue word is required for every size, so "M" in
 * "Munich" or a waist in "32 degrees" is not mistaken for one.
 */
export function extractSlots(text) {
  const out = {};
  const source = typeof text === "string" ? text : "";
  const lower = source.toLowerCase();

  const budget = lower.match(/(\d{2,5})(?:[.,]\d{1,2})?\s*(?:€|eur\b|euro)/) ??
    lower.match(/(?:budget|spend|ausgeben|zahlen)[^0-9]{0,16}(\d{2,5})/);
  if (budget) out.budget_eur = Number(budget[1]);

  const outfits = lower.match(/(\d{1,2})\s*(?:outfits?|looks?|kombinationen?)/) ??
    lower.match(/(?:outfits?|looks?)\D{0,8}(\d{1,2})\b/);
  if (outfits) out.outfits = Number(outfits[1]);
  else {
    const spelled = /(?:outfits?|looks?)/.test(lower) ? word(source, NUMBER_WORDS) : undefined;
    if (spelled) out.outfits = spelled;
  }

  const theme = word(source, THEME_ALIASES);
  if (theme) out.theme = theme;
  const season = word(source, SEASON_ALIASES);
  if (season) out.season = season;

  // Single letters are left out: "m" is a top size far more often than "men".
  const gender = word(source, Object.fromEntries(Object.entries(GENDER_ALIASES).filter(([k]) => k.length > 1)));
  if (gender) out.gender = gender;

  const top = source.match(/(?:gr(?:ö|oe|o)(?:ss|ß)e|size|top|oberteil|shirt|tops)\s*:?\s*(XXXL|XXL|XL|XXS|XS|[SML])\b/i);
  if (top) out.sizes = { ...out.sizes, top: top[1].toUpperCase() };

  const waist = lower.match(/(?:waist|bund|hose|hosen\w*|trousers?|jeans)\D{0,10}(\d{2})\b/) ?? lower.match(/\bw\s?(\d{2})\b/);
  if (waist && Number(waist[1]) >= 24 && Number(waist[1]) <= 50) out.sizes = { ...out.sizes, waist: waist[1] };

  const shoe = lower.match(/(?:schuh\w*|shoes?|sneaker\w*|\beu)\D{0,10}(\d{2}(?:[.,]5)?)/);
  if (shoe && HALF(shoe[1]) >= 34 && HALF(shoe[1]) <= 50) out.sizes = { ...out.sizes, shoe_eu: String(HALF(shoe[1])) };

  const fit = lower.match(/\b(slim|regular|relaxed|oversized?|loose|tailored)\b/);
  if (fit) out.fit = fit[1];

  const needed = source.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (needed) out.needed_by = needed[1];

  const avoid = source.match(/(?:avoid|without|ohne|kein[e]?|nichts? mit)\s+([\p{L}\d ,&/-]{2,60})/iu);
  if (avoid)
    out.avoid = avoid[1]
      .split(/,| und | and |\//)
      .map((part) => part.trim())
      .filter((part) => part.length > 1 && part.length <= 40)
      .slice(0, 6);

  return out;
}

/**
 * Folds proposed slots into the draft, keeping only values a typed order could
 * carry. Returns the slots that were taken and the ones that were refused, so
 * the customer can be told that "punk" is not a style this catalogue has.
 */
export function mergeSlots(draft, updates) {
  const next = structuredClone(draft ?? {});
  const taken = [];
  const rejected = [];
  const keep = (path, value) => {
    set(next, path, value);
    taken.push(path);
  };

  for (const [field, value] of Object.entries(updates ?? {})) {
    if (value == null) continue;
    switch (field) {
      case "budget_eur": {
        const amount = Number(value);
        if (Number.isFinite(amount) && amount > 0 && amount <= 10000) keep("budget_eur", Math.round(amount * 100) / 100);
        else rejected.push("A budget has to be between 1 and 10000 euros.");
        break;
      }
      case "outfits": {
        const count = Number(value);
        if (Number.isInteger(count) && count >= 1 && count <= 10) keep("outfits", count);
        else rejected.push("The number of outfits has to be a whole number from 1 to 10.");
        break;
      }
      case "theme": {
        const theme = THEME_ALIASES[key(value)];
        if (theme) keep("theme", theme);
        else rejected.push(`There are no products for "${String(value).slice(0, 24)}" in the catalogue. Pick one of ${THEMES.join(", ")}.`);
        break;
      }
      case "season": {
        const season = SEASON_ALIASES[key(value)];
        if (season) keep("season", season);
        else rejected.push(`The season has to be one of ${SEASONS.join(", ")}.`);
        break;
      }
      case "gender": {
        const gender = GENDER_ALIASES[key(value)];
        if (gender) keep("gender", gender);
        else rejected.push("The collection has to be men or women.");
        break;
      }
      case "fit":
        if (typeof value === "string" && value.trim() && value.length <= 40) keep("fit", value.trim().toLowerCase());
        break;
      case "climate":
        if (typeof value === "string" && value.trim() && value.length <= 80) keep("climate", value.trim());
        break;
      case "needed_by":
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) keep("needed_by", String(value));
        else rejected.push("A date has to be written as YYYY-MM-DD.");
        break;
      case "owned":
      case "avoid": {
        const list = (Array.isArray(value) ? value : [value])
          .filter((item) => typeof item === "string" && item.trim() && item.length <= 80)
          .map((item) => item.trim())
          .slice(0, 20);
        if (list.length) keep(field, list);
        break;
      }
      case "sizes": {
        const sizes = value && typeof value === "object" ? value : {};
        const top = String(sizes.top ?? "").trim().toUpperCase();
        if (top && TOP_SIZES.includes(top)) keep("sizes.top", top);
        else if (top) rejected.push(`A top size has to be one of ${TOP_SIZES.join(", ")}.`);
        const waist = Number(sizes.waist);
        if (Number.isInteger(waist) && waist >= 24 && waist <= 50) keep("sizes.waist", String(waist));
        else if (sizes.waist != null) rejected.push("A waist size is given in inches, 24 to 50.");
        const shoe = HALF(sizes.shoe_eu ?? sizes.shoes ?? "");
        if (Number.isFinite(shoe) && shoe >= 34 && shoe <= 50 && (shoe * 2) % 1 === 0) keep("sizes.shoe_eu", String(shoe));
        else if (sizes.shoe_eu != null || sizes.shoes != null) rejected.push("An EU shoe size runs from 34 to 50, in whole or half sizes.");
        break;
      }
      default:
        break;
    }
  }
  return { draft: next, taken, rejected };
}

/**
 * The draft as an order, checked by step 1 exactly as a typed order is. A draft
 * that is merely unfinished carries no errors: `askFor` already says what is
 * missing, and saying it twice is what a form does, not a conversation.
 */
export function orderFrom(draft) {
  const left = missing(draft);
  if (left.length) return { ok: false, incomplete: true, missing: left, errors: [] };
  return readOrder(JSON.stringify(draft));
}

/** One line a customer recognises their own order in. */
export function summary(draft) {
  const parts = [];
  if (draft.outfits) parts.push(`${draft.outfits} outfit${draft.outfits === 1 ? "" : "s"}`);
  if (draft.theme) parts.push(draft.theme.replace("_", " "));
  if (draft.season) parts.push(`for ${draft.season}`);
  if (draft.budget_eur) parts.push(`budget ${draft.budget_eur} EUR per outfit`);
  if (draft.gender) parts.push(`${draft.gender}'s collection`);
  const sizes = [
    draft.sizes?.top && `top ${draft.sizes.top}`,
    draft.sizes?.waist && `waist ${draft.sizes.waist}`,
    draft.sizes?.shoe_eu && `shoes EU ${draft.sizes.shoe_eu}`,
  ].filter(Boolean);
  if (sizes.length) parts.push(sizes.join(", "));
  if (draft.fit) parts.push(`${draft.fit} fit`);
  if (draft.avoid?.length) parts.push(`avoiding ${draft.avoid.join(", ")}`);
  return parts.join(" · ");
}

const YES = /^(?:ja|jo|jep|yes|yep|yeah|y|ok|okay|okey|alles klar|klar|sure|go|go ahead|los|mach|mach es|do it|please do|bitte|genau|richtig|stimmt|confirm\w*|bestaetig\w*|bestätig\w*|kauf\w*|buy it|pay|zahlen|einverstanden|passt)\b/;
const NO = /^(?:nein|ne|nope|no|nicht|stop|halt|warte|wait|abbrechen|cancel|lieber nicht|doch nicht)\b/;
const RESTART = /\b(?:neu anfangen|von vorne|start over|reset|neue bestellung|new order|anderes outfit komplett)\b/;
const SHOW = /\b(?:zeig|zeige|show|nochmal|again|welche|which|liste|list)\b/;
const ORDINALS = { first: 1, erste: 1, erster: 1, ersten: 1, second: 2, zweite: 2, zweiter: 2, zweiten: 2, third: 3, dritte: 3, dritter: 3, dritten: 3, fourth: 4, vierte: 4, vierten: 4 };

/**
 * What the customer wants, read by code. Money decisions hang on this, so no
 * model is consulted: a purchase needs a confirmation this function recognises.
 */
export function detectIntent(text) {
  const source = typeof text === "string" ? text.trim() : "";
  const lower = source.toLowerCase();
  if (!source) return { kind: "empty" };
  if (RESTART.test(lower)) return { kind: "restart" };

  const numbered = lower.match(/(?:outfit|look|nummer|number|no\.?|#)\s*(\d{1,2})/) ?? lower.match(/^(\d{1,2})$/);
  const ordinal = word(source, ORDINALS);
  const index = numbered ? Number(numbered[1]) : ordinal;
  if (index) return { kind: "pick", index };

  if (YES.test(lower)) return { kind: "yes" };
  if (NO.test(lower)) return { kind: "no" };
  if (SHOW.test(lower)) return { kind: "show" };
  return { kind: "message" };
}

/* ------------------------------- the turns ------------------------------- */

/** The model's wording first, the code's own list after it. */
function withModel(model, body) {
  const said = typeof model?.reply === "string" ? model.reply.trim().slice(0, 400) : "";
  return said ? `${said}\n\n${body}` : body;
}

function askFor(state, rejected) {
  const left = missing(state.draft);
  const known = summary(state.draft);
  const lines = [];
  if (rejected?.length) lines.push(...rejected, "");
  if (known) lines.push(`So far: ${known}.`, "");
  lines.push(left.length === 1 ? "One thing is still missing:" : `${left.length} things are still missing:`);
  for (const [, label] of left.slice(0, MAX_ASKS)) lines.push(`- ${label}`);
  if (left.length > MAX_ASKS) lines.push(`…and ${left.length - MAX_ASKS} more after that.`);
  return lines.join("\n");
}

function readyText(state, rejected) {
  const lines = [];
  if (rejected?.length) lines.push(...rejected, "");
  lines.push(
    `Your order: ${summary(state.draft)}.`,
    "",
    "Shall I search the shops for it? Say **yes** and I will style it, or tell me what to change.",
  );
  return lines.join("\n");
}

/** Person 3's outfit, reduced to what a customer and a payment need. */
export function normaliseOutfit(outfit, index) {
  const items = (outfit?.items ?? []).map((item) => ({
    item_id: item.item_id ?? null,
    title: item.title ?? "Item",
    brand: item.brand ?? "",
    size: item.size ?? "",
    price: Number(item.price?.amount ?? 0),
    currency: item.price?.currency ?? outfit?.totals?.currency ?? "EUR",
    product_url: item.product_url ?? "",
    image_url: item.image_url ?? "",
  }));
  return {
    number: index + 1,
    outfit_id: outfit?.outfit_id ?? `look-${index + 1}`,
    name: outfit?.name ?? `Look ${index + 1}`,
    items,
    total: Number(outfit?.totals?.grand_total ?? items.reduce((sum, item) => sum + item.price, 0)),
    shipping: Number(outfit?.totals?.shipping ?? 0),
    currency: outfit?.totals?.currency ?? items[0]?.currency ?? "EUR",
    guaranteed: outfit?.guarantees?.ok !== false,
    rationale: outfit?.rationale ?? "",
    board: outfit?.images?.board ?? null,
  };
}

function money(amount, currency) {
  return `${amount.toFixed(2)} ${currency}`;
}

/** What the customer reads when the looks are ready. Written by code only. */
export function presentText(outfits) {
  const one = outfits.length === 1;
  const lines = [`I found ${one ? "one look" : `${outfits.length} looks`} that ${one ? "passes" : "pass"} every check:`, ""];
  for (const outfit of outfits) {
    lines.push(`**${outfit.number}. ${outfit.name}** — ${money(outfit.total, outfit.currency)}`);
    for (const item of outfit.items) lines.push(`   - ${item.title}${item.brand ? ` (${item.brand})` : ""}, size ${item.size}, ${money(item.price, item.currency)}`);
    if (outfit.rationale) lines.push(`   _${outfit.rationale}_`);
    lines.push("");
  }
  lines.push(
    one
      ? "Shall I buy it? Say **outfit 1** — or tell me what to change and I will restyle."
      : `Which one shall I buy for you? Say **outfit 1** to **outfit ${outfits.length}** — or tell me what to change and I will restyle.`,
  );
  return lines.join("\n");
}

/**
 * The pipeline came back. Replaces the looks on the table and asks the
 * customer to choose; `status` becomes presented, or collecting when a run
 * produced nothing to buy.
 */
export function presentOutfits(state, result) {
  const next = { ...state, run: null };
  // Numbered after the filter: the numbers a customer picks from have to be the
  // numbers they can see, so a dropped look leaves no gap. outfit_id keeps
  // Person 3's own identity for the result page and the purchase.
  const outfits = (result?.outfits ?? [])
    .map(normaliseOutfit)
    .filter((outfit) => outfit.items.length && outfit.guaranteed)
    .map((outfit, index) => ({ ...outfit, number: index + 1 }));
  if (!outfits.length) {
    next.status = "ready";
    next.outfits = [];
    const reason = result?.decision?.reason ?? "No look passed all five checks.";
    return { state: say(next, "agent", `${reason}\n\nNothing was charged. Shall I try again with a higher budget or another style?`), reply: reason };
  }
  next.status = "presented";
  next.outfits = outfits;
  next.selection = null;
  const reply = presentText(outfits);
  return { state: say(next, "agent", reply), reply };
}

/** What the customer confirms: the one look, its items and its total. */
export function confirmText(outfit) {
  return [
    `**${outfit.name}** — ${money(outfit.total, outfit.currency)}${outfit.shipping ? ` (incl. ${money(outfit.shipping, outfit.currency)} shipping)` : ""}`,
    "",
    ...outfit.items.map((item) => `- ${item.title}${item.brand ? ` (${item.brand})` : ""}, size ${item.size}, ${money(item.price, item.currency)} — ${item.product_url}`),
    "",
    `Shall I pay ${money(outfit.total, outfit.currency)} for this outfit? Say **yes** to confirm, or **no** to go back to the looks.`,
  ].join("\n");
}

/** The receipt or the refusal the payment module came back with. */
export function checkoutText(outcome, outfit) {
  if (outcome?.status === "paid")
    return [
      `Paid: **${outfit.name}**, ${money(outfit.total, outfit.currency)}.`,
      outcome.txHash ? `Transaction: \`${outcome.txHash}\`` : null,
      outcome.mock ? "_No money moved: this run used the mock payment provider._" : null,
      "",
      "Shall I style another capsule for you?",
    ].filter((line) => line !== null).join("\n");
  const detail = outcome?.detail ? ` ${outcome.detail}` : "";
  return `The payment did not go through, so nothing was bought.${detail}\n\nThe outfit is still on the table: say **yes** to try again, or pick another look.`;
}

/** Records what the payment module answered; "paid" ends the purchase. */
export function recordCheckout(state, outcome, { outfit = state.outfits[state.selection] } = {}) {
  const next = { ...state, checkout: outcome ?? null };
  next.status = outcome?.status === "paid" ? "paid" : "selected";
  const reply = checkoutText(outcome, outfit ?? { name: "the outfit", total: 0, currency: "EUR" });
  return { state: say(next, "agent", reply), reply };
}

/* --------------------------- the optional model --------------------------- */

export const slotProposalSchema = z.object({
  reply: z.string().optional(),
  slots: z.object({
    budget_eur: z.number().nullable().optional(),
    outfits: z.number().nullable().optional(),
    theme: z.string().nullable().optional(),
    season: z.string().nullable().optional(),
    gender: z.string().nullable().optional(),
    fit: z.string().nullable().optional(),
    climate: z.string().nullable().optional(),
    needed_by: z.string().nullable().optional(),
    avoid: z.array(z.string()).nullable().optional(),
    owned: z.array(z.string()).nullable().optional(),
    sizes: z
      .object({
        top: z.string().nullable().optional(),
        waist: z.union([z.string(), z.number()]).nullable().optional(),
        shoe_eu: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .nullable()
      .optional(),
  }).optional(),
});

const SYSTEM = `You are the intake stylist of AiTelier, a capsule wardrobe agent.
You read one customer message and return what it says about their order, plus a short friendly reply
in the customer's own language. Never invent products, prices, shops or availability: another part of
the agent finds those. Only fill a slot the customer actually gave. Styles are exactly ${THEMES.join(", ")};
seasons ${SEASONS.join(", ")}; top sizes ${TOP_SIZES.join(", ")}; waist in inches; shoe sizes EU.
Keep the reply under 60 words and ask only for what is still missing. Do not promise looks, do not say you
are starting the search and do not say you will report back: the agent asks the customer for a go-ahead first.`;

/** Model-backed slot reading, used while the order is still being collected. */
export function conversationAsker({ model, timeoutMs = 20000 } = {}) {
  if (!model) return null;
  return async ({ text, draft }) => {
    const { generateObject } = await import("ai");
    const { object } = await generateObject({
      model,
      schema: slotProposalSchema,
      schemaName: "orderSlots",
      temperature: 0,
      maxRetries: 1,
      // Some providers ignore the requested response format and answer with
      // prose or a fence around the object; step 1's own extractor gets it out.
      repairText: async ({ text }) => {
        const object = extractJson(text);
        return object ? JSON.stringify(object) : null;
      },
      abortSignal: AbortSignal.timeout(timeoutMs),
      system: SYSTEM,
      prompt: [
        `Known so far: ${JSON.stringify(draft)}`,
        `Still missing: ${missing(draft).map(([, label]) => label).join("; ") || "nothing"}`,
        `Customer message: ${text}`,
      ].join("\n"),
    });
    return object;
  };
}

/** The model from the environment the rest of the agent uses, or null. */
export async function conversationModel(env = process.env) {
  const apiKey = env.ZAI_API_KEY?.trim();
  const baseURL = env.ZAI_BASE_URL?.trim();
  const modelId = env.ZAI_MODEL?.trim();
  if (!apiKey || !baseURL || !modelId) return null;
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  return createOpenAICompatible({ name: env.ZAI_MODEL_PROVIDER_NAME?.trim() || "aitelier-chat", baseURL, apiKey }).chatModel(modelId);
}

/* -------------------------------- one turn -------------------------------- */

/**
 * One customer message. Returns the new state, the text the customer reads and
 * the action the surface has to perform:
 *
 *   { type: "none" }
 *   { type: "run_pipeline", order }        start the styling for this order
 *   { type: "checkout", outfit, purchase } pay for the confirmed outfit
 *
 * `ask` is the optional model hook from conversationAsker(); a failing or
 * missing model costs wording, never a slot the code could read itself.
 */
export async function nextTurn(state, text, { ask = null } = {}) {
  const input = typeof text === "string" ? text.trim().slice(0, MAX_MESSAGE_CHARS) : "";
  let next = say({ ...state }, "customer", input);
  const intent = detectIntent(input);
  const reply = (body, status = next.status) => {
    next.status = status;
    next = say(next, "agent", body);
    return { state: next, reply: body, action: { type: "none" } };
  };

  if (intent.kind === "empty")
    return reply("Tell me what you are looking for — for example: two autumn outfits, old money, 400 EUR, top M, waist 32, shoes EU 43.");

  if (intent.kind === "restart") {
    next = { ...next, draft: {}, outfits: [], selection: null, checkout: null, run: null };
    return reply("Starting fresh. What should the new capsule be — style, season, budget and your sizes?", "collecting");
  }

  switch (next.status) {
    case "styling":
      return reply("I am still styling your capsule — the looks follow as soon as the checks are through.");

    case "presented": {
      if (intent.kind === "pick") {
        const outfit = next.outfits.find((candidate) => candidate.number === intent.index);
        if (!outfit) return reply(`There is no outfit ${intent.index}. Pick one from 1 to ${next.outfits.length}.`);
        next.selection = next.outfits.indexOf(outfit);
        return reply(confirmText(outfit), "selected");
      }
      if (intent.kind === "show") return reply(presentText(next.outfits));
      // Anything else is treated as a change to the brief: restyle on a go-ahead.
      const changed = await updateDraft(next, input, ask);
      next.draft = changed.draft;
      if (!changed.taken.length && intent.kind !== "yes")
        return reply(`I did not catch a change there. Pick a look with **outfit 1**, or name what to change — budget, style, season, sizes or something to avoid.`);
      const order = orderFrom(next.draft);
      if (!order.ok) return reply(askFor(next, [...changed.rejected, ...order.errors]), "collecting");
      next.outfits = [];
      next.selection = null;
      return reply(readyText(next, changed.rejected), "ready");
    }

    case "selected": {
      const outfit = next.outfits[next.selection];
      if (!outfit) return reply(presentText(next.outfits), "presented");
      if (intent.kind === "pick") {
        const other = next.outfits.find((candidate) => candidate.number === intent.index);
        if (!other) return reply(`There is no outfit ${intent.index}. Pick one from 1 to ${next.outfits.length}.`);
        next.selection = next.outfits.indexOf(other);
        return reply(confirmText(other));
      }
      if (intent.kind === "no") {
        next.selection = null;
        return reply(`Nothing bought.\n\n${presentText(next.outfits)}`, "presented");
      }
      if (intent.kind !== "yes") return reply(`I only buy on a clear yes.\n\n${confirmText(outfit)}`);
      // The one place money starts moving, and only from a confirmation code read.
      next.status = "paying";
      next = say(next, "agent", `Paying ${money(outfit.total, outfit.currency)} for ${outfit.name}…`);
      return {
        state: next,
        reply: `Paying ${money(outfit.total, outfit.currency)} for ${outfit.name}…`,
        action: { type: "checkout", outfit },
      };
    }

    case "paying":
      return reply("The payment is still running. I will post the receipt as soon as it settles.");

    case "paid":
      if (intent.kind === "yes" || intent.kind === "message") {
        next = { ...next, outfits: [], selection: null, checkout: null };
        const changed = await updateDraft(next, input, ask);
        next.draft = changed.draft;
        const order = orderFrom(next.draft);
        return order.ok ? reply(readyText(next, changed.rejected), "ready") : reply(askFor(next, changed.rejected), "collecting");
      }
      return reply("Thank you for your order. Say the word when you want another capsule.");

    default: {
      // collecting / ready
      const changed = await updateDraft(next, input, ask);
      next.draft = changed.draft;
      const order = orderFrom(next.draft);
      if (!order.ok) return reply(withModel(changed.model, askFor(next, [...changed.rejected, ...order.errors])), "collecting");
      const goAhead = next.status === "ready" ? intent.kind === "yes" : intent.kind === "yes" && !changed.taken.length;
      if (!goAhead) return reply(withModel(changed.model, readyText(next, changed.rejected)), "ready");
      next.status = "styling";
      const started = `On it: ${summary(next.draft)}. I am searching the shops now — this takes a minute or two.`;
      next = say(next, "agent", started);
      return { state: next, reply: started, action: { type: "run_pipeline", order: order.order } };
    }
  }
}

/** Slots from the code reader, then from the model; the code validates both. */
async function updateDraft(state, text, ask) {
  const own = mergeSlots(state.draft, extractSlots(text));
  let model = null;
  if (ask) {
    try {
      model = await ask({ text, draft: own.draft });
    } catch (error) {
      // A model that is down, slow or rate-limited must not stop the dialogue:
      // the code reader above has already filled every slot it could see.
      log.warn("model turn failed, carrying on with the code reader", { error: error.message });
      model = null;
    }
  }
  if (!model?.slots) return { ...own, model };
  const merged = mergeSlots(own.draft, model.slots);
  return {
    draft: merged.draft,
    taken: [...new Set([...own.taken, ...merged.taken])],
    rejected: [...new Set([...own.rejected, ...merged.rejected])],
    model,
  };
}
