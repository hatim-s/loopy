import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "@loopy/runtime/local";
import { Effect } from "effect";
import { compiledBody } from "./compiled-fixture";

test("marked temporary projects isolate saves and global fallback from an ancestor registry", async () => {
  const root = realpathSync(mkdtempSync(join(import.meta.dir, ".registry-isolation-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const fallback = join(root, "fallback");

  try {
    mkdirSync(join(root, ".loopy", "loopies"), { recursive: true });
    mkdirSync(project);
    const ancestor = Effect.runSync(Registry.make(home, root));
    Effect.runSync(ancestor.save(await compiledBody("sentinel", join(root, "sentinel.ts"))));
    const sentinel = join(ancestor.projectDirectory, "sentinel.json");
    const before = readFileSync(sentinel, "utf8");

    // An unmarked fixture inherits the ancestor before its first save.
    expect(Effect.runSync(Registry.make(home, project)).project).toBe(root);
    expect(
      Effect.runSync(Effect.runSync(Registry.make(home, project)).list()).map(
        (entry) => entry.slug,
      ),
    ).toEqual(["sentinel"]);

    for (const directory of [project, fallback]) {
      mkdirSync(join(directory, ".loopy", "loopies"), { recursive: true });
    }

    const registry = Effect.runSync(Registry.make(home, project));
    expect(registry.project).toBe(project);
    expect(Effect.runSync(registry.list())).toEqual([]);
    Effect.runSync(registry.save(await compiledBody("local", join(project, "local.ts"))));
    Effect.runSync(
      registry.save(await compiledBody("global", join(project, "global.ts"), { scope: "global" })),
    );

    const nested = join(project, "nested");
    mkdirSync(nested);
    expect(Effect.runSync(Registry.make(home, nested)).project).toBe(project);
    expect(Effect.runSync(Registry.make(home, fallback)).project).toBe(fallback);
    expect(
      Effect.runSync(Effect.runSync(Registry.make(home, fallback)).list()).map(
        (entry) => entry.slug,
      ),
    ).toEqual(["global"]);
    expect(Effect.runSync(ancestor.list()).map((entry) => entry.slug)).toEqual([
      "global",
      "sentinel",
    ]);
    expect(readFileSync(sentinel, "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
