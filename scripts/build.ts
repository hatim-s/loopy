import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
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
await chmod(resolve(packageDist, "cli/index.js"), 0o755);
const artifact = new Bun.CryptoHasher("sha256");
const files = Array.from(
  new Bun.Glob("**/*").scanSync({ cwd: packageDist, onlyFiles: true }),
).sort();
for (const file of files) {
  artifact.update(`${file}\0`);
  artifact.update(await Bun.file(resolve(packageDist, file)).arrayBuffer());
  artifact.update("\0");
}
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
};
const version = (await Bun.file(resolve(root, "packages/loopy/package.json")).json()).version;
const status = git(["status", "--porcelain"]);
await writeFile(
  resolve(packageDist, "build-info.json"),
  `${JSON.stringify(
    {
      version,
      revision: git(["rev-parse", "HEAD"]),
      modified: status === null ? null : status.length > 0,
      artifactSha256: artifact.digest("hex"),
    },
    null,
    2,
  )}\n`,
);
console.log("Built loopy with the graph viewer.");
