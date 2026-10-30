import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishPage, prepare, pagesConfig } from "./logic/publish.mjs";

const env = { CLOUDFLARE_ACCOUNT_ID: "a", AITELIER_PAGES_PROJECT: "aitelier-results" };

function setup(t) {
  const base = path.join(tmpdir(), `publish-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const runsDir = path.join(base, "runs");
  const siteDir = path.join(base, "site");
  for (const run of ["task-a", "task-b"]) {
    mkdirSync(path.join(runsDir, run), { recursive: true });
    writeFileSync(path.join(runsDir, run, "index.html"), `<html><head><title>${run}</title></head><body>${run}</body></html>`);
  }
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { runsDir, siteDir };
}

test("without Cloudflare credentials nothing is published", async () => {
  assert.equal(pagesConfig({}).ok, false);
  let deployed = false;
  assert.equal(await publishPage("x", { env: {}, deploy: async () => (deployed = true) }), null);
  assert.equal(deployed, false);
});

test("a page gets an unguessable address that survives a retry", async (t) => {
  const { runsDir, siteDir } = setup(t);
  const opts = { env, runsDir, siteDir, deploy: async () => ({ ok: true }), check: async () => true };
  const url = await publishPage(path.join(runsDir, "task-a"), opts);
  assert.match(url, /^https:\/\/aitelier-results\.pages\.dev\/r\/[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(url, /task-a/, "the address does not reveal the task");
  assert.equal(await publishPage(path.join(runsDir, "task-a"), opts), url);
});

test("every deploy carries all pages published before, so none disappear", async (t) => {
  const { runsDir, siteDir } = setup(t);
  const opts = { env, runsDir, siteDir, deploy: async () => ({ ok: true }), check: async () => true };
  await publishPage(path.join(runsDir, "task-a"), opts);
  await publishPage(path.join(runsDir, "task-b"), opts);
  const pages = readdirSync(path.join(siteDir, "r"));
  assert.equal(pages.length, 2);
  for (const page of pages) assert.match(readFileSync(path.join(siteDir, "r", page), "utf8"), /noindex/);
  assert.match(readFileSync(path.join(siteDir, "_headers"), "utf8"), /X-Robots-Tag: noindex/);
  assert.match(readFileSync(path.join(siteDir, "404.html"), "utf8"), /Not found/, "unknown addresses are 404, not the start page");
});

test("a failed deploy or an unreachable page gives no link, never an error", async (t) => {
  const { runsDir, siteDir } = setup(t);
  const run = path.join(runsDir, "task-a");
  assert.equal(await publishPage(run, { env, runsDir, siteDir, deploy: async () => ({ ok: false, output: "auth" }) }), null);
  assert.equal(await publishPage(run, { env, runsDir, siteDir, deploy: async () => ({ ok: true }), check: async () => false }), null);
  assert.equal(await publishPage(run, { env, runsDir, siteDir, deploy: async () => { throw new Error("boom"); } }), null);
});

test("the published page asks search engines and referrers to stay out", () => {
  assert.match(prepare("<html><head><title>x</title>"), /<head><meta name="robots" content="noindex, nofollow">/);
});
