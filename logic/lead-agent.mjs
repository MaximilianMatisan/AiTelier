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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readOrder, refusal } from "./intake.mjs";
import { logger } from "../log.mjs";
import { publishPage } from "./publish.mjs";
const log = logger("lead-agent");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = "person3/.venv/bin/python";
// Leave room to write, hash and submit the result after the pipeline ends.
const SUBMIT_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/**
 * The whole run gets at most this long, whatever the escrow would allow. The
 * escrow's own deadline is twenty minutes out, so a pipeline that hung held
 * the Task in RUNNING for the full twenty with nothing to show. Live runs that
 * finished took 23 to 37 seconds, so a run still going after eight minutes is
 * stuck rather than slow, and stopping early leaves time to say so.
 */
const PIPELINE_BUDGET_MS =
  Number(process.env.AITELIER_PIPELINE_BUDGET_MS) || 8 * 60_000;

/** Runs the pipeline as its own process; resolves true on exit code 0. */
export function runPipeline(args, timeoutMs, logFile, env = {}) {
  return new Promise((resolve) => {
    const log = openSync(logFile, "a", 0o600);
    // Variables passed here win over .env: the child reads .env only for what
    // its environment does not already hold.
    const child = spawn(process.execPath, ["--env-file-if-exists=.env", ...args], {
      cwd: ROOT,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        PYTHON: process.env.PYTHON ?? (existsSync(path.join(ROOT, VENV_PYTHON)) ? VENV_PYTHON : "python3"),
        ...env,
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

// What a model provider says when it is down or out of quota. A run that
// stopped on one of these is worth repeating; one that stopped on anything
// else (a bad order, a broken stage) fails the same way twice.
const TRANSIENT = /Service Unavailable|Too Many Requests|\b429\b|\b50[234]\b|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i;

/**
 * The models a repeated run uses. A model that answers "high demand" tends to
 * keep answering it for a while, so waiting alone often is not enough: with
 * AITELIER_FALLBACK_MODEL set, the retries ask that model instead. The stylist
 * follows only when it talks to the same provider as the filter.
 */
export function fallbackModelEnv(env = process.env) {
  const model = env.AITELIER_FALLBACK_MODEL?.trim();
  if (!model) return {};
  const sameProvider = !env.GEMINI_BASE_URL?.trim() || env.GEMINI_BASE_URL.trim() === env.ZAI_BASE_URL?.trim();
  return sameProvider ? { ZAI_MODEL: model, GEMINI_MODEL: model } : { ZAI_MODEL: model };
}

/**
 * runPipeline(), repeated when a run failed on a provider outage. Every
 * attempt appends to the same log; only the lines one attempt wrote decide
 * whether it is repeated. Gives up when the next try would not fit in
 * `timeoutMs`, so the caller still has its margin to submit.
 */
export async function runPipelineRetrying(run, args, timeoutMs, logFile, { waits = [15_000, 30_000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minRunMs = 90_000, env = process.env } = {}) {
  const end = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const from = existsSync(logFile) ? statSync(logFile).size : 0;
    if (await run(args, end - Date.now(), logFile, attempt ? fallbackModelEnv(env) : {})) return true;
    const wrote = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(from) : "";
    // Only the lines that report a failure count: run-pipeline.mjs prints a
    // warning about "429 Too Many Requests" on every run that shares one key.
    const errors = wrote.split("\n").filter((line) => /fail|error/i.test(line)).join("\n");
    const wait = waits[attempt];
    if (wait === undefined || !TRANSIENT.test(errors) || end - Date.now() - wait < minRunMs) return false;
    log.warn("provider unavailable, running the pipeline again", {
      attempt: attempt + 2,
      waitS: wait / 1000,
      model: fallbackModelEnv(env).ZAI_MODEL ?? env.ZAI_MODEL ?? "unchanged",
    });
    await sleep(wait);
  }
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

// Embedded images are shrunk to this width so a result with several boards stays
// small enough to submit; Person 3 renders boards at 1200 px.
const EMBED_WIDTH = 600;
const SHRINK = `
import base64, io, json, sys
from PIL import Image
out = []
for path in sys.argv[2:]:
    try:
        img = Image.open(path).convert("RGB")
        width = int(sys.argv[1])
        if img.width > width:
            img = img.resize((width, round(img.height * width / img.width)))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=72, optimize=True)
        out.append(base64.b64encode(buf.getvalue()).decode())
    except Exception:
        out.append(None)
print(json.dumps(out))
`;

/** Base64 JPEGs for the given files, shrunk with Person 3's Pillow; null where one fails. */
function shrinkWithPillow(files) {
  const python = process.env.PYTHON ?? (existsSync(path.join(ROOT, VENV_PYTHON)) ? path.join(ROOT, VENV_PYTHON) : "python3");
  const run = spawnSync(python, ["-c", SHRINK, String(EMBED_WIDTH), ...files], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return files.map(() => null);
  return JSON.parse(run.stdout);
}

/**
 * Puts every image in the markdown inside it as a data: URI, so the customer's
 * viewer loads nothing from another server. Person 3's boards come from its own
 * artifact folder; any other http(s) image is fetched once here. An image that
 * cannot be embedded is replaced by its caption rather than left as a link.
 */
export async function embedImages(markdown, { artifactDir = path.join(ROOT, "person3", "artifacts"), workDir, shrink = shrinkWithPillow, fetchImpl = fetch } = {}) {
  const refs = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].filter(([, , url]) => !url.startsWith("data:"));
  if (!refs.length) return markdown;
  const files = [];
  for (const [, , url] of refs) {
    const local = url.match(/\/artifacts\/([\w./-]+)$/)?.[1];
    if (local && !local.includes("..")) {
      const file = path.join(artifactDir, local);
      files.push(existsSync(file) ? file : null);
      continue;
    }
    try {
      if (!/^https?:\/\//.test(url) || !workDir) throw new Error("not fetchable");
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const file = path.join(workDir, `embed-${files.length}`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      files.push(file);
    } catch {
      files.push(null);
    }
  }
  const present = files.filter(Boolean);
  const encoded = present.length ? shrink(present) : [];
  const byFile = new Map(present.map((file, i) => [file, encoded[i]]));
  let i = 0;
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, url) => {
    if (url.startsWith("data:")) return whole;
    const data = byFile.get(files[i++]);
    return data ? `![${alt}](data:image/jpeg;base64,${data})` : `_${alt || "image unavailable"}_`;
  });
}

/**
 * "Warnings: X; X; X; Y" becomes "Warnings: X ×3, Y". Person 3 reports one
 * warning per shop, so an ordinary run listed GUARANTEE_ASSUMED twenty-one
 * times and pushed the outfit itself off the screen. The codes are kept, and
 * kept in the order they first appeared: the count is the new part.
 */
export function collapseWarnings(markdown) {
  return markdown.replace(/^([ \t]*(?:\*\*)?Warnings:(?:\*\*)?)[ \t]*(.+)$/gim, (whole, label, list) => {
    const counts = new Map();
    for (const item of list.split(";").map((part) => part.trim()).filter(Boolean))
      counts.set(item, (counts.get(item) ?? 0) + 1);
    if (!counts.size) return whole;
    return `${label} ${[...counts].map(([item, n]) => (n > 1 ? `${item} ×${n}` : item)).join(", ")}`;
  });
}

/** Person 3's own markdown when present, otherwise a plain summary. */
export function formatResult(result) {
  if (typeof result?.markdown === "string" && result.markdown.trim())
    return collapseWarnings(result.markdown);
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

export async function pipelineAnswer(input, journal, deadline, { run = runPipeline, publish = publishPage, payment = null } = {}) {
  const intake = readOrder(input);
  if (!intake.ok) {
    log.warn("order refused", { errors: intake.errors.length, first: intake.errors[0] });
    return refusal(intake);
  }

  const taskId = path.basename(journal).replace(/-session\.json$/, "");
  if (!/^[\w-]+$/.test(taskId)) throw new Error("Journal name does not identify a Task");
  // Relative to the repo root: run-pipeline.mjs hands these paths to Person 3.
  const outDir = path.join("catalog", "cache", "run", taskId);
  const orderFile = path.join(outDir, "order.json");
  await mkdir(path.join(ROOT, outDir), { recursive: true });
  await writeFile(path.join(ROOT, orderFile), JSON.stringify(intake.order, null, 2) + "\n");
  writeFileSync(journal, JSON.stringify({ phase: "pipeline", outDir }), { mode: 0o600 });

  const untilDeadline =
    deadline === undefined ? DEFAULT_TIMEOUT_MS : deadline - Date.now() - SUBMIT_MARGIN_MS;
  if (untilDeadline <= 0) throw new Error("Result deadline too close to run the pipeline");
  const timeoutMs = Math.min(untilDeadline, PIPELINE_BUDGET_MS);
  const args = [
    "logic/run-pipeline.mjs",
    "--order", orderFile,
    "--out", outDir,
    // Names the run and keeps each Task's look boards in their own folder.
    "--task-id", taskId,
  ];
  if (process.env.AITELIER_SHORTLIST) args.push("--shortlist", process.env.AITELIER_SHORTLIST);
  // The escrow deposit, when the paid flow has one. The page names it the same
  // way the result text does, so the customer reads one transaction twice
  // rather than two different claims.
  if (payment?.txHash) args.push("--payment-tx", payment.txHash);
  log.info("pipeline started", {
    task: taskId,
    order: intake.order.brief ? "free-text" : "json",
    shortlist: process.env.AITELIER_SHORTLIST ? "demo" : "live",
    timeoutS: Math.round(timeoutMs / 1000),
  });
  const started = Date.now();
  const ok = await runPipelineRetrying(
    run,
    args,
    timeoutMs,
    path.join(ROOT, outDir, "pipeline.log"),
  );
  if (!ok) {
    log.error("pipeline failed or overran", { task: taskId, seconds: Math.round((Date.now() - started) / 1000), log: `${outDir}/pipeline.log` });
    throw new Error(`Pipeline failed or overran; see ${outDir}/pipeline.log`);
  }

  const result = JSON.parse(await readFile(path.join(ROOT, outDir, "person3", "result.json"), "utf8"));
  if (result?.status === "REFUND") {
    const failed = failedGuarantees(result);
    log.warn("refund: guarantees failed", { task: taskId, failed });
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
  let text = await embedImages(formatResult(result), { workDir: path.join(ROOT, outDir) });
  // Sokosumi renders text and links only, so the full page goes up as a link.
  const page = await publish(outDir);
  if (page) text = `# **Your AiTelier page:** [open the full result with every check](${page})\n\n${text}`;
  log.info("pipeline done", {
    task: taskId,
    status: result.status,
    outfits: result.outfits?.length ?? 0,
    seconds: Math.round((Date.now() - started) / 1000),
    resultKb: Math.round(text.length / 1024),
    images: (text.match(/\]\(data:image/g) ?? []).length,
    page: page ? "published" : "none",
  });
  return text;
}
