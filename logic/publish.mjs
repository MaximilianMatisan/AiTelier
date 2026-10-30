// Publishes a run's result page (logic/result-page.mjs writes index.html) to
// Cloudflare Pages, so the customer can open the whole page from Sokosumi,
// which only renders text and links.
//
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   set in .env; without them nothing is published
//   AITELIER_PAGES_PROJECT                        the Pages project, default aitelier-results
//
// Each page gets an unguessable address, /r/<random>.html, and is marked
// noindex. A Pages deployment replaces the whole site, so every deploy
// rebuilds the site from all runs published before (catalog/cache/run/*/
// published.json); a cleared .local/ then loses nothing.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { logger } from "../log.mjs";

const log = logger("publish");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = path.join(ROOT, "catalog", "cache", "run");
const SITE = path.join(ROOT, ".local", "pages");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");

/** Whether publishing is set up; the reason when it is not. */
export function pagesConfig(env = process.env) {
  const project = env.AITELIER_PAGES_PROJECT?.trim() || "aitelier-results";
  if (!env.CLOUDFLARE_API_TOKEN?.trim() || !env.CLOUDFLARE_ACCOUNT_ID?.trim())
    return { ok: false, reason: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set" };
  if (!/^[a-z0-9-]{1,58}$/.test(project)) return { ok: false, reason: "AITELIER_PAGES_PROJECT is not a valid project name" };
  return { ok: true, project };
}

/** The page as published: kept out of search engines and referrer headers. */
export function prepare(html) {
  const meta = '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => head + meta) : meta + html;
}

/** Rebuilds the site folder from every run that was published. */
async function buildSite(runsDir = RUNS, siteDir = SITE) {
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(path.join(siteDir, "r"), { recursive: true });
  await writeFile(path.join(siteDir, "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n");
  await writeFile(path.join(siteDir, "index.html"), '<!doctype html><meta name="robots" content="noindex"><title>AiTelier</title><p>AiTelier</p>\n');
  let pages = 0;
  for (const run of existsSync(runsDir) ? readdirSync(runsDir) : []) {
    const record = path.join(runsDir, run, "published.json");
    const page = path.join(runsDir, run, "index.html");
    if (!existsSync(record) || !existsSync(page)) continue;
    const { slug } = JSON.parse(await readFile(record, "utf8"));
    if (!/^[A-Za-z0-9_-]{20,}$/.test(slug)) continue;
    await writeFile(path.join(siteDir, "r", `${slug}.html`), prepare(await readFile(page, "utf8")));
    pages += 1;
  }
  return pages;
}

function wranglerDeploy(project, siteDir = SITE) {
  if (!existsSync(WRANGLER)) return Promise.resolve({ ok: false, output: "wrangler is not installed: npm install" });
  return new Promise((resolve) => {
    const child = spawn(
      WRANGLER,
      ["pages", "deploy", siteDir, "--project-name", project, "--branch", "main", "--commit-dirty=true"],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", (e) => resolve({ ok: false, output: e.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

/** Waits until the page answers 200, which can take a few seconds after a deploy. */
async function reachable(url, fetchImpl = fetch) {
  for (let i = 0; i < 10; i += 1) {
    try {
      const response = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/**
 * Publishes the page in outDir and returns its address, or null. Never throws:
 * a customer who paid gets their result whether or not hosting works.
 */
export async function publishPage(outDir, { env = process.env, deploy = wranglerDeploy, check = reachable, runsDir = RUNS, siteDir = SITE } = {}) {
  // npm test loads .env, which holds the real token: tests never deploy unless they pass env.
  const config =
    env === process.env && process.env.NODE_TEST_CONTEXT
      ? { ok: false, reason: "running under node --test" }
      : pagesConfig(env);
  if (!config.ok) {
    log.info("page not published", { reason: config.reason });
    return null;
  }
  try {
    const dir = path.resolve(ROOT, outDir);
    if (!existsSync(path.join(dir, "index.html"))) {
      log.warn("page not published", { reason: "run has no index.html", run: path.basename(dir) });
      return null;
    }
    const record = path.join(dir, "published.json");
    // A retried task keeps its address; a new one gets 24 random bytes.
    const slug = existsSync(record)
      ? JSON.parse(await readFile(record, "utf8")).slug
      : randomBytes(24).toString("base64url");
    await writeFile(record, JSON.stringify({ slug, project: config.project }) + "\n");
    const pages = await buildSite(runsDir, siteDir);
    const started = Date.now();
    const result = await deploy(config.project, siteDir);
    if (!result.ok) {
      log.error("page deploy failed", { output: result.output.trim().split("\n").slice(-3).join(" | ") });
      return null;
    }
    const url = `https://${config.project}.pages.dev/r/${slug}.html`;
    if (!(await check(url))) {
      log.error("page deployed but not reachable", { run: path.basename(dir) });
      return null;
    }
    log.info("page published", { run: path.basename(dir), pages, seconds: Math.round((Date.now() - started) / 1000) });
    return url;
  } catch (e) {
    log.error("page not published", { error: e.message });
    return null;
  }
}
