// AiTelier studio · a local page where a customer enters an order, watches
// the pipeline work, and sees the result the agent sends as A2UI.
//
//   npm run ui                       http://127.0.0.1:21960
//   AITELIER_UI_PORT=8080 npm run ui
//
// The page never talks to the pipeline directly. This server checks the
// order with step 1, starts logic/run-pipeline.mjs through the Lead-Agent's
// runner, reports which stage the log has reached, and serves the outfit
// boards Person 3 renders. One run at a time: Person 3 writes its images to
// a fixed artifact folder.
//
// Two ways in, one pipeline: the form posts a finished order to /api/runs, and
// the chat talks to logic/conversation.mjs over /api/chat, which collects the
// order over several turns, starts a run when it is complete, shows the looks
// and takes the confirmation that hands one to logic/checkout.mjs.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readOrder } from "../logic/intake.mjs";
import { runPipeline } from "../logic/lead-agent.mjs";
import { appendMessage, conversationAsker, conversationModel, presentOutfits } from "../logic/conversation.mjs";
import { loadChat, saveChat, runTurn } from "../logic/chat-session.mjs";
import { logger } from "../log.mjs";
const log = logger("studio");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(ROOT, "ui");
const ARTIFACT_DIR = path.join(ROOT, "person3", "artifacts");
const PORT = Number(process.env.AITELIER_UI_PORT ?? 21960);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_TIMEOUT_MS = 10 * 60_000;

// What each stage line in run-pipeline.mjs's log means to a customer.
export const STAGES = [
  { marker: "=== 1/4 ", label: "Shortlisting products", detail: "Matching your brief against the catalogue of real shops." },
  { marker: "=== 2/4 ", label: "Preparing the catalogue", detail: "Turning the shortlist into what the stylist reads." },
  { marker: "=== 3/4 ", label: "Writing your profile", detail: "Budget, sizes, season and style for the stylist." },
  { marker: "=== 3b/4 ", label: "Removing sizes you cannot buy", detail: "Sold-out and missing sizes never reach the stylist." },
  { marker: "=== 4/4 ", label: "Styling and checking", detail: "The AI stylist picks looks, then code checks five guarantees." },
];

/** Stage states from the pipeline log: done, running or pending. */
export function progress(log, finished) {
  const reached = STAGES.map((s) => log.includes(s.marker));
  const current = reached.lastIndexOf(true);
  return STAGES.map(({ label, detail }, i) => ({
    label,
    detail,
    state: i < current || (finished && i <= current) ? "done" : i === current ? "running" : "pending",
  }));
}

