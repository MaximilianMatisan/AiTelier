import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { acquireWorkerLock } from "./worker-lock.mjs";
import { answer, client } from "./client.mjs";
import { reply } from "./comments.mjs";
import { createPaidAdapter, paidMode, unpaidFailure, REFUND_WORD } from "./paid-task.mjs";
import {
  taskTarget,
  isTaskForTarget,
  closeTaskWithoutResult,
  postTaskComment,
} from "./task-target.mjs";
import { pipelineAnswer } from "./logic/lead-agent.mjs";
import { reviewOrder, welcome } from "./logic/intake.mjs";
import { logger } from "./log.mjs";
const log = logger("worker");
import { loadSokosumiRuntime } from "./sokosumi-runtime.mjs";
const { readRuntimeCredential, createCoworkerHttpClient, fetchTasks, fetchTaskEvents } =
  await loadSokosumiRuntime();
// Tasks run through the team pipeline; AITELIER_PIPELINE=false restores the plain LLM.
const respond = process.env.AITELIER_PIPELINE === "false" ? answer : pipelineAnswer;
const target = taskTarget();
const id = target.coworkerId;
const runtime = createCoworkerHttpClient({ apiKey: readRuntimeCredential(id) });
const releaseLock = acquireWorkerLock();
process.once("exit", releaseLock);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    releaseLock();
    process.exit(0);
  });
