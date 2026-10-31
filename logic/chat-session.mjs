// The conversation, given a place to live. logic/conversation.mjs is pure: it
// takes a state and a message and says what should happen. This file is the
// part that keeps the state on disk, runs the pipeline a turn asks for, and
// hands a confirmed outfit to logic/checkout.mjs.
//
// Both surfaces use it: comments.mjs for a Sokosumi task thread (one
// conversation per Task, `.local/<task-id>-chat.json`) and ui/server.mjs for
// the studio page, which drives the pipeline itself so it can show the stages.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { newConversation, nextTurn, presentOutfits, recordCheckout, mergeSlots } from "./conversation.mjs";
import { payForOutfit } from "./checkout.mjs";
import { runPipeline } from "./lead-agent.mjs";
import { publishPage } from "./publish.mjs";
import { logger } from "../log.mjs";
const log = logger("chat");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = ".local";
const RUN_TIMEOUT_MS = 10 * 60_000;

export function chatPath(id, dir = STATE_DIR) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error("A conversation id may hold only letters, digits, - and _");
  return path.join(dir, `${id}-chat.json`);
}

/** The saved conversation, or a new one. */
export function loadChat(id, { dir = STATE_DIR } = {}) {
  const file = chatPath(id, dir);
  if (!existsSync(file)) return newConversation(id);
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    return { ...newConversation(id), ...state, id: String(id) };
  } catch (error) {
    log.warn("unreadable conversation, starting a new one", { conversation: id, error: error.message });
    return newConversation(id);
  }
}

export function saveChat(state, { dir = STATE_DIR } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(chatPath(state.id, dir), JSON.stringify(state), { mode: 0o600 });
  return state;
}

/**
 * Picks a finished run up as the start of a conversation: the order it ran
 * becomes the draft, the looks it produced become the ones on the table. That
 * is what lets a customer answer the result of their Task with "buy outfit 2"
 * instead of describing everything again.
 */
export async function seedFromRun(state, { taskId, root = ROOT } = {}) {
  const dir = path.join(root, "catalog", "cache", "run", taskId);
  const read = async (file) => {
    try {
      return JSON.parse(await readFile(path.join(dir, file), "utf8"));
    } catch {
      return null;
    }
  };
  const order = await read("order.json");
  const result = await read(path.join("person3", "result.json"));
  if (!order && !result) return state;
  let next = { ...state };
  // A free-text brief carries no slots to merge; the stylist read it directly.
  if (order && !order.brief) next.draft = mergeSlots(next.draft, order).draft;
  if (result?.outfits?.length) {
    // Silent: the customer has already read these looks as the Task result.
    next = presentOutfits(next, result).state;
    next.messages = state.messages;
  }
  log.info("conversation seeded from the finished run", { conversation: state.id, outfits: next.outfits.length });
  return next;
}

/** Runs the pipeline for one conversation turn and returns Person 3's result. */
export async function runPipelineForChat(order, { id, root = ROOT, run = runPipeline, publish = publishPage, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const outDir = path.join("catalog", "cache", "run", `${id}-${Date.now().toString(36)}`);
  await mkdir(path.join(root, outDir, "person3"), { recursive: true });
  await writeFile(path.join(root, outDir, "order.json"), JSON.stringify(order, null, 2) + "\n");
  const args = ["logic/run-pipeline.mjs", "--order", path.join(outDir, "order.json"), "--out", outDir];
  if (process.env.AITELIER_SHORTLIST) args.push("--shortlist", process.env.AITELIER_SHORTLIST);
  log.info("styling for a conversation", { conversation: id, outDir });
  const ok = await run(args, timeoutMs, path.join(root, outDir, "pipeline.log"));
  if (!ok) {
    log.error("styling failed", { conversation: id, log: `${outDir}/pipeline.log` });
    return { ok: false, outDir, result: null };
  }
  const result = JSON.parse(await readFile(path.join(root, outDir, "person3", "result.json"), "utf8"));
  // The same page the Task result links to: the chat shows the looks as text,
  // the page carries the boards and every check behind them.
  const page = await publish(outDir);
  return { ok: true, outDir, result, page };
}

/**
 * One turn, with the work it asks for carried out.
 *
 * `runStyling(order)` is optional: a surface that wants to show progress while
 * the pipeline runs (the studio page) leaves it out, gets the `run_pipeline`
 * action back and calls presentOutfits() itself when its run finishes.
 * `pay` is the payment module hook from logic/checkout.mjs.
 *
 * Returns the new state, everything the customer should be told in order, and
 * the action that is still the caller's to perform.
 */
export async function runTurn(state, text, { ask = null, pay, env = process.env, runStyling = null } = {}) {
  const turn = await nextTurn(state, text, { ask });
  const posts = [turn.reply];
  let next = turn.state;

  if (turn.action.type === "run_pipeline" && runStyling) {
    const { ok, result, page } = await runStyling(turn.action.order);
    if (!ok) {
      next = { ...next, status: "ready", run: null };
      posts.push("The styling run stopped before it finished, so there is nothing to show and nothing was charged. Shall I try again?");
      return { state: next, posts, action: { type: "none" } };
    }
    const presented = presentOutfits(next, result, { page });
    next = presented.state;
    posts.push(presented.reply);
    return { state: next, posts, action: { type: "none" } };
  }

  if (turn.action.type === "checkout") {
    const { outcome } = await payForOutfit(turn.action.outfit, {
      conversationId: next.id,
      budget_eur: next.draft.budget_eur ?? null,
      pay,
      env,
    });
    const recorded = recordCheckout(next, outcome, { outfit: turn.action.outfit });
    next = recorded.state;
    posts.push(recorded.reply);
    return { state: next, posts, action: { type: "none" } };
  }

  return { state: next, posts, action: turn.action };
}
