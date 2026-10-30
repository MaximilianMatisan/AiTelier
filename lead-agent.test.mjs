import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipelineAnswer, formatResult, failedGuarantees, embedImages } from "./logic/lead-agent.mjs";
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
  assert.deepEqual(args, ["logic/run-pipeline.mjs", "--order", `catalog/cache/run/${id}/order.json`, "--out", `catalog/cache/run/${id}`]);
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
