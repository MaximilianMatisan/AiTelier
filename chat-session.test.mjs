import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatPath, loadChat, saveChat, seedFromRun, runTurn, runPipelineForChat } from "./logic/chat-session.mjs";
import { newConversation, presentOutfits } from "./logic/conversation.mjs";

const FULL = "Zwei Outfits old money für Herbst, Budget 400 EUR, Größe M, Hose 32, Schuhe 43";

const result = {
  status: "APPROVED",
  outfits: [
    {
      outfit_id: "look-1",
      name: "Rainy Munich Classic",
      items: [{ item_id: "a", title: "Oxford Shirt", brand: "Atelier", size: "M", price: { amount: 100, currency: "EUR" }, product_url: "https://shop.example/a" }],
      totals: { grand_total: 100, shipping: 0, currency: "EUR" },
      guarantees: { ok: true },
    },
  ],
};

const temp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aitelier-chat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a conversation id has to be a safe file name", () => {
  assert.equal(chatPath("chat-ui-abc123", ".local"), path.join(".local", "chat-ui-abc123-chat.json"));
  assert.throws(() => chatPath("../../etc/passwd"), /letters, digits/);
});

test("a conversation survives a restart", (t) => {
  const dir = temp(t);
  const state = { ...newConversation("chat-1"), status: "ready", draft: { budget_eur: 400 } };
  saveChat(state, { dir });
  const loaded = loadChat("chat-1", { dir });
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.draft.budget_eur, 400);
  // The file holds a conversation, so it is not world-readable.
  assert.equal(JSON.parse(readFileSync(chatPath("chat-1", dir), "utf8")).id, "chat-1");
});

test("an unreadable conversation starts a new one instead of throwing", (t) => {
  const dir = temp(t);
  writeFileSync(chatPath("chat-2", dir), "{ not json");
  const loaded = loadChat("chat-2", { dir });
  assert.equal(loaded.status, "collecting");
  assert.deepEqual(loaded.messages, []);
});

test("a finished run becomes the start of the conversation about it", async (t) => {
  const root = temp(t);
  const dir = path.join(root, "catalog", "cache", "run", "task-7", "person3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, "catalog", "cache", "run", "task-7", "order.json"), JSON.stringify({ budget_eur: 400, outfits: 1, theme: "old_money", season: "autumn", sizes: { top: "M", waist: "32", shoe_eu: "43" } }));
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));

  const seeded = await seedFromRun(newConversation("task-7"), { taskId: "task-7", root });
  assert.equal(seeded.status, "presented");
  assert.equal(seeded.outfits.length, 1);
  assert.equal(seeded.draft.budget_eur, 400);
  // The customer has already read these looks as the Task result.
  assert.deepEqual(seeded.messages, []);

  // "buy outfit 1" now works as the first comment on the Task.
  const turn = await runTurn(seeded, "outfit 1");
  assert.equal(turn.state.status, "selected");
});

test("a run that never happened leaves the conversation untouched", async (t) => {
  const root = temp(t);
  const state = newConversation("task-8");
  assert.deepEqual(await seedFromRun(state, { taskId: "task-8", root }), state);
});

test("a complete order runs the pipeline and comes back with the looks", async () => {
  let order;
  const { state, posts } = await runTurn({ ...newConversation("chat-3"), status: "ready", draft: { budget_eur: 400, outfits: 1, theme: "old_money", season: "autumn", sizes: { top: "M", waist: "32", shoe_eu: "43" } } }, "ja bitte", {
    runStyling: async (given) => ((order = given), { ok: true, result }),
  });
  assert.equal(order.budget_eur, 400);
  assert.equal(state.status, "presented");
  assert.equal(posts.length, 2);
  assert.match(posts[0], /searching the shops/);
  assert.match(posts[1], /Rainy Munich Classic/);
});