function runSokosumi(args, options) {
  if (process.platform === "win32")
    return execFileSync(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/s",
      "/c",
      "sokosumi",
      ...args,
    ], options);
  return execFileSync("sokosumi", args, options);
}
function cli(args) {
  return JSON.parse(
    runSokosumi(["--preprod", ...args, "--json"], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}
await client.health();
const paid = await createPaidAdapter({
  target,
  answer: respond,
  save: async (taskId, state) =>
    writeFileSync(`.local/${taskId}.json`, JSON.stringify(state), {
      mode: 0o600,
    }),
});
/**
 * The customer's own way out of a result they did not want.
 *
 * Masumi has no partial refund to offer - authorize-refund takes a blockchain
 * identifier and nothing else - so one plain word returns the whole payment.
 * The ids handled here are kept in their own file rather than the chat's, so
 * answering a comment and refunding for it cannot tread on each other.
 */
async function refundIfAsked(task, state) {
  const seenFile = `.local/${task.id}-refund.json`;
  const seen = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : {};
  const { events } = await fetchTaskEvents(runtime, task.id, AbortSignal.timeout(30000));
  for (const event of events) {
    if (event.actor?.type !== "user" || typeof event.comment !== "string") continue;
    if (seen[event.id] || !REFUND_WORD.test(event.comment)) continue;
    // Marked before the money moves, so a crash cannot authorize it twice.
    seen[event.id] = "refunding";
    writeFileSync(seenFile, JSON.stringify(seen), { mode: 0o600 });
    const next = await paid.refund(task, state, event.comment);
    seen[event.id] = "refunded";
    writeFileSync(seenFile, JSON.stringify(seen), { mode: 0o600 });
    log.info("refund asked for in a comment", { task: task.id });
    return next;
  }
  return state;
}
// Decided once at start. A payment service that is not running used to send
// every new Task into the paid flow, where it failed at "terms-pending" and
// was closed: the customer got a refusal instead of their outfits.
const paidFlow = await paidMode();
log.info("started", {
  pid: process.pid,
  workspace: process.env.SOKOSUMI_ORGANIZATION_SLUG || "personal",
  pipeline: respond === pipelineAnswer ? "team" : "plain-llm",
  paid: paidFlow,
});
if (paidFlow === "on-but-unreachable")
  log.warn("payment service not reachable; new Tasks run unpaid", { url: process.env.MPS_URL });
/** What the customer reads when an unpaid run could not finish. */
function unpaidFailureNotice() {
  return [
    "I could not finish styling this order: a service I depend on did not answer, even after retrying.",
    "Nothing was charged.",
    "",
    "Answer here with **yes** and I will try again, or tell me what to change first.",
  ].join("\n");
}

/** What the customer reads when no look of an unpaid run passed its checks. */
function unpaidRefundNotice(failed = []) {
  return [
    "No look I could build passed all five checks, so I am not showing you one:",
    ...failed.slice(0, 6).map((f) => `- ${f}`),
    "",
    "Nothing was charged. Tell me what to change here — a higher budget, another style — and I will restyle.",
  ].join("\n");
}
// Said once per change, not on every 5-second poll.
let lastCounts = "";
const lastNote = new Map();
const once = (taskId, level, message, data) => {
  const key = `${level}:${message}:${JSON.stringify(data)}`;
  if (lastNote.get(taskId) === key) return;
  lastNote.set(taskId, key);
  log[level](message, { task: taskId, ...data });
};
/** Phases where work stopped for good: nothing more is done on every poll. */
const TERMINAL_PHASES = new Set(["refunded", "stalled"]);
/** The journal as it stands, or {} when it is missing or unreadable. */
const readJournal = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
};
while (true) {
  try {
    // Listed with the Coworker's own key: `sokosumi tasks list` uses the
    // operator's login and only returns the operator's own Tasks, so Tasks a
    // teammate assigned to AiTelier stayed READY forever.
    // The API returns at most 20 per call, so open Tasks are asked for by
    // status and merged with the newest 20 (finished Tasks awaiting payout).
    const pages = await Promise.all(
      [{ status: ["READY"] }, { status: ["RUNNING"] }, {}].map((filter) =>
        fetchTasks(runtime, { coworkerId: id, ...filter }),
      ),
    );
    const tasks = [
      ...new Map(
        pages.flatMap((page) => page.tasks ?? page.data ?? page).map((task) => [task.id, task]),
      ).values(),
    ];
    const mine = tasks.filter((t) => isTaskForTarget(t, target));
    const counts = Object.entries(
      mine.reduce((c, t) => ({ ...c, [t.status]: (c[t.status] ?? 0) + 1 }), {}),
    ).map(([s, n]) => `${s}=${n}`).sort().join(" ");
    if (counts !== lastCounts) log.info("tasks", { counts: counts || "none" });
    lastCounts = counts;
    log.debug("poll", { tasks: mine.length });
    for (const t of mine) {
      const journal = `.local/${t.id}.json`,
        resultFile = `.local/${t.id}.txt`;
      try {
        let state = existsSync(journal)
          ? JSON.parse(readFileSync(journal, "utf8"))
          : {};
        // A run that already ended without a result is finished. Polled again it
        // would only be re-closed, so it is left alone.
        if (TERMINAL_PHASES.has(state.phase)) continue;
        if (t.status === "RUNNING" && !state.phase)
          once(t.id, "warn", "running in Sokosumi but no local journal; not resumed", {
            hint: "the .local folder was cleared or another machine started it",
          });
        if (["starting", "model-pending", "complete-pending"].includes(state.phase) && !state.paid)
          once(t.id, "warn", "stopped mid-step; not retried so it cannot run twice", {
            phase: state.phase,
          });
        if (t.status === "READY" && !state.phase) {
          log.info("picked up", { task: t.id, name: t.name });
          // The greeting goes up before the Task is started, so it is the first
          // thing AiTelier says in the thread rather than the line after
          // "changed status to Running". If Core will not take a comment on a
          // READY Task, the block below greets right after the start instead.
          let greeted = false;
          try {
            await postTaskComment(runtime, t.id, welcome());
            greeted = true;
            log.info("greeted", { task: t.id, before: "start" });
          } catch (e) {
            log.warn("greeting before start refused; greeting after it", { task: t.id, error: e.message });
          }
          writeFileSync(journal, JSON.stringify({ phase: "starting", greeted }), {
            mode: 0o600,
          });
          const started = cli([
            "runtime",
            "start",
            t.id,
            ...target.runtimeArgs,
            "--coworker-id",
            id,
          ]);
          state = { phase: "started", input: started.description, greeted };
          writeFileSync(journal, JSON.stringify(state), { mode: 0o600 });
          log.info("started", { task: t.id, inputChars: state.input?.length ?? 0 });
        }
        // Say hello before anything else: the payment request, a refusal and a
        // request for sizes all read better after the customer knows what they
        // are buying, what they are not charged for, and what an order looks
        // like. Posted once per Task, and before any money is asked for.
        if (state.phase === "started" && !state.greeted) {
          await postTaskComment(runtime, t.id, welcome());
          state = { ...state, greeted: true };
          writeFileSync(journal, JSON.stringify(state), { mode: 0o600 });
          log.info("greeted", { task: t.id });
        }
        // Read the order before any money is asked for. A description of
        // "shopping" used to reach APPROVED on a guessed budget and a guessed
        // size, and the refusal for a malformed order was submitted as the
        // result, so the customer paid to be told their order was unusable.
        // Nothing here touches the escrow: it has not been requested yet.
        if (state.phase === "started" && !state.checked) {
          const review = reviewOrder(state.input);
          if (review.action === "proceed") {
            state = { ...state, checked: true };
            writeFileSync(journal, JSON.stringify(state), { mode: 0o600 });
          } else {
            const closed = await closeTaskWithoutResult(runtime, t.id, review.message, { log });
            log.info(
              review.action === "ask" ? "asked for the missing details" : "order refused",
              { task: t.id, reasons: review.reasons, closed },
            );
            writeFileSync(
              journal,
              JSON.stringify({
                ...state,
                phase: review.action === "ask" ? "asked" : "refused",
                reasons: review.reasons,
              }),
              { mode: 0o600 },
            );
          }
        }
        // A Task that was refused, or sent back for the missing details, is not
        // a closed conversation: the next comment is usually the order itself.
        // Nothing was charged for it, and nothing is submitted from here — the
        // chat answers on the thread.
        if (state.phase === "asked" || state.phase === "refused" || state.phase === "failed") {
          await reply(t);
          continue;
        }
        if (state.paid && paidFlow !== "on") {
          once(t.id, "warn", "paid task skipped: paid flow not available", { paid: paidFlow });
          continue;
        }
        if (state.paid || (state.phase === "started" && paidFlow === "on")) {
          if (!state.paid) log.info("paid flow", { task: t.id });
          state = await paid.advance(t, state);
          if (state.phase === "completed") {
            // Asked before the chat answers: once the money is going back
            // there is nothing left to discuss about buying.
            state = await refundIfAsked(t, state);
            if (state.phase === "completed") await reply(t);
          }
          continue;
        }
        if (state.phase === "started") {
          log.info("running unpaid", { task: t.id, reason: paidFlow });
          writeFileSync(
            journal,
            JSON.stringify({ ...state, phase: "model-pending" }),
            { mode: 0o600 },
          );
          let result;
          try {
            result = await respond(
              state.input,
              `.local/${t.id}-session.json`,
            );
          } catch (e) {
            // Unpaid, nothing is in escrow: a run that broke or a look that
            // failed its guarantees is said on the thread and the Task closed,
            // instead of sitting in RUNNING with nobody saying anything. The
            // chat stays open on it, so the customer can restyle from there.
            const notice = e?.refund ? unpaidRefundNotice(e.failed) : unpaidFailureNotice();
            const closed = await closeTaskWithoutResult(runtime, t.id, notice, { log });
            writeFileSync(
              journal,
              JSON.stringify({ ...state, phase: "failed", reason: e?.message ?? String(e) }),
              { mode: 0o600 },
            );
            log.warn(e?.refund ? "no look passed, customer told" : "styling failed, customer told", {
              task: t.id,
              closed,
              error: e?.message,
            });
            continue;
          }
          writeFileSync(resultFile, result, { mode: 0o600 });
          log.info("result saved", { task: t.id, chars: result.length });
          state = { ...state, phase: "result-saved" };
          writeFileSync(journal, JSON.stringify(state), { mode: 0o600 });
        }
        if (state.phase === "result-saved") {
          writeFileSync(
            journal,
            JSON.stringify({ ...state, phase: "complete-pending" }),
            { mode: 0o600 },
          );
          const completed = cli([
            "runtime",
            "complete",
            t.id,
            ...target.runtimeArgs,
            "--coworker-id",
            id,
            "--result-file",
            resultFile,
          ]);
          writeFileSync(
            journal,
            JSON.stringify({
              ...state,
              phase: "completed",
              completion: completed,
            }),
            { mode: 0o600 },
          );
          log.info("completed", { task: t.id });
        }
        if (state.phase === "completed") await reply(t);
      } catch (e) {
        // The customer withdrew the Task. Recorded as terminal so the loop
        // stops re-reading it every five seconds, and reported as their
        // decision rather than as a fault of ours.
        if (e?.abandoned) {
          once(t.id, "warn", "task canceled; stopped without submitting", { status: e.status });
          writeFileSync(journal, JSON.stringify({ phase: "canceled", status: e.status }), {
            mode: 0o600,
          });
        }
        // A refund is a decision the agent made, not a failure to work: say so,
        // or it disappears into the same line as a crash. Either way the Task
        // is closed as FAILED, because a run that will submit nothing must not
        // sit in RUNNING for ever. Closing never submits a result, so nothing
        // is charged.
        else {
          const recorded = readJournal(journal);
          const outcome = unpaidFailure(recorded, e);
          if (!outcome) once(t.id, "error", "task blocked", { error: e.message });
          else {
            const reported = await closeTaskWithoutResult(runtime, t.id, outcome.text, { log });
            writeFileSync(
              journal,
              JSON.stringify({
                ...recorded,
                phase: outcome.phase,
                failed: e.failed ?? recorded.reasons,
                reported,
              }),
              { mode: 0o600 },
            );
            const note = {
              task: t.id,
              closed: reported,
              failed: e.failed ?? e.message,
            };
            if (outcome.phase === "refunded")
              log.warn("refund due, no result submitted", note);
            else log.error("stopped mid-run, no result submitted", note);
          }
        }
      }
    }
  } catch (e) {
    once("poll", "error", "polling Sokosumi failed", { error: e.message });
  }
  await new Promise((r) => setTimeout(r, 5000));
}
