import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "../src/local/index.js";
import { compiledBody } from "./compiled-fixture.js";

test("marked temporary projects isolate saves and global fallback from an ancestor registry", async () => {
  const root = realpathSync(mkdtempSync(join(import.meta.dir, ".registry-isolation-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const fallback = join(root, "fallback");

  try {
    mkdirSync(join(root, ".loopy", "loopies"), { recursive: true });
    mkdirSync(project);
    const ancestor = new Registry(home, root);
    ancestor.save(await compiledBody("sentinel", join(root, "sentinel.ts")));
    const sentinel = join(ancestor.projectDirectory, "sentinel.json");
    const before = readFileSync(sentinel, "utf8");

    // An unmarked fixture inherits the ancestor before its first save.
    expect(new Registry(home, project).project).toBe(root);
    expect(new Registry(home, project).list().map((entry) => entry.slug)).toEqual(["sentinel"]);

    for (const directory of [project, fallback]) {
      mkdirSync(join(directory, ".loopy", "loopies"), { recursive: true });
    }

    const registry = new Registry(home, project);
    expect(registry.project).toBe(project);
    expect(registry.list()).toEqual([]);
    registry.save(await compiledBody("local", join(project, "local.ts")));
    registry.save(await compiledBody("global", join(project, "global.ts"), { scope: "global" }));

    const nested = join(project, "nested");
    mkdirSync(nested);
    expect(new Registry(home, nested).project).toBe(project);
    expect(new Registry(home, fallback).project).toBe(fallback);
    expect(new Registry(home, fallback).list().map((entry) => entry.slug)).toEqual(["global"]);
    expect(ancestor.list().map((entry) => entry.slug)).toEqual(["global", "sentinel"]);
    expect(readFileSync(sentinel, "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
