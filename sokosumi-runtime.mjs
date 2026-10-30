import { execFileSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
let loaded;
function defaultRun(file, args, options) {
  if (process.platform === "win32")
    return execFileSync(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/s",
      "/c",
      file,
      ...args,
    ], options);
  return execFileSync(file, args, options);
}
export function sokosumiRoot(run = defaultRun) {
  const skillsPath = run("sokosumi", ["skills", "path"], {
    encoding: "utf8",
    timeout: 30000,
  }).trim().replace(/[\\/]+$/u, "");
  if (!isAbsolute(skillsPath) || skillsPath.split(/[\\/]/u).pop() !== "skills")
    throw new Error("sokosumi skills path returned an invalid package path");
  return join(dirname(skillsPath), "dist", "src");
}
export async function loadSokosumiRuntime() {
  if (!loaded) {
    const root = sokosumiRoot();
    loaded = Promise.all(
      [
        "coworker/runtime-credentials.js",
        "api/http-client.js",
        "api/services/task-service.js",
      ].map((p) => import(pathToFileURL(join(root, p)).href)),
    ).then((modules) => Object.assign({}, ...modules));
  }
  return loaded;
}
