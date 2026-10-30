// Check whether the Coworker runtime key is already imported into the OS
// credential vault. Never prints the key.
//
// Exit codes:
//   0 = OK, a runtime key is stored for the Coworker
//   1 = MISSING, no runtime key stored (verify before importing a new one)
//   2 = COWORKER_ID is not configured
//
// Reads COWORKER_ID from (in order):
//   1. the COWORKER_ID environment variable
//   2. hackathon-agent/.env
//   3. .local/sokosumi-ids.json

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function parseDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function globalNodeModules() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(npm, ["root", "-g"], {
    encoding: "utf8",
    shell: true,
  }).trim();
}

function resolveCoworkerId(workspace) {
  const fromEnv = String(process.env.COWORKER_ID || "").trim();
  if (fromEnv) return fromEnv;

  const fromAgentEnv = String(
    parseDotEnv(join(workspace, "hackathon-agent", ".env")).COWORKER_ID || ""
  ).trim();
  if (fromAgentEnv) return fromAgentEnv;

  const idsFile = join(workspace, ".local", "sokosumi-ids.json");
  if (existsSync(idsFile)) {
    try {
      const ids = JSON.parse(readFileSync(idsFile, "utf8"));
      const fromIds = String(ids?.coworker?.id || "").trim();
      if (fromIds) return fromIds;
    } catch {
      // Ignore malformed local state; report COWORKER_ID missing instead.
    }
  }
  return "";
}

const workspace = process.cwd();
const coworkerId = resolveCoworkerId(workspace);

if (!coworkerId) {
  console.error(
    "COWORKER_ID is not configured. Set it in hackathon-agent/.env (or .local/sokosumi-ids.json) first."
  );
  process.exit(2);
}

const cliRoot =
  process.env.SOKOSUMI_CLI_ROOT ||
  join(globalNodeModules(), "@masumi_network", "sokosumi");

const { readRuntimeCredential } = await import(
  pathToFileURL(
    join(cliRoot, "dist", "src", "coworker", "runtime-credentials.js")
  ).href
);

try {
  readRuntimeCredential(coworkerId);
  console.log(
    `OK: runtime key is present in the OS vault for Coworker ${coworkerId}. Do not re-import it.`
  );
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`MISSING: ${message}`);
  console.log(
    "Import the worker key once, only with explicit user authorization:"
  );
  console.log(
    "  sokosumi --preprod coworkers api-key <COWORKER_ID> --json | " +
      "sokosumi --preprod runtime key-import --coworker-id <COWORKER_ID> --api-key-stdin"
  );
  process.exit(1);
}
