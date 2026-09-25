import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageDist = resolve(root, "packages/loopy/dist");
await rm(packageDist, { recursive: true, force: true });
const compiled = Bun.spawn(
  [process.execPath, "x", "--no-install", "tsc", "-p", "packages/loopy/tsconfig.build.json"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await compiled.exited) !== 0) throw new Error("Package JavaScript build failed");
const result = Bun.spawn([process.execPath, "run", "--cwd", "apps/studio", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await result.exited) !== 0) throw new Error("Studio build failed");
await mkdir(packageDist, { recursive: true });
await cp(resolve(root, "apps/studio/dist"), resolve(packageDist, "studio"), {
  recursive: true,
});
await cp(resolve(root, "LICENSE"), resolve(root, "packages/loopy/LICENSE"));
await cp(resolve(root, "README.md"), resolve(root, "packages/loopy/README.md"));
console.log("Built loopy with the graph viewer.");
