// Build FORGE Command for same-origin staging (served by the Worker as static assets).
// Cross-platform: npm runs scripts through cmd.exe on Windows, where `VAR=value cmd` does not work.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../apps/command/", import.meta.url));
const env = { ...process.env, VITE_FORGE_API: process.env.VITE_FORGE_API || "/api/v1" };
for (const args of [["ci"], ["run", "build"]]) {
  const r = spawnSync("npm", args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
