import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { shopsInResult, checkShops, trustLine, SHOP_TIMEOUT_MS, TOTAL_BUDGET_MS } from "./logic/trust-shops.mjs";
import { classifyStore } from "./trustcheck.mjs";
import { renderPage } from "./logic/result-page.mjs";

const envelope = {
  shops: [
    { shop_id: "one", name: "One Shop", domain: "one.example", base_url: "https://one.example/" },
    { shop_id: "two", name: "Two Shop", domain: "two.example" },
    { shop_id: "three", name: "Three Shop" },
  ],
  items: [
    { item_id: "a", shop_id: "one" },
    { item_id: "b", shop_id: "one" },
    { item_id: "c", shop_id: "two" },
    { item_id: "d", shop_id: "three" },
  ],
};
const piece = (id) => ({ item_id: id, title: `T-${id}`, product_url: `https://shop-${id}.example/p/${id}` });
const result = { status: "APPROVED", outfits: [{ items: [piece("a"), piece("c")] }, { items: [piece("b"), piece("d")] }] };
const verdict = (v, extra = {}) => ({ verdict: v, confidence: 0.9, summary: `Store says ${v}`, redFlags: [], checkedAt: "2026-10-31T10:00:00Z", ...extra });

// --- which shops ------------------------------------------------------------------

test("each shop behind a chosen piece is checked once, in the order it appears", () => {
  const shops = shopsInResult(result, envelope);
  assert.deepEqual(shops.map((s) => s.shop_id), ["one", "two", "three"]);
  assert.equal(shops[0].url, "https://one.example/", "the shop's own base address first");
  assert.equal(shops[1].url, "https://two.example/", "then its domain");
  assert.equal(shops[2].url, "https://shop-d.example", "then the product link's origin");
});

test("a refund has no outfits and so no shops", () => {
  assert.deepEqual(shopsInResult({ status: "REFUND", outfits: [] }, envelope), []);
  assert.deepEqual(shopsInResult(null, null), []);
});

test("a piece the envelope does not know is skipped, not guessed", () => {
  assert.deepEqual(shopsInResult({ outfits: [{ items: [piece("zzz")] }] }, envelope), []);
});

// --- checking ---------------------------------------------------------------------

const shops = shopsInResult(result, envelope);

test("a verdict becomes trusted or flagged, with the model's text kept short", async () => {
  const answers = { "https://one.example/": verdict("a"), "https://two.example/": verdict("b", { redFlags: ["x".repeat(500), "2", "3", "4"], summary: "s".repeat(900) }) };
  const checked = await checkShops(shops.slice(0, 2), { check: async (url) => answers[url] });
  assert.deepEqual(checked.map((s) => [s.shop_id, s.status, s.label]), [["one", "trusted", "trustworthy"], ["two", "flagged", "not trustworthy"]]);
  assert.equal(checked[1].redFlags.length, 3);
  assert.equal(checked[1].redFlags[0].length, 200);
  assert.equal(checked[1].summary.length, 400);
});

test("a check that throws, rejects or has no address leaves that shop unchecked and the rest checked", async () => {
  const check = async (url) => {
    if (url === "https://one.example/") throw new Error("Too Many Requests");
    return verdict("a");
  };
  const checked = await checkShops([...shops.slice(0, 2), { shop_id: "x", name: "X", url: null }], { check });
  assert.deepEqual(checked.map((s) => s.status), ["unchecked", "trusted", "unchecked"]);
  assert.match(checked[0].error, /Too Many Requests/);
  assert.match(checked[2].error, /no shop address/);
});

test("a check that throws before it returns a promise is caught too", async () => {
  const checked = await checkShops(shops.slice(0, 1), { check: () => { throw new TypeError("boom"); } });
  assert.equal(checked[0].status, "unchecked");
});

