// Lead-Agent · connects a Sokosumi task to the pipeline. worker.mjs and the
// paid flow call pipelineAnswer() where they used to send the task text to
// the LLM, with the same signature as client.mjs answer().
//
//   AITELIER_PIPELINE=false npm run worker    fall back to the plain LLM answer
//   AITELIER_SHORTLIST=catalog/cache/shortlist.demo.json npm run worker
//                                             skip the model-backed filter when its provider is down
//
// Step 1 refuses a bad order before anything runs. A good order goes through
// logic/run-pipeline.mjs, and the customer reads Person 3's result. A pipeline
// that fails or overruns throws, so the paid flow never submits half a result.
//
// A run whose guarantees do not hold throws too. Submitting a result is what
// moves the escrow towards paying us, so an agent that submits a REFUND would
// be charging for work it has just declared unfit. Without a submitted result
// `submitResultTime` lapses and the buyer gets their money back, which is the
// promise the product is sold on.
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readOrder, refusal } from "./intake.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = "person3/.venv/bin/python";
// Leave room to write, hash and submit the result after the pipeline ends.
const SUBMIT_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Runs the pipeline as its own process; resolves true on exit code 0. */
export function runPipeline(args, timeoutMs, logFile) {
  return new Promise((resolve) => {
    const log = openSync(logFile, "a", 0o600);
    const child = spawn(process.execPath, ["--env-file-if-exists=.env", ...args], {
      cwd: ROOT,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        PYTHON: process.env.PYTHON ?? (existsSync(path.join(ROOT, VENV_PYTHON)) ? VENV_PYTHON : "python3"),
      },
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const done = (ok) => {
      clearTimeout(timer);
      closeSync(log);
      resolve(ok);
    };
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

/**
 * Thrown when Person 3 returns REFUND. `refund` marks it apart from a crash:
 * the work ran, the guarantees were checked, and they did not hold. The caller
 * must not submit a result for this task.
 */
export class GuaranteesFailed extends Error {
  constructor(failed, outDir) {
    super(`Guarantees failed, nothing submitted: ${failed.join("; ") || "no detail"}`);
    this.name = "GuaranteesFailed";
    this.refund = true;
    this.failed = failed;
    this.outDir = outDir;
  }
}

/** The guarantees that did not hold, named with Person 3's own wording. */
export function failedGuarantees(result) {
  return Object.entries(result?.guarantees ?? {})
    .filter(([, check]) => !check?.ok)
    .map(([name, check]) => `${name}: ${check?.detail ?? "failed"}`);
}

/** Person 3's own markdown when present, otherwise a plain summary. */
export function formatResult(result) {
  if (typeof result?.markdown === "string" && result.markdown.trim()) return result.markdown;
  const lines = [`# AiTelier result: ${result?.status ?? "UNKNOWN"}`, ""];
  for (const outfit of result?.outfits ?? []) {
    lines.push(`## ${outfit.name}`);
    for (const item of outfit.items ?? [])
      lines.push(`- ${item.title} (${item.brand}), size ${item.size}, ${item.price?.amount} ${item.price?.currency}: ${item.product_url}`);
    if (outfit.totals) lines.push(`Total: ${outfit.totals.grand_total} ${outfit.totals.currency}`);
    lines.push("");
  }
  if (result?.decision?.reason) lines.push(`Reason: ${result.decision.reason}`);
  return lines.join("\n").trim();
}

export async function pipelineAnswer(input, journal, deadline, { run = runPipeline } = {}) {
  const intake = readOrder(input);
  if (!intake.ok) return refusal(intake);

  const taskId = path.basename(journal).replace(/-session\.json$/, "");
  if (!/^[\w-]+$/.test(taskId)) throw new Error("Journal name does not identify a Task");
  // Relative to the repo root: run-pipeline.mjs hands these paths to Person 3.
  const outDir = path.join("catalog", "cache", "run", taskId);
  const orderFile = path.join(outDir, "order.json");
  await mkdir(path.join(ROOT, outDir), { recursive: true });
  await writeFile(path.join(ROOT, orderFile), JSON.stringify(intake.order, null, 2) + "\n");
  writeFileSync(journal, JSON.stringify({ phase: "pipeline", outDir }), { mode: 0o600 });

  const timeoutMs = deadline === undefined ? DEFAULT_TIMEOUT_MS : deadline - Date.now() - SUBMIT_MARGIN_MS;
  if (timeoutMs <= 0) throw new Error("Result deadline too close to run the pipeline");
  const args = ["logic/run-pipeline.mjs", "--order", orderFile, "--out", outDir];
  if (process.env.AITELIER_SHORTLIST) args.push("--shortlist", process.env.AITELIER_SHORTLIST);
  const ok = await run(
    args,
    timeoutMs,
    path.join(ROOT, outDir, "pipeline.log"),
  );
  if (!ok) throw new Error(`Pipeline failed or overran; see ${outDir}/pipeline.log`);

  const result = JSON.parse(await readFile(path.join(ROOT, outDir, "person3", "result.json"), "utf8"));
  if (result?.status === "REFUND") {
    const failed = failedGuarantees(result);
    // Journal it so the refusal is a recorded decision, not a crash: someone
    // has to be able to tell the customer why their money came back.
    writeFileSync(
      journal,
      JSON.stringify({ phase: "refund", outDir, status: result.status, failed }),
      { mode: 0o600 },
    );
    throw new GuaranteesFailed(failed, outDir);
  }
  writeFileSync(journal, JSON.stringify({ phase: "pipeline-done", outDir, status: result.status }), { mode: 0o600 });
  return formatResult(result);
}
