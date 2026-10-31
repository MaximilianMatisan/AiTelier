import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  pipelineAnswer,
  formatResult,
  failedGuarantees,
  embedImages,
  collapseWarnings,
} from "./logic/lead-agent.mjs";
import { TEMPLATE } from "./logic/intake.mjs";

const order = JSON.stringify({ ...TEMPLATE, needed_by: undefined });
const journalFor = (id) => path.join(tmpdir(), `${id}-session.json`);
const cleanup = (id) => rmSync(path.join("catalog", "cache", "run", id), { recursive: true, force: true });

test("a refused order never starts the pipeline", async () => {
  let ran = false;
  const text = await pipelineAnswer('{"theme": "punk"}', journalFor("lead-refused"), undefined, {
    run: async () => (ran = true),
  });
  assert.equal(ran, false);
  assert.match(text, /could not start this order/);
});

test("a good order runs the pipeline and returns Person 3's result", async (t) => {
  const id = "lead-ok";
  t.after(() => cleanup(id));
  let args;
  const text = await pipelineAnswer(order, journalFor(id), undefined, {
    run: async (a) => {
      args = a;
      const dir = path.join("catalog", "cache", "run", id, "person3");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "result.json"), JSON.stringify({ status: "APPROVED", markdown: "# Looks ready" }));
      return true;
    },
  });
  assert.equal(text, "# Looks ready");
  // Relative paths: run-pipeline.mjs hands them on to Person 3 from person3/.
  // --task-id names the run and keeps each Task's look boards apart; without
  // it Person 3 wrote every run's images to one shared folder.
  assert.deepEqual(args, [
    "logic/run-pipeline.mjs",
    "--order", `catalog/cache/run/${id}/order.json`,
    "--out", `catalog/cache/run/${id}`,
    "--task-id", id,
  ]);
});

test("a failed pipeline throws instead of submitting a result", async (t) => {
  t.after(() => cleanup("lead-fail"));
  await assert.rejects(pipelineAnswer(order, journalFor("lead-fail"), undefined, { run: async () => false }), /Pipeline failed/);
});

test("a paid deadline too close to run refuses before starting", async (t) => {
  t.after(() => cleanup("lead-late"));
  let ran = false;
  await assert.rejects(
    pipelineAnswer(order, journalFor("lead-late"), Date.now() + 5_000, { run: async () => (ran = true) }),
    /deadline/,
  );
  assert.equal(ran, false);
});

test("a result without markdown still names outfits, links and the reason", () => {
  const text = formatResult({
    status: "REFUND",
    outfits: [{ name: "Look", items: [{ title: "Coat", brand: "B", size: "M", price: { amount: 99, currency: "EUR" }, product_url: "https://x" }] }],
    decision: { reason: "size M is not in stock" },
  });
  assert.match(text, /REFUND/);
  assert.match(text, /Coat \(B\), size M, 99 EUR: https:\/\/x/);
  assert.match(text, /not in stock/);
});

test("a REFUND is not submitted, so the escrow can return the money", async (t) => {
  // Submitting a result is what moves the escrow towards paying us. An agent
  // that submits a REFUND charges for work it has just declared unfit.
  const id = "lead-refund";
  t.after(() => cleanup(id));
  const error = await pipelineAnswer(order, journalFor(id), undefined, {
    run: async () => {
      const dir = path.join("catalog", "cache", "run", id, "person3");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          status: "REFUND",
          guarantees: {
            budget: { ok: false, detail: "341.90 EUR <= 300.00 EUR" },
            fit: { ok: true, detail: "sizes compatible" },
            availability: { ok: false, detail: "no outfit passed" },
          },
          markdown: "# looks",
        }),
      );
      return true;
    },
  }).then(() => null, (e) => e);
  assert.ok(error, "a REFUND must not resolve with a result");
  assert.equal(error.refund, true, "callers tell a refund apart from a crash by this flag");
  assert.deepEqual(error.failed, [
    "budget: 341.90 EUR <= 300.00 EUR",
    "availability: no outfit passed",
  ]);
  const journal = JSON.parse(readFileSync(journalFor(id), "utf8"));
  assert.equal(journal.phase, "refund", "the refusal is recorded, not lost in a crash log");
});