test("a shop that does not answer in time is unchecked, not waited for", async () => {
  const started = Date.now();
  const checked = await checkShops(shops.slice(0, 1), { check: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(checked[0].status, "unchecked");
  assert.match(checked[0].error, /no answer within/);
  assert.ok(Date.now() - started < 2_000);
});

test("once the time budget is used up, the remaining shops are not started", async () => {
  let clock = 0;
  const calls = [];
  const check = async (url) => {
    calls.push(url);
    clock += 100_000; // each check takes 100 s on this clock
    return verdict("a");
  };
  const checked = await checkShops(shops, { check, budgetMs: 150_000, now: () => clock });
  assert.deepEqual(checked.map((s) => s.status), ["trusted", "trusted", "unchecked"]);
  assert.match(checked[2].error, /time for the trust check was used up/);
  assert.equal(calls.length, 2);
});

test("the stage stays inside the pipeline's three-minute limit", () => {
  assert.ok(TOTAL_BUDGET_MS < 180_000);
  assert.ok(SHOP_TIMEOUT_MS <= TOTAL_BUDGET_MS);
});

test("shops are checked one at a time, so the model's quota is spared", async () => {
  let inFlight = 0;
  let peak = 0;
  const check = async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return verdict("a");
  };
  await checkShops(shops, { check });
  assert.equal(peak, 1);
});

test("no shops means no checks", async () => {
  assert.deepEqual(await checkShops([], { check: () => assert.fail("checked") }), []);
});

test("the log line says what the page will show", () => {
  assert.equal(trustLine({ name: "One", status: "trusted", label: "trustworthy", confidence: 0.92, redFlags: [] }), "trust: One trustworthy, 92%");
  assert.equal(trustLine({ name: "Two", status: "flagged", label: "not trustworthy", confidence: null, redFlags: ["no imprint"] }), "trust: Two not trustworthy · no imprint");
  assert.equal(trustLine({ name: "Three", status: "unchecked", error: "HTTP 429" }), "trust: Three not checked (HTTP 429)");
});

// --- the command the pipeline runs: offline cases -----------------------------------

function runDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "trust-run-"));
  mkdirSync(join(dir, "person3"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

test("the command writes trust.json and exits 0 when there is nothing to check", () => {
  const refund = { status: "REFUND", outfits: [] };
  const dir = runDir({ "person3/result.json": refund, "person3.input.json": envelope });
  const run = spawnSync(process.execPath, ["logic/trust-shops.mjs", "--run", dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /trust: no shops to check/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "trust.json"), "utf8")).shops, []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "person3/result.json"), "utf8")), refund, "the result is never touched");
});

