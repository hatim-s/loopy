import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const declarations = Bun.spawn(
  [process.execPath, "x", "--no-install", "tsc", "-p", "packages/loopy/tsconfig.types.json"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
const result = Bun.spawn([process.execPath, "run", "--cwd", "apps/studio", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await result.exited) !== 0) throw new Error("Studio build failed");
if ((await declarations.exited) !== 0) throw new Error("Runtime declarations failed");
await mkdir(resolve(root, "packages/loopy/dist"), { recursive: true });
await rm(resolve(root, "packages/loopy/dist/studio"), { recursive: true, force: true });
await cp(resolve(root, "apps/studio/dist"), resolve(root, "packages/loopy/dist/studio"), {
  recursive: true,
});
await cp(resolve(root, "LICENSE"), resolve(root, "packages/loopy/LICENSE"));
await cp(resolve(root, "README.md"), resolve(root, "packages/loopy/README.md"));
console.log("Built loopy with the graph viewer.");
