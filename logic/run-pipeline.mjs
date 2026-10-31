// One order in, one result out. Chains the three owners' steps so the Masumi
// agent has a single command to call.
//
//   node logic/run-pipeline.mjs
//   node logic/run-pipeline.mjs --order catalog/order.json --out catalog/cache/run
//   PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs
//   node logic/run-pipeline.mjs --shortlist catalog/cache/shortlist.demo.json
//
// --shortlist skips the model-backed filter and uses a prepared shortlist.
// The provider behind the filter returned Service Unavailable and Too Many
// Requests repeatedly, so the demo needs a path that does not depend on it.
//
// Person 1 owns the catalogue and this wiring. Person 2 owns candidateFilter,
// Person 3 owns the stylist. Each stage is a separate process on purpose: a
// stage can be fixed or re-run on its own while the others keep working.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readOrder, refusal, SEASONS } from "./intake.mjs";
import { equivalentSizes, categoryOf } from "./data/normalize.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every stage is a child process and inherits this env, so .env has to be
// loaded here. Python does not read it on its own: without this the stylist
// saw no model credentials and silently ran in mock mode, which looks like a
// working pipeline and is not one. Real values already in the environment win.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env, or it is unreadable; the stages report what they are missing
}

// The stylist stage runs with cwd=person3, so a relative interpreter path has
// to be resolved against the repo root first or it lands in person3/person3.
const rawPython = process.env.PYTHON ?? "python3";
const PYTHON = rawPython.includes(path.sep) ? path.resolve(ROOT, rawPython) : rawPython;

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

/**
 * Each stage gets its own clock. Without one, a model call or a shop that never
 * answered held the whole run open until the escrow's deadline, and the Task
 * sat in RUNNING with nothing to show. SIGTERM first, SIGKILL for a child that
 * ignores it.
 */
const STAGE_TIMEOUT_MS = Number(process.env.AITELIER_STAGE_TIMEOUT_MS) || 3 * 60_000;

function run(command, args, options = {}, timeoutMs = STAGE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        timedOut
          ? { ok: false, reason: `no answer within ${Math.round(timeoutMs / 1000)}s` }
          : { ok: code === 0, reason: `exit code ${code}` },
      );
    });
  });
}