test("images are embedded, so the customer's viewer loads nothing from a server", async (t) => {
  const dir = path.join(tmpdir(), "embed-test");
  mkdirSync(path.join(dir, "task"), { recursive: true });
  writeFileSync(path.join(dir, "task", "look-1-board.jpg"), "board");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markdown = [
    "![Look board](http://127.0.0.1:21951/artifacts/task/look-1-board.jpg)",
    "![Shop photo](https://cdn.example/shoe.jpg)",
    "![Gone](http://127.0.0.1:21951/artifacts/task/missing.jpg)",
  ].join("\n");
  const shrink = (files) => files.map((f) => Buffer.from(readFileSync(f)).toString("base64"));
  const fetchImpl = async () => new Response("photo");
  const out = await embedImages(markdown, { artifactDir: dir, workDir: dir, shrink, fetchImpl });
  assert.equal(
    out,
    [
      `![Look board](data:image/jpeg;base64,${Buffer.from("board").toString("base64")})`,
      `![Shop photo](data:image/jpeg;base64,${Buffer.from("photo").toString("base64")})`,
      "_Gone_",
    ].join("\n"),
  );
  assert.doesNotMatch(out, /https?:\/\//, "no image address is left for the viewer to load");
});

test("failedGuarantees names only the checks that did not hold", () => {
  const named = failedGuarantees({
    guarantees: { budget: { ok: true }, fit: { ok: false, detail: "size M gone" }, delivery: { ok: false } },
  });
  assert.deepEqual(named, ["fit: size M gone", "delivery: failed"]);
  assert.deepEqual(failedGuarantees({}), []);
});

// Person 3 reports one warning per shop, so an ordinary run listed
// GUARANTEE_ASSUMED twenty-one times and pushed the outfit off the screen.
test("a repeated warning is counted, not listed twenty-one times", () => {
  const collapsed = collapseWarnings(
    "Warnings: " + Array(21).fill("GUARANTEE_ASSUMED").join("; ") + "; MISSING_DESCRIPTION; LLM_FALLBACK",
  );
  assert.equal(collapsed, "Warnings: GUARANTEE_ASSUMED \u00d721, MISSING_DESCRIPTION, LLM_FALLBACK");
});

test("collapsing warnings leaves the rest of the result alone", () => {
  const markdown = [
    "# Look one",
    "- Coat, size M",
    "Guarantees: budget=OK, fit=OK",
    "Warnings: A; A; B",
    "",
    "_rationale_",
  ].join("\n");
  const collapsed = collapseWarnings(markdown);
  assert.match(collapsed, /^Warnings: A \u00d72, B$/m);
  assert.match(collapsed, /^# Look one$/m);
  assert.match(collapsed, /^- Coat, size M$/m);
  assert.match(collapsed, /^Guarantees: budget=OK, fit=OK$/m);
  assert.ok(collapsed.includes("_rationale_"));
});

test("a single warning keeps its plain wording", () => {
  assert.equal(collapseWarnings("Warnings: LLM_FALLBACK"), "Warnings: LLM_FALLBACK");
  assert.equal(collapseWarnings("no warnings here"), "no warnings here");
});

test("a run that failed on a provider outage is repeated, any other failure is not", async (t) => {
  const { runPipelineRetrying } = await import("./logic/lead-agent.mjs");
  const dir = path.join(tmpdir(), `retry-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, "pipeline.log");
  const noWait = { waits: [1, 1], sleep: async () => {}, minRunMs: 0 };

  let calls = 0;
  const flaky = async (_args, _ms, file) => {
    calls++;
    if (calls === 1) {
      writeFileSync(file, "Candidate filter failed: AI_APICallError: Service Unavailable\n", { flag: "a" });
      return false;
    }
    return true;
  };
  assert.equal(await runPipelineRetrying(flaky, [], 60_000, logFile, noWait), true);
  assert.equal(calls, 2);

  calls = 0;
  const broken = async (_args, _ms, file) => {
    calls++;
    writeFileSync(file, "TypeError: cannot read properties of undefined\n", { flag: "a" });
    return false;
  };
  assert.equal(await runPipelineRetrying(broken, [], 60_000, logFile, noWait), false);
  // The outage line from the first test is still in the log: only what this
  // attempt wrote decides, so a broken stage is not retried on old evidence.
  assert.equal(calls, 1);

  calls = 0;
  const down = async (_args, _ms, file) => {
    calls++;
    writeFileSync(file, "429 Too Many Requests\n", { flag: "a" });
    return false;
  };
  assert.equal(await runPipelineRetrying(down, [], 60_000, logFile, noWait), false);
  assert.equal(calls, 3, "two retries, then it gives up");
});
