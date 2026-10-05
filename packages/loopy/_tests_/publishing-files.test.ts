import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareManifestFile } from "../src/cli/publish.js";

const manifest = {
  entrypoint: "main.ts",
  files: ["main.ts", "bun.lock"],
  lockfile: "bun.lock",
  sources: [],
  compiler: "compiler@1",
  runtime: { build: "runtime@1", graphSchema: 1 },
};

test("manifest preparation reads only declared files and never executes source code", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-publishing-"));
  try {
    const marker = join(root, "executed");
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(root, "main.ts"), `await Bun.write(${JSON.stringify(marker)}, "bad");`);
    await writeFile(join(root, "bun.lock"), "pinned");
    await writeFile(join(root, "secret.txt"), "adjacent secret");
    const bundle = await prepareManifestFile(join(root, "manifest.json"));
    expect(bundle.files.map((file) => file.path)).toEqual(["bun.lock", "main.ts"]);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest reader rejects symlinks outside its root and invalid declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-publishing-"));
  const external = await mkdtemp(join(tmpdir(), "loopy-private-"));
  try {
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(root, "bun.lock"), "pinned");
    await writeFile(join(external, "secret.ts"), "secret");
    await symlink(join(external, "secret.ts"), join(root, "main.ts"));
    await expect(prepareManifestFile(join(root, "manifest.json"))).rejects.toThrow("outside");
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ ...manifest, sources: [{ source: "a" }] }),
    );
    await expect(prepareManifestFile(join(root, "manifest.json"))).rejects.toThrow("Invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
