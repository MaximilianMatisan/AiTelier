import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { acquireWorkerLock } from "./worker-lock.mjs";
import { answer, client } from "./client.mjs";
import { reply } from "./comments.mjs";
import { createPaidAdapter, isPaidReady } from "./paid-task.mjs";
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
const { readRuntimeCredential, createCoworkerHttpClient, fetchTasks } = await loadSokosumiRuntime();
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
log.info("started", {
  pid: process.pid,
  workspace: process.env.SOKOSUMI_ORGANIZATION_SLUG || "personal",
  pipeline: respond === pipelineAnswer ? "team" : "plain-llm",
  paid: process.env.PAID_TASKS_ENABLED === "true" ? (isPaidReady() ? "on" : "on-but-no-key") : "off",
});
// Said once per change, not on every 5-second poll.
let lastCounts = "";
const lastNote = new Map();
const once = (taskId, level, message, data) => {
  const key = `${level}:${message}:${JSON.stringify(data)}`;
  if (lastNote.get(taskId) === key) return;
  lastNote.set(taskId, key);
  log[level](message, { task: taskId, ...data });
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
          writeFileSync(journal, JSON.stringify({ phase: "starting" }), {
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
          state = { phase: "started", input: started.description };
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
        if (state.phase === "asked" || state.phase === "refused") {
          await reply(t);
          continue;
        }
        if (state.paid && process.env.PAID_TASKS_ENABLED !== "true") {
          once(t.id, "warn", "paid task skipped: PAID_TASKS_ENABLED is off", {});
          continue;
        }
        if (
          state.paid ||
          (state.phase === "started" &&
            process.env.PAID_TASKS_ENABLED === "true" &&
            isPaidReady())
        ) {
          if (!state.paid) log.info("paid flow", { task: t.id });
          state = await paid.advance(t, state);
          if (state.phase === "completed") await reply(t);
          continue;
        }
        if (state.phase === "started") {
          log.info("running unpaid", { task: t.id, reason: process.env.PAID_TASKS_ENABLED === "true" ? "no payment key" : "paid tasks off" });
          writeFileSync(
            journal,
            JSON.stringify({ ...state, phase: "model-pending" }),
            { mode: 0o600 },
          );
          const result = await respond(
            state.input,
            `.local/${t.id}-session.json`,
          );
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
        // or it disappears into the same line as a crash.
        else if (e?.refund)
          once(t.id, "warn", "refund due, no result submitted", { failed: e.failed ?? e.message });
        else once(t.id, "error", "task blocked", { error: e.message });
      }
    }
  } catch (e) {
    once("poll", "error", "polling Sokosumi failed", { error: e.message });
  }
  await new Promise((r) => setTimeout(r, 5000));
}
