// Keep the historical command working, but let Forge include all production dependencies.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forge = path.join(projectRoot, "node_modules", "@electron-forge", "cli", "dist", "electron-forge.js");
execFileSync(process.execPath, [forge, "make", "--platform=win32", "--arch=x64"], {
  cwd: projectRoot, stdio: "inherit",
});
execFileSync(process.execPath, [path.join(projectRoot, "tools", "prepare-win-release.mjs")], {
  cwd: projectRoot, stdio: "inherit",
});
