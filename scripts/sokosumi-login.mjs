// See scripts/sokosumi-login.ps1 for why this exists.
//
// Runs the Sokosumi CLI's own OAuth login, but replaces the browser launch so
// the authorization URL reaches the browser intact on Windows.

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function globalNodeModules() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(npm, ["root", "-g"], {
    encoding: "utf8",
    shell: true,
  }).trim();
}

const cliRoot =
  process.env.SOKOSUMI_CLI_ROOT ||
  join(globalNodeModules(), "@masumi_network", "sokosumi");
const dist = join(cliRoot, "dist", "src");
const urlFile =
  process.env.SOKOSUMI_LOGIN_URL_FILE || "login-url.txt";

const { resolveCliConfig } = await import(
  pathToFileURL(`${dist}/auth/config.js`).href
);
const { loginWithBrowser } = await import(
  pathToFileURL(`${dist}/auth/oauth.js`).href
);
const { runAuthLogin } = await import(
  pathToFileURL(`${dist}/cli/auth-login.js`).href
);

function openWithoutShellSplitting(url) {
  if (process.platform !== "win32") return;
  try {
    // explorer.exe takes the URL as a single argv entry; no cmd parsing of `&`.
    const child = spawn("explorer.exe", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Non-fatal: the URL is printed and saved anyway.
  }
}

const loginFn = (request) =>
  loginWithBrowser({
    ...request,
    openUrl: async (url) => {
      writeFileSync(urlFile, `${url}\n`, "utf8");
      console.log("");
      console.log("=== Open this URL in your browser ===");
      console.log("");
      console.log(url);
      console.log("");
      console.log(`=== (also saved to ${urlFile}) ===`);
      console.log("");
      openWithoutShellSplitting(url);
    },
  });

const config = resolveCliConfig({ env: {}, preprod: true });

try {
  const result = await runAuthLogin({
    env: {},
    config,
    targetExplicit: true,
    loginFn,
    // Give the user time to paste the URL and finish in the browser.
    timeoutMs: 10 * 60 * 1000,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    `Login failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
