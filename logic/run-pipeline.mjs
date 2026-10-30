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
import { readOrder, refusal } from "./intake.mjs";
import { equivalentSizes } from "./data/normalize.js";

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

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.on("error", (err) => resolve({ ok: false, reason: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, reason: `exit code ${code}` }));
  });
}

/** The free text Person 2's filter reads. It picks the facets out of this itself. */
export function orderToBrief(order) {
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
export function orderToCustomer(order) {
  const { sizes = {} } = order;
  return {
    currency: "EUR",
    customer: {
      budget: { amount: order.budget_eur, currency: "EUR" },
      outfit_count: order.outfits,
      item_count: order.item_count ?? order.outfits * 3,
      style: [String(order.theme).replace(/_/g, " ")],
      fit: order.fit ? [order.fit] : [],
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
      const brief = orderToCustomer(order);
      const shortlisted = JSON.parse(await readFile(path.resolve(ROOT, envelope), "utf8"));
      const { sizes, swaps } = fitSizesToCatalogue(brief.customer.sizes, shortlisted);
      brief.customer.sizes = sizes;
      for (const swap of swaps) console.log(`size: ${swap}`);
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