/** A path under base, or null when the request tries to leave it. */
export function inside(base, requested) {
  const resolved = path.resolve(base, "." + path.sep + decodeURIComponent(requested));
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

const runs = new Map();
let active = null;

/** Starts one pipeline run for a checked order. One at a time. */
async function createRun(order, { fast = false } = {}) {
  if (active) return { error: "Another order is still being styled. Try again when it finishes." };

  const id = `ui-${randomUUID().slice(0, 8)}`;
  const outDir = path.join("catalog", "cache", "run", id);
  await mkdir(path.join(ROOT, outDir), { recursive: true });
  const orderFile = path.join(outDir, "order.json");
  await writeFile(path.join(ROOT, orderFile), JSON.stringify(order, null, 2) + "\n");

  const args = ["logic/run-pipeline.mjs", "--order", orderFile, "--out", outDir];
  const shortlist = fast ? "catalog/cache/shortlist.demo.json" : process.env.AITELIER_SHORTLIST;
  if (shortlist) args.push("--shortlist", shortlist);

  const run = { id, outDir, order, startedAt: Date.now(), state: "running" };
  runs.set(id, run);
  active = id;
  log.info("run started", { run: id, fast: Boolean(fast) });
  runPipeline(args, RUN_TIMEOUT_MS, path.join(ROOT, outDir, "pipeline.log")).then((ok) => {
    run.state = ok ? "done" : "failed";
    log[ok ? "info" : "error"]("run finished", { run: id, state: run.state, seconds: Math.round((Date.now() - run.startedAt) / 1000) });
    run.finishedAt = Date.now();
    active = null;
  });
  return { run };
}

async function startRun(body) {
  const intake = readOrder(JSON.stringify(body.order ?? {}));
  if (!intake.ok) return { status: 400, json: { errors: intake.errors, warnings: intake.warnings } };
  const { run, error } = await createRun(intake.order, { fast: body.fast });
  if (error) return { status: 409, json: { errors: [error] } };
  return { status: 202, json: { id: run.id, order: intake.order, warnings: intake.warnings } };
}

async function runStatus(id) {
  const run = runs.get(id);
  if (!run) return { status: 404, json: { errors: ["Unknown run."] } };
  const log = await readFile(path.join(ROOT, run.outDir, "pipeline.log"), "utf8").catch(() => "");
  const json = {
    id,
    state: run.state,
    seconds: Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
    stages: progress(log, run.state !== "running"),
  };
  if (run.state === "done") {
    const result = JSON.parse(await readFile(path.join(ROOT, run.outDir, "person3", "result.json"), "utf8"));
    json.result = { status: result.status, a2ui: result.a2ui, markdown: result.markdown };
  }
  if (run.state === "failed") json.error = log.trim().split("\n").slice(-6).join("\n");
  return { status: 200, json };
}

/* -------------------------------- the chat -------------------------------- */

const CHAT_ID = /^chat-ui-[0-9a-f]{8}$/;
const chats = new Map();
let asker;

/** The model hook, built once for every conversation on this server. */
async function ask() {
  if (asker === undefined) asker = conversationAsker({ model: await conversationModel() });
  return asker;
}

function chatFor(id) {
  if (!chats.has(id)) chats.set(id, loadChat(id));
  return chats.get(id);
}

/** Kept in memory for this page and on disk so a restart does not lose it. */
function keep(state) {
  chats.set(state.id, state);
  try {
    saveChat(state);
  } catch (error) {
    log.warn("conversation not saved", { conversation: state.id, error: error.message });
  }
  return state;
}

/**
 * Folds a finished run into the conversation it was started for. The page
 * polls while the pipeline works, so this is where "styling" becomes looks the
 * customer can pick from.
 */
async function settleRun(state) {
  if (state.status !== "styling" || !state.run?.id) return state;
  const run = runs.get(state.run.id);
  if (!run || run.state === "running") return state;
  if (run.state === "failed")
    return keep(appendMessage({ ...state, status: "ready", run: null }, "agent", "The styling run stopped before it finished, so there is nothing to show and nothing was charged. Shall I try again?"));
  try {
    const result = JSON.parse(await readFile(path.join(ROOT, run.outDir, "person3", "result.json"), "utf8"));
    return keep(presentOutfits(state, result).state);
  } catch (error) {
    return keep(appendMessage({ ...state, status: "ready", run: null }, "agent", `I could not read the result of that run: ${error.message}`));
  }
}

async function chatView(state) {
  const run = state.run?.id ? runs.get(state.run.id) : null;
  const logText = run ? await readFile(path.join(ROOT, run.outDir, "pipeline.log"), "utf8").catch(() => "") : "";
  return {
    id: state.id,
    status: state.status,
    draft: state.draft,
    messages: state.messages,
    outfits: state.outfits,
    selection: state.selection,
    checkout: state.checkout,
    run: run
      ? {
          id: run.id,
          state: run.state,
          seconds: Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
          stages: progress(logText, run.state !== "running"),
        }
      : null,
  };
}

async function chatTurn(body) {
  const id = CHAT_ID.test(String(body.id ?? "")) ? body.id : `chat-ui-${randomUUID().slice(0, 8)}`;
  const text = String(body.text ?? "");
  if (!text.trim()) return { status: 400, json: { errors: ["Say something to the stylist first."] } };

  let state = await settleRun(chatFor(id));
  // runStyling is left out on purpose: the page wants the stages while the
  // pipeline works, so the run is started here and settled on the next poll.
  const turn = await runTurn(state, text, { ask: await ask() });
  state = turn.state;
  if (turn.action.type === "run_pipeline") {
    const { run, error } = await createRun(turn.action.order, { fast: body.fast !== false });
    state = error ? appendMessage({ ...state, status: "ready", run: null }, "agent", error) : { ...state, run: { id: run.id } };
  }
  log.info("chat turn", { conversation: id, status: state.status });
  return { status: 200, json: await chatView(keep(state)) };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png" };

async function sendFile(res, file) {
  // Only page assets and images; never the server's own source.
  if (!file || !TYPES[path.extname(file)] || !existsSync(file)) return send(res, 404, { errors: ["Not found."] });
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(file));
}

function send(res, status, json) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(json));
}

async function readBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64_000) throw new Error("Order too large");
  }
  return JSON.parse(text || "{}");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE);
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const { status, json } = await startRun(await readBody(req));
      return send(res, status, json);
    }
    const match = url.pathname.match(/^\/api\/runs\/(ui-[0-9a-f]{8})$/);
    if (req.method === "GET" && match) {
      const { status, json } = await runStatus(match[1]);
      return send(res, status, json);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { status, json } = await chatTurn(await readBody(req));
      return send(res, status, json);
    }
    const chat = url.pathname.match(/^\/api\/chat\/(chat-ui-[0-9a-f]{8})$/);
    if (req.method === "GET" && chat) {
      return send(res, 200, await chatView(await settleRun(chatFor(chat[1]))));
    }
    if (req.method === "GET" && url.pathname.startsWith("/artifacts/"))
      return sendFile(res, inside(ARTIFACT_DIR, url.pathname.slice("/artifacts/".length)));
    if (req.method === "GET") return sendFile(res, inside(UI_DIR, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
    send(res, 405, { errors: ["Method not allowed."] });
  } catch (error) {
    send(res, 400, { errors: [error.message] });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Person 3 builds image URLs from this, so the boards load from this server.
  process.env.ARTIFACT_BASE_URL = BASE;
  server.listen(PORT, "127.0.0.1", () => log.info("started", { url: BASE }));
}
