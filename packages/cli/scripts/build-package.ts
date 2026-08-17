import { rmSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const dist = resolve(packageRoot, "dist");

// Build from a clean output directory so stale files cannot leak into a
// published tarball when a previous build contained local fixtures or state.
rmSync(dist, { force: true, recursive: true });

const run = (args: string[], cwd: string) => {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
};

run(["run", "build"], packageRoot);
run(["run", "--cwd", "../../apps/studio", "build:package"], packageRoot);
