import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
async function run(args: string[], cwd = root) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`Failed: bun ${args.join(" ")}`);
}

await run(["run", "build"]);
const staging = await mkdtemp(join(tmpdir(), "loopy-install-"));
try {
  const archive = join(staging, "loopy.tgz");
  await run(
    ["pm", "pack", "--ignore-scripts", "--filename", archive],
    join(root, "packages/loopy"),
  );
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  const packages = join(homedir(), ".loopy", "packages");
  await mkdir(packages, { recursive: true });
  const snapshot = join(packages, `loopy-${hash}.tgz`);
  await rename(archive, snapshot);
  await run(["add", "--global", snapshot]);
  console.log(`Installed loopy globally. Ensure the directory from 'bun pm bin -g' is on PATH.`);
  console.log(`To author workflows in another project: bun add ${snapshot}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
