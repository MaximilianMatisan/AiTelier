// One log line per real event, in every process: the worker, the agent API,
// the pipeline's Lead-Agent and the studio.
//
//   2026-10-30 20:05:12 INFO  [paid] 01a18e2f stage awaiting-escrow -> model-pending onChain=FundsLocked
//
//   LOG_LEVEL=debug npm run worker      also print the per-poll detail
//   AITELIER_LOG_FILE=off npm run worker   terminal only, no file
//
// Lines also go to .local/logs/aitelier.log, so what happened survives a closed
// terminal. Values are logged as given: never pass a token, key, mnemonic or
// the customer's full brief; log IDs, stages, counts and lengths instead.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;
// node --test sets NODE_TEST_CONTEXT; tests print but never write the real log.
const file =
  process.env.AITELIER_LOG_FILE === "off" || (process.env.NODE_TEST_CONTEXT && !process.env.AITELIER_LOG_FILE)
    ? null
    : process.env.AITELIER_LOG_FILE ?? ".local/logs/aitelier.log";
let fileReady = false;

const stamp = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
};

/** key=value pairs; values with spaces are quoted, long ones cut. */
export function fields(data = {}) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      let text = typeof v === "string" ? v : JSON.stringify(v);
      if (text.length > 200) text = text.slice(0, 197) + "...";
      return `${k}=${/\s/.test(text) ? JSON.stringify(text) : text}`;
    })
    .join(" ");
}

/** The line as it is printed: time, level, area, short task ID, message, fields. */
export function format(level, area, message, data = {}, date) {
  const { task, ...rest } = data;
  const id = task ? ` ${String(task).slice(0, 8)}` : "";
  const extra = fields(rest);
  return `${stamp(date)} ${level.toUpperCase().padEnd(5)} [${area}]${id} ${message}${extra ? " " + extra : ""}`;
}

function write(level, area, message, data) {
  if (LEVELS[level] < threshold) return;
  const line = format(level, area, message, data);
  (LEVELS[level] >= LEVELS.warn ? console.error : console.log)(line);
  if (!file) return;
  try {
    if (!fileReady) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      fileReady = true;
    }
    appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch {
    // A full disk or a removed folder must not stop the worker.
  }
}

/** A logger for one area of the project, such as "worker" or "paid". */
export function logger(area) {
  return {
    debug: (message, data) => write("debug", area, message, data),
    info: (message, data) => write("info", area, message, data),
    warn: (message, data) => write("warn", area, message, data),
    error: (message, data) => write("error", area, message, data),
  };
}