test("the command records a broken run folder instead of failing", () => {
  const dir = runDir({});
  const run = spawnSync(process.execPath, ["logic/trust-shops.mjs", "--run", dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /trust: not run/);
  assert.ok(JSON.parse(readFileSync(join(dir, "trust.json"), "utf8")).error);
});

test("the command without --run says how to use it", () => {
  const run = spawnSync(process.execPath, ["logic/trust-shops.mjs"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Usage: node logic\/trust-shops\.mjs --run/);
});

// --- it decides nothing --------------------------------------------------------------

test("the trust stage runs after the stylist, never stops the run, and nothing reads it but the page", () => {
  const pipeline = readFileSync("logic/run-pipeline.mjs", "utf8");
  const stage = pipeline.indexOf('"4b/4 shop trust check (shown only)"');
  assert.ok(stage > pipeline.indexOf('"4/4 stylist (Person 3)"'), "after the stylist has chosen");
  assert.ok(stage < pipeline.indexOf('"5/5 result page (Person 1)"'), "before the page that shows it");
  const body = pipeline.slice(stage, pipeline.indexOf('"5/5 result page (Person 1)"'));
  assert.match(body, /try \{/);
  assert.match(body, /return \{ ok: true \};/);
  assert.doesNotMatch(body, /return \{ ok: false/);
  // Only the page reads trust.json. The pipeline names the file only to clear
  // an old one; the stylist's input, the checks and the paid flow never see it.
  assert.doesNotMatch(pipeline, /readFile\([^;]*trustFile|JSON\.parse\([^;]*trust/);
  assert.match(pipeline, /rm\(path\.resolve\(ROOT, trustFile\), \{ force: true \}\)/);
  for (const file of ["logic/lead-agent.mjs", "paid-task.mjs", "worker.mjs", "logic/checkout.mjs", "person3/app/services/checks.py"])
    assert.doesNotMatch(readFileSync(file, "utf8"), /trust\.json|trust-shops/, file);
  assert.match(readFileSync("logic/result-page.mjs", "utf8"), /read\(at\("trust\.json"\), null\)/);
});

// --- the model's verdict -------------------------------------------------------------

const answering = (text) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
    }),
  });
const evidence = { storeUrl: "https://one.example/", domain: {}, homepage: { text: "" }, pages: [], imprint: {}, checks: {}, unreadablePages: [] };

test("a verdict with loose types is read, not thrown away", async () => {
  const v = await classifyStore(evidence, { model: answering(JSON.stringify({ verdict: "a", confidence: "0.8", summary: "ok" })) });
  assert.deepEqual([v.verdict, v.confidence, v.reasons, v.redFlags], ["a", 0.8, [], []]);
});

test("an answer without a clear a or b is a failed check, never a quiet 'not trustworthy'", async () => {
  for (const answer of [{ confidence: 0.9 }, { verdict: "c" }, { verdict: "trustworthy" }, ["a"]])
    await assert.rejects(classifyStore(evidence, { model: answering(JSON.stringify(answer)) }), undefined, JSON.stringify(answer));
});

// --- the page ----------------------------------------------------------------------

const page = (trust) =>
  renderPage({
    result: { status: "APPROVED", guarantees: {}, outfits: [{ name: "Look", items: [{ ...piece("a"), layer: "base", size: "M", price: { amount: 10, currency: "EUR" } }], totals: {} }] },
    envelope,
    live: {},
    trust,
  });

test("each piece names its shop's check, and the shops section explains it decided nothing", () => {
  const html = page({ shops: [{ shop_id: "one", name: "One Shop", status: "trusted", confidence: 0.9, summary: "Real imprint.", redFlags: [] }] });
  assert.match(html, /<span class="fresh">shop checked<\/span>/);
  assert.match(html, /<h3>The shops<\/h3>/);
  assert.match(html, /did not change which pieces were chosen/);
  assert.match(html, /One Shop<\/strong><span class="fresh">looks trustworthy · 90% confidence/);
});

test("a flagged shop is shown with its red flags, an unchecked one says so", () => {
  const html = page({
    shops: [
      { shop_id: "one", name: "One Shop", status: "flagged", confidence: 0.7, summary: "", redFlags: ["No imprint found"] },
      { shop_id: "two", name: "Two Shop", status: "unchecked", error: "HTTP 429" },
    ],
  });
  assert.match(html, /<span class="stale">shop flagged, see below<\/span>/);
  assert.match(html, /flagged as not trustworthy · 70% confidence/);
  assert.match(html, /<ul class="flags"><li>No imprint found<\/li><\/ul>/);
  assert.match(html, /Two Shop<\/strong><span class="muted">could not be checked<\/span>/);
  assert.ok(!html.includes("HTTP 429"), "the technical error stays in the log");
});

test("the model's text about a shop is escaped", () => {
  const html = page({ shops: [{ shop_id: "one", name: "<b>One</b>", status: "flagged", summary: "<script>x</script>", redFlags: ["<img src=x>"] }] });
  assert.ok(!html.includes("<script>x") && !html.includes("<img src=x>") && !html.includes("<b>One</b>"));
});

test("a check that did not run says so, and no check means no section", () => {
  assert.match(page({ shops: [], error: "ENOENT" }), /The shop check did not run this time/);
  assert.match(page({ shops: [] }), /There were no shops to check/);
  assert.ok(!page(null).includes('class="shops"'));
  assert.ok(!page(null).includes("shop checked"));
});
