import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareManifestFile } from "../src/cli/publish.js";
import { manifestReader } from "../src/cli/publishing-reader.js";

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
    await expect(prepareManifestFile(join(root, "manifest.json"))).rejects.toThrow("symlinks");
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

test("descriptor-anchored reads cannot follow replacement files or replaced ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-publishing-race-"));
  const external = await mkdtemp(join(tmpdir(), "loopy-private-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/main.ts"), "declared");
    await writeFile(join(external, "main.ts"), "SECRET");
    const reader = await manifestReader(root);
    try {
      await rename(root, `${root}-original`);
      await symlink(external, root);
      expect(new TextDecoder().decode(reader.read("src/main.ts", 100))).toBe("declared");
      await rename(join(`${root}-original`, "src"), join(`${root}-original`, "old-src"));
      await symlink(external, join(`${root}-original`, "src"));
      expect(() => reader.read("src/main.ts", 100)).toThrow("symlinks");
      await symlink(join(external, "main.ts"), join(`${root}-original`, "main.ts"));
      expect(() => reader.read("main.ts", 100)).toThrow("symlinks");
    } finally {
      reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-original`, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