/** The free text Person 2's filter reads. It picks the facets out of this itself. */
export function orderToBrief(order) {
  if (order.brief) return order.brief;
  const { sizes = {}, avoid = [], owned = [] } = order;
  return [
    `${order.season} outfits, ${String(order.theme).replace(/_/g, " ")} style`,
    `${order.outfits} outfits, budget ${order.budget_eur} EUR in total`,
    sizes.top && `top size ${sizes.top}`,
    sizes.waist && `waist ${sizes.waist}`,
    sizes.shoe_eu && `shoes EU ${sizes.shoe_eu}`,
    order.fit && `${order.fit} fit`,
    avoid.length && `avoid ${avoid.join(" and ")}`,
    owned.length && `already owns ${owned.join(" and ")}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The customer half of Person 3's envelope; our adapter writes the other half.
 * fit_mode stays size_only: the Shopify feed carries no garment measurements,
 * so `measurements` would fail every item. See catalog/README.md.
 */
export function orderToCustomer(order, brief = null) {
  const { sizes = {} } = order;
  return {
    currency: "EUR",
    customer: {
      budget: { amount: order.budget_eur, currency: "EUR" },
      outfit_count: order.outfits,
      item_count: order.item_count ?? order.outfits * 3,
      style: [String(order.theme).replace(/_/g, " ")],
      fit: order.fit ? [order.fit] : [],
      ...(brief ? { fit_description: brief.slice(0, 500) } : {}),
      gender: order.gender ?? null,
      season: order.season,
      climate: order.climate ?? null,
      sizes: {
        base: sizes.top,
        mid: sizes.top,
        outer: sizes.top,
        bottom: sizes.waist,
        shoes: sizes.shoe_eu,
      },
      avoid: order.avoid ?? [],
      owned: order.owned ?? [],
      deadline: order.needed_by ?? null,
      photo: null,
    },
    options: {
      strict_guarantees: true,
      fit_mode: "size_only",
      country: "DE",
    },
  };
}

// Used only when a free-text brief names no budget; Person 3 cannot style without one,
// and its result shows the budget it used, so the customer sees the assumption.
const DEFAULT_BUDGET_EUR = Number(process.env.AITELIER_DEFAULT_BUDGET_EUR) || 500;
const LETTER_SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, ein: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5 };

/**
 * Per-slot sizes from the filter's size labels. A size is assigned only when it
 * is unambiguous: one letter size, and one or two numbers (the smaller is the
 * waist, the larger the shoe). A broad range means the brief named no size, so
 * nothing is assigned and the stylist keeps every size open.
 */
export function sizesFromLabels(labels = []) {
  const letters = [...new Set(labels.map((l) => String(l).toUpperCase()).filter((l) => LETTER_SIZES.includes(l)))];
  const numbers = [...new Set(labels.map(Number).filter((n) => Number.isFinite(n) && n >= 24 && n <= 50))].sort((a, b) => a - b);
  const top = letters.length === 1 ? letters[0] : undefined;
  let waist, shoe;
  if (numbers.length === 2) [waist, shoe] = numbers;
  else if (numbers.length === 1) numbers[0] >= 35 ? (shoe = numbers[0]) : (waist = numbers[0]);
  return { top, waist: waist && String(waist), shoe_eu: shoe && String(shoe) };
}

const SEASON_BY_MONTH = [
  "winter", "winter", "spring", "spring", "spring", "summer",
  "summer", "summer", "autumn", "autumn", "autumn", "winter",
];

/**
 * The season nobody stated. Person 3 needs one to leave shorts out of an
 * October order; given null it kept every season open and a Munich autumn
 * brief came back with summer shorts.
 *
 * The month decides it - the shops and the delivery country are European, so
 * northern hemisphere - and a season named in the climate note wins outright.
 * A stated temperature may only make the answer colder: a cold June is not a
 * reason to buy a parka, but it is a reason not to buy shorts.
 */
export function seasonFromDate(date = new Date(), climate = null) {
  const text = String(climate ?? "").toLowerCase();
  const named = SEASONS.find((season) => text.includes(season));
  if (named) return named;
  const byMonth = SEASON_BY_MONTH[date.getMonth()];
  // The hyphen in a range is not a minus sign: "8-15 C" is 15, not -15.
  const degrees = [...text.matchAll(/(?<!\d)(-?\d{1,2})\s*(?:°|deg)?\s*c\b/g)].map((m) => Number(m[1]));
  if (!degrees.length) return byMonth;
  const high = Math.max(...degrees);
  if (high < 5) return "winter";
  if (high < 18 && byMonth === "summer") return "autumn";
  return byMonth;
}

/** The customer half of Person 3's envelope for a free-text brief. */
export function briefToCustomer(brief, selection = null, { today = new Date() } = {}) {
  const text = brief.toLowerCase();
  const budgetMatch =
    text.match(/(\d[\d.,]*)\s*(?:€|eur|euro)/) ?? text.match(/(?:budget|max(?:imum)?)\D{0,12}(\d[\d.,]*)/);
  const budget = Number(selection?.budgetEur) || (budgetMatch && Number(budgetMatch[1].replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".")));
  const countMatch = text.match(/(\d+|one|two|three|four|five|ein|zwei|drei|vier|fünf)\s*(?:outfits?|looks?)/);
  const outfits = countMatch ? Number(countMatch[1]) || WORD_NUMBERS[countMatch[1]] : 2;
  const themes = selection?.themes?.length ? selection.themes : [];
  const seasons = selection?.seasons ?? [];
  const gender = /\b(women|woman|damen|female)\b/.test(text) ? "women" : /\b(men|man|herren|male)\b/.test(text) ? "men" : null;
  // A size the customer wrote out ("feet 40", "waist 32", "top M") beats the
  // filter's reading, which falls back to a broad range when unsure.
  const said = (re) => text.match(re)?.[1];
  const sizes = {
    ...sizesFromLabels(selection?.stock),
    ...Object.fromEntries(
      Object.entries({
        top: said(/\b(?:top|tops|shirt|oberteil|size|größe)\s*(?:size\s*)?(xxs|xs|s|m|l|xl|xxl|xxxl)\b/)?.toUpperCase(),
        waist: said(/\b(?:waist|taille|bundweite|w)\s*(\d{2})\b/),
        shoe_eu: said(/\b(?:feet|foot|shoes?|schuhe?|schuhgröße|eu)\s*(?:size\s*|eu\s*)?(\d{2}(?:[.,]5)?)\b/)?.replace(",", "."),
      }).filter(([, v]) => v),
    ),
  };
  const season = seasons.length === 1 ? seasons[0] : seasonFromDate(today, brief);
  return {
    budgetAssumed: !budget,
    seasonAssumed: seasons.length !== 1,
    season,
    envelope: orderToCustomer({
      budget_eur: budget || DEFAULT_BUDGET_EUR,
      outfits: Math.min(Math.max(outfits, 1), 10),
      theme: themes[0] ?? "minimal",
      season,
      gender,
      sizes,
      fit: null,
    }, brief),
  };
}

/**
 * A shortlist that has no shoes cannot produce one complete outfit, so the
 * stylist is guaranteed to refuse and the escrow to refund. That is a filter
 * problem, and it is much easier to read here than three steps later.
 */
export function missingSlots(items, required = ["top", "bottom", "shoes"]) {
  const present = new Set(items.map((i) => i.category));
  return required.filter((slot) => !present.has(slot));
}

/**
 * Which key each LLM step will use. The filter and the stylist are separate
 * steps but nothing stops them sharing one key, and then they share one quota:
 * a single run spends it twice and both come back 429. Reports which variable
 * each step reads and whether the values are identical - never the values.
 */
export function modelKeyReport(env = process.env) {
  const filter = env.ZAI_API_KEY?.trim() || "";
  const gemini = env.GEMINI_API_KEY?.trim() || "";
  const stylist = gemini || filter;
  return {
    filter: filter ? "ZAI_API_KEY" : null,
    stylist: stylist ? (gemini ? "GEMINI_API_KEY" : "ZAI_API_KEY (fallback)") : null,
    shared: Boolean(filter && stylist && filter === stylist),
  };
}

const LAYER_CATEGORY = { base: "top", mid: "top", outer: "outerwear", bottom: "bottom", shoes: "shoes" };

/**
 * State the customer's size in the label the shops in front of them use.
 *
 * Person 3 keeps one label per slot (`customer.sizes: dict[str, str]`) and
 * matches it exactly, so a waist 32 brief reaches only the waist-sized
 * trousers - 3 of 28 in the demo shortlist. Bottoms are split almost evenly
 * between waist and letter sizing, so the same person is turned away from half
 * the catalogue over a labelling convention.
 *
 * We keep the stated label unless an equivalent one keeps a cheaper garment
 * reachable, and we print every swap. Cheapest, not most: picking the label
 * with the most items once traded three waist-sized trousers for fourteen
 * letter-sized ones and lost the 59.98 EUR pair in the process, which put the
 * only affordable outfit out of budget. Guarantee 1 is what this slot decides.
 *
 * The catalogue is never touched: `stock` keeps what the shop published, so
 * guarantee 2 still rests on the shop's own data.
 */
export function fitSizesToCatalogue(sizes, envelope) {
  const items = envelope.items ?? [];
  const adjusted = { ...sizes };
  const swaps = [];
  for (const [layer, label] of Object.entries(sizes)) {
    if (!label) continue;
    const pool = items.filter((i) => i.category === LAYER_CATEGORY[layer]);
    const buyable = (want) =>
      pool.filter((i) =>
        (i.sizes ?? []).some(
          (s) => String(s.label).toLowerCase() === String(want).toLowerCase() && s.in_stock !== false
        )
      );
    // Lower is better; a label that reaches nothing scores Infinity.
    const score = (want) => {
      const reachable = buyable(want);
      return reachable.length
        ? Math.min(...reachable.map((i) => i.price?.amount ?? Infinity))
        : Infinity;
    };
    const stated = score(label);
    let best = label;
    let bestScore = stated;
    for (const alternative of equivalentSizes(label).slice(1)) {
      const value = score(alternative);
      if (value < bestScore) {
        best = alternative;
        bestScore = value;
      }
    }
    adjusted[layer] = best;
    if (best !== label) {
      const from = Number.isFinite(stated) ? `${stated} EUR` : "nothing";
      swaps.push(
        `${layer} ${label} -> ${best}: cheapest reachable ${from} -> ${bestScore} EUR` +
          ` (${buyable(label).length} -> ${buyable(best).length} items)`
      );
    }
  }
  return { sizes: adjusted, swaps };
}

// A knit and a shirt are both "top" to the catalogue's classifier, but Person 3
// keeps base and mid apart, so the two are separated here.
const MID_WORDS =
  /\b(?:sweater|pullover|knit|strick|cardigan|jumper|hoodie|sweatshirt|fleece|roll-?neck|turtleneck|gilet)\b/i;

/**
 * Which layer a garment the customer already owns fills, or null when it
 * cannot be placed. Guessing is the one thing not to do here: dropping the
 * wrong layer buys the customer nothing for that slot.
 */
export function layerOwned(text) {
  const words = String(text ?? "").toLowerCase();
  const category = categoryOf(words);
  if (category === "bottom" || category === "shoes" || category === "outer") return category;
  if (category === "top") return MID_WORDS.test(words) ? "mid" : "base";
  return null;
}

/**
 * The layers Person 3 would ask for.
 *
 * MIRRORS `StylistRequest.required_layers` in person3/app/models.py. Person 3
 * uses `options.required_layers` when we set it and derives the list from the
 * weather words when we do not, so removing a single layer means supplying the
 * whole list - there is no way to subtract one. The test pins every branch, so
 * if Person 3's rule changes the mismatch shows up there rather than in a
 * customer's result.
 */
const LAYERS_BY_WEATHER = [
  [["summer", "hot", "warm", "tropical"], ["base", "bottom", "shoes"]],
  [["winter", "cold", "snow", "freezing"], ["base", "mid", "outer", "bottom", "shoes"]],
  [["autumn", "spring", "mild", "rain", "wet"], ["base", "mid", "bottom", "shoes"]],
];

export function requiredLayersFor(customer = {}) {
  const text = [customer.season, customer.climate, customer.fit_description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const [words, layers] of LAYERS_BY_WEATHER)
    if (words.some((word) => text.includes(word))) return layers;
  return ["base", "bottom", "shoes"];
}

/**
 * What to ask Person 3 for once the customer's own wardrobe is taken off the
 * list, or null to leave Person 3's own rule alone.
 *
 * Person 3 never reads `customer.owned` (see docs/PERSON3_ISSUES.md), so a
 * brief saying "I already own black slim jeans" made the model leave the
 * bottom out - correctly - and then the resolver refused the outfit for a
 * missing bottom and the whole order was refunded. Naming the layers keeps
 * that from happening while the stylist is fixed properly.
 *
 * Nothing is sent when the customer owns nothing we can place, so this
 * duplication stays out of the path of every other order.
 */
export function layersMinusOwned(customer = {}) {
  const owned = [...new Set((customer.owned ?? []).map(layerOwned).filter(Boolean))];
  if (!owned.length) return null;
  const required = requiredLayersFor(customer);
  const covered = owned.filter((layer) => required.includes(layer));
  if (!covered.length) return null;
  const kept = required.filter((layer) => !covered.includes(layer));
  // Owning every layer is not an order for clothes; let Person 3 answer as it
  // would have rather than asking it to build an outfit out of nothing.
  if (!kept.length) return null;
  return { required: kept, covered };
}

/**
 * Fill the slots the customer left open with one label each.
 *
 * Person 3 keeps one size per slot and matches it exactly, so a slot left
 * empty let it pick any size at all: one result arrived with shoes in both 37
 * and 43 and trousers in both 31 and 38, which no single person can wear.
 *
 * An order that names no size at all is refused before the escrow (see
 * intake.reviewOrder), so what reaches here is a partly stated one - a top
 * size but no shoe size. For those we pick the label the shortlist stocks
 * most often, which is the one most likely to stay in stock, and say that we
 * assumed it. Guessing one size is wrong; letting every outfit use a
 * different one is worse.
 */
export function unifySizes(sizes, envelope) {
  const items = envelope.items ?? [];
  const chosen = { ...sizes };
  const assumed = [];
  for (const [layer, category] of Object.entries(LAYER_CATEGORY)) {
    if (chosen[layer]) continue;
    const counts = new Map();
    for (const item of items.filter((i) => i.category === category))
      for (const size of item.sizes ?? [])
        if (size.in_stock !== false && size.label)
          counts.set(String(size.label), (counts.get(String(size.label)) ?? 0) + 1);
    if (!counts.size) continue;
    // Most stocked first; the label itself breaks a tie so a rerun agrees.
    const [best, stocked] = [...counts].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    chosen[layer] = best;
    assumed.push(`${layer} was not stated, using ${best} (${stocked} items in stock)`);
  }
  return { sizes: chosen, assumed };
}

/**
 * Drop what the shop says is for another gender. A men's brief came back with
 * a pleated skirt and women's sneakers, which is the first thing anyone
 * notices on the result page.
 *
 * Only an explicit opposite is dropped: `unisex` and the unlabelled majority
 * stay, because about 40% of the catalogue says nothing and most of that is
 * unisex basics. Requiring a positive match would throw the catalogue away.
 */
export function dropWrongGender(envelope, gender) {
  if (gender !== "men" && gender !== "women") return { envelope, dropped: 0 };
  const opposite = gender === "men" ? "women" : "men";
  const items = envelope.items.filter((i) => (i.raw?.gender ?? null) !== opposite);
  return { envelope: { ...envelope, items }, dropped: envelope.items.length - items.length };
}

const stages = [];
async function stage(name, hint, fn) {
  const started = Date.now();
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = await fn();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  stages.push({ name, ...result, seconds, hint });
  if (!result.ok) {
    process.stdout.write(`\n${name} failed: ${result.reason}\n${hint}\n`);
  }
  return result.ok;
}

async function main() {
  const orderPath = flag("--order", "catalog/order.json");
  const outDir = flag("--out", "catalog/cache/run");
  // Person 3 names its artifact folder after the task, so without a real one
  // every run wrote its look boards to person3/artifacts/aitelier-catalog-demo
  // and two Tasks running at once overwrote each other's images. It is also
  // the id the customer reads on the result page.
  const taskId = flag("--task-id", path.basename(outDir));
  if (!/^[\w-]+$/.test(taskId))
    throw new Error(`--task-id must be a plain identifier, got "${taskId}"`);
  await mkdir(path.resolve(ROOT, outDir), { recursive: true });

  // Step 1: refuse a bad order here, before the filter spends model calls on it.
  const intake = readOrder(await readFile(path.resolve(ROOT, orderPath), "utf8"));
  if (!intake.ok) {
    console.log(refusal(intake));
    process.exitCode = 1;
    return;
  }
  for (const w of intake.warnings) console.log(`warning: ${w}`);
  const order = intake.order;
  const prepared = flag("--shortlist", null);
  const shortlist = prepared ?? path.join(outDir, "shortlist.json");
  const envelope = path.join(outDir, "person3.input.json");
  const customer = path.join(outDir, "customer.json");
  const selectionFile = path.join(outDir, "selection.json");
  const resultDir = path.join(outDir, "person3");

  console.log(`order:  ${orderPath}`);
  console.log(`brief:  ${orderToBrief(order)}`);
  console.log(`out:    ${outDir}`);

  const keys = modelKeyReport();
  console.log(
    `keys:   filter ${keys.filter ?? "MISSING"}  ·  stylist ${keys.stylist ?? "MISSING"}`
  );
  if (keys.shared) {
    console.log(
      `\nWARNING: both LLM steps use the same key, so they share one quota.\n` +
        `  One run spends it twice and both come back 429 Too Many Requests.\n` +
        `  Set GEMINI_API_KEY to a key on a different account; see .env.example.\n`
    );
  }

  const ok =
    (await stage(
      "1/4 candidateFilter (Person 2)",
      "Needs ZAI_API_KEY, ZAI_BASE_URL and ZAI_MODEL in .env. If the provider\n" +
        "is down, rerun with --shortlist catalog/cache/shortlist.demo.json.",
      async () => {
        if (prepared) {
          console.log(`skipped, using the prepared shortlist ${prepared}`);
          return { ok: true };
        }
        return run("node", [
          "--env-file-if-exists=.env",
          "candidateFilter.mjs",
          "--user-info", orderToBrief(order),
          "--in", "catalog/cache/products.json",
          "--out", shortlist,
          "--selection-out", selectionFile,
        ]);
      }
    )) &&
    (await stage(
      "2/4 to_person3 (Person 1)",
      "Check that the shortlist is valid JSON from step 1.",
      async () => {
        const picked = JSON.parse(await readFile(path.resolve(ROOT, shortlist), "utf8"));
        const missing = missingSlots(picked);
        if (missing.length) {
          console.log(
            `\nWARNING: the shortlist has no ${missing.join(" and no ")}.` +
              `\n  ${picked.length} items came through, so no complete outfit can be built and` +
              `\n  the stylist will refuse every look. This is step 1, not the stylist.` +
              `\n  Person 2: the filter caps price at budget divided by item count, and` +
              `\n  shoes cost more than tops, so the cap removes the whole slot.\n`
          );
        }
        return run("node", ["logic/data/to_person3.js", "--in", shortlist, "--out", envelope]);
      }
    )) &&
    (await stage("3/4 customer envelope (Person 1)", "", async () => {
      let brief = orderToCustomer(order);
      if (order.brief) {
        // A free-text brief: budget, style, season and sizes come from what
        // Person 2's filter read out of it.
        const selection = await readFile(path.resolve(ROOT, selectionFile), "utf8").then(JSON.parse, () => null);
        const fromBrief = briefToCustomer(order.brief, selection);
        brief = fromBrief.envelope;
        if (fromBrief.budgetAssumed)
          console.log(`warning: the brief names no budget; using ${brief.customer.budget.amount} EUR`);
        if (fromBrief.seasonAssumed)
          console.log(`warning: the brief names no season; reading ${fromBrief.season} from the date`);
        console.log(`from brief: ${JSON.stringify(brief.customer.sizes)} · ${brief.customer.style} · ${brief.customer.season}`);
      }
      const loaded = JSON.parse(await readFile(path.resolve(ROOT, envelope), "utf8"));
      const { envelope: shortlisted, dropped } = dropWrongGender(loaded, brief.customer.gender);
      if (dropped) {
        console.log(`gender: dropped ${dropped} items marked for another gender`);
        await writeFile(path.resolve(ROOT, envelope), JSON.stringify(shortlisted, null, 2) + "\n");
      }
      const { sizes, swaps } = fitSizesToCatalogue(brief.customer.sizes, shortlisted);
      for (const swap of swaps) console.log(`size: ${swap}`);
      // Any slot still open would let the stylist mix sizes inside one result.
      const { sizes: settled, assumed } = unifySizes(sizes, shortlisted);
      brief.customer.sizes = settled;
      for (const note of assumed) console.log(`size: ${note}`);
      // Person 3 does not read customer.owned, so the layers it must still
      // buy are named for it. Without this a brief that mentions a garment the
      // customer owns was refunded for a layer the model rightly left out.
      const wardrobe = layersMinusOwned(brief.customer);
      if (wardrobe) {
        brief.options = { ...brief.options, required_layers: wardrobe.required };
        console.log(
          `owned: ${wardrobe.covered.join(", ")} already owned; asking Person 3 for ${wardrobe.required.join(", ")}`,
        );
      } else if ((brief.customer.owned ?? []).length) {
        console.log(`owned: ${brief.customer.owned.length} item(s) could not be placed in a layer`);
      }
      // run_catalog.py copies every top-level key but `customer` into its own
      // input, so this is what names the run and its artifact folder.
      brief.task_id = taskId;
      await writeFile(path.resolve(ROOT, customer), JSON.stringify(brief, null, 2) + "\n");
      console.log(`wrote ${customer}`);
      return { ok: true };
    })) &&
    (await stage(
      "3b/4 drop sizes the customer cannot buy",
      "Check that the envelope and customer.json from steps 2 and 3 exist.",
      () => run("node", ["logic/buyable.mjs", "--envelope", envelope, "--customer", customer])
    )) &&
    (await stage(
      "4/4 stylist (Person 3)",
      `Needs Person 3's Python environment. Point at it with\n` +
        `  PYTHON=person3/.venv/bin/python node logic/run-pipeline.mjs\n` +
        `Without GEMINI_API_KEY it runs in mock mode, which is fine for a dry run.`,
      () =>
        run(
          PYTHON,
          [
            "-m", "scripts.run_catalog",
            "--catalog", path.join("..", envelope),
            "--customer", path.join("..", customer),
            "--out", path.join("..", resultDir),
          ],
          { cwd: path.join(ROOT, "person3") }
        )
    ));

  // The customer reads a page, not result.json. Generate it whichever way the
  // run went: a refusal has to be explainable too.
  if (ok) {
    await stage("5/5 result page (Person 1)", "", () =>
      run("node", ["logic/result-page.mjs", "--run", outDir]),
    );
  }

  console.log("\n=== summary ===");
  for (const s of stages) {
    console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name.padEnd(34)} ${s.seconds}s`);
  }
  if (ok) {
    console.log(`\nresult: ${path.join(resultDir, "result.json")}`);
  } else {
    const failed = stages.find((s) => !s.ok);
    console.log(`\nstopped at ${failed.name}. Everything before it is in ${outDir}.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
