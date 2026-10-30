import test from "node:test";
import assert from "node:assert/strict";
import { format, fields } from "./log.mjs";

const at = new Date(2026, 9, 30, 20, 5, 12);

test("a line carries time, level, area, short task ID, message and fields", () => {
  assert.equal(
    format("info", "paid", "stage", { task: "01a18e2f-ccc4-75b8", from: "awaiting-escrow", to: "model-pending" }, at),
    "2026-10-30 20:05:12 INFO  [paid] 01a18e2f-ccc4-75b8 stage from=awaiting-escrow to=model-pending",
  );
  assert.equal(format("warn", "worker", "tasks", {}, at), "2026-10-30 20:05:12 WARN  [worker] tasks");
});

test("Tasks created in the same minute keep separate IDs in the log", () => {
  // UUIDv7: the first 12 hex characters are the creation millisecond, so these
  // two real Task IDs shared their first 8. Logged under 8 they read as one
  // Task walking backwards through its stages.
  const one = format("info", "paid", "stage", { task: "01a18e5d-aa21-765d-8b2e-09834cdac68b" }, at);
  const two = format("info", "paid", "stage", { task: "01a18e5d-c2f1-76fb-a606-734af2f1a94d" }, at);
  assert.notEqual(one, two);
});

test("fields quote spaces, skip undefined and cut long values", () => {
  assert.equal(fields({ a: 1, b: undefined, c: "two words", d: ["x"] }), 'a=1 c="two words" d=["x"]');
  assert.ok(fields({ e: "x".repeat(500) }).length < 220);
});
