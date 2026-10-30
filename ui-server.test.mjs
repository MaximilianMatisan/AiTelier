import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { progress, inside, STAGES } from "./ui/server.mjs";

const states = (log, finished = false) => progress(log, finished).map((s) => s.state);

test("progress follows the stage lines run-pipeline.mjs prints", () => {
  assert.deepEqual(states(""), ["pending", "pending", "pending", "pending", "pending"]);
  assert.deepEqual(states("=== 1/4 candidateFilter\n=== 2/4 to_person3\n"), ["done", "running", "pending", "pending", "pending"]);
  const all = STAGES.map((s) => s.marker).join("x\n");
  assert.deepEqual(states(all), ["done", "done", "done", "done", "running"]);
  assert.deepEqual(states(all, true), ["done", "done", "done", "done", "done"]);
});

test("static and artifact paths cannot leave their folder", () => {
  const base = path.resolve("ui");
  assert.equal(inside(base, "index.html"), path.join(base, "index.html"));
  assert.equal(inside(base, "../.env"), null);
  assert.equal(inside(base, "%2e%2e/.env"), null);
  assert.equal(inside(base, "../../etc/passwd"), null);
});