test("a pipeline that fails says so and charges nothing", async () => {
  const { state, posts } = await runTurn({ ...newConversation("chat-4"), status: "ready", draft: { budget_eur: 400, outfits: 1, theme: "casual", season: "summer", sizes: { top: "M", waist: "32", shoe_eu: "43" } } }, "ja", {
    runStyling: async () => ({ ok: false, result: null }),
  });
  assert.equal(state.status, "ready");
  assert.match(posts.at(-1), /nothing was charged/);
});

test("a confirmed outfit reaches the payment module and the receipt reaches the customer", async () => {
  let paid;
  const presented = presentOutfits({ ...newConversation("chat-5"), draft: { budget_eur: 400 } }, result).state;
  const selected = (await runTurn(presented, "outfit 1")).state;
  const { state, posts } = await runTurn(selected, "ja, kaufen", {
    pay: async (purchase) => ((paid = purchase), { status: "paid", txHash: "tx-1" }),
  });
  assert.equal(paid.purchase_id, "chat-5:look-1");
  assert.equal(paid.total, 100);
  assert.equal(paid.budget_eur, 400);
  assert.equal(state.status, "paid");
  assert.match(posts.at(-1), /Paid: \*\*Rainy Munich Classic\*\*/);
  assert.match(posts.at(-1), /tx-1/);
});

test("without a payment module the confirmation ends in a plain refusal", async () => {
  const presented = presentOutfits(newConversation("chat-6"), result).state;
  const selected = (await runTurn(presented, "outfit 1")).state;
  const { state, posts } = await runTurn(selected, "ja", { env: {} });
  assert.equal(state.status, "selected");
  assert.match(posts.at(-1), /No payment provider is wired in yet/);
});

test("a turn that needs nothing done hands its action back to the surface", async () => {
  const { action } = await runTurn(newConversation("chat-7"), FULL);
  assert.equal(action.type, "none");
  const go = await runTurn({ ...newConversation("chat-7"), status: "ready", draft: { budget_eur: 400, outfits: 1, theme: "casual", season: "autumn", sizes: { top: "M", waist: "32", shoe_eu: "43" } } }, "ja");
  // No runStyling: the studio page starts the run itself so it can show stages.
  assert.equal(go.action.type, "run_pipeline");
  assert.equal(go.state.status, "styling");
});

test("the pipeline is run in its own folder, with the order written for it", async (t) => {
  const root = temp(t);
  let args;
  const { ok, outDir, result: got } = await runPipelineForChat({ budget_eur: 400 }, {
    id: "chat-9",
    root,
    run: async (given) => {
      args = given;
      writeFileSync(path.join(root, given.at(-1), "person3", "result.json"), JSON.stringify(result));
      return true;
    },
  });
  assert.equal(ok, true);
  assert.match(outDir, /^catalog\/cache\/run\/chat-9-/);
  assert.equal(args[0], "logic/run-pipeline.mjs");
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, outDir, "order.json"), "utf8")), { budget_eur: 400 });
  assert.equal(got.outfits.length, 1);
});

test("a chat styling run publishes the result page and links it", async (t) => {
  const root = temp(t);
  let published;
  const styled = await runPipelineForChat({ budget_eur: 400 }, {
    id: "chat-10",
    root,
    run: async (given) => (writeFileSync(path.join(root, given.at(-1), "person3", "result.json"), JSON.stringify(result)), true),
    publish: async (outDir) => ((published = outDir), "https://aitelier.pages.dev/runs/x/"),
  });
  assert.equal(published, styled.outDir);
  assert.equal(styled.page, "https://aitelier.pages.dev/runs/x/");

  const { posts } = await runTurn(
    { ...newConversation("chat-10"), status: "ready", draft: { budget_eur: 400, outfits: 1, theme: "casual", season: "autumn", sizes: { top: "M", waist: "32", shoe_eu: "43" } } },
    "ja",
    { runStyling: async () => styled },
  );
  assert.match(posts.at(-1), /Your AiTelier page.*aitelier\.pages\.dev\/runs\/x/);
});
