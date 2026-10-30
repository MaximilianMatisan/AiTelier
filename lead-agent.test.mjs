import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipelineAnswer, formatResult } from "./logic/lead-agent.mjs";
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
