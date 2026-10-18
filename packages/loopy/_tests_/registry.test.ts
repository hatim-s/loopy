import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/local/index.js";
import { compiledBody } from "./compiled-fixture.js";

const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-registry-")));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project);
  const source = join(project, "saved.loopy.ts");
  writeFileSync(source, "");

  return { root, home, project, source };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry lookup uses the nearest project root and falls back to global entries", async () => {
  const f = fixture();
  const registry = new Registry(f.home, f.project);
  const definition = await compiledBody("saved", f.source);
  await registry.save({
    ...definition,
    revision: "a".repeat(64),
    graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
    source: { ...definition.source, path: f.source },
  });
  const projectSource = join(f.project, "local.ts");
  writeFileSync(projectSource, "");
  await registry.save({
    ...definition,
    revision: "b".repeat(64),
    source: { ...definition.source, path: projectSource },
  });
  const child = join(f.project, "nested", "child");
  mkdirSync(child, { recursive: true });
  expect(new Registry(f.home, child).project).toBe(f.project);
  expect(new Registry(f.home, child).get("saved").revision).toBe("b".repeat(64));
  expect(new Registry(f.home, f.root).get("saved").revision).toBe("a".repeat(64));
  expect(new Registry(f.home, child).list()).toHaveLength(1);
});

test("changing scope removes only the other entry owned by the same source", async () => {
  const f = fixture();
  const registry = new Registry(f.home, f.project);
  const definition = await compiledBody("saved", f.source);
  await registry.save({
    ...definition,
    revision: "a".repeat(64),
    graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
    source: { ...definition.source, path: f.source },
  });
  await registry.save({
    ...definition,
    revision: "b".repeat(64),
    source: { ...definition.source, path: f.source },
  });
  expect(existsSync(join(f.home, "loopies", "saved.json"))).toBe(false);
  await registry.save({
    ...definition,
    revision: "c".repeat(64),
    graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
    source: { ...definition.source, path: f.source },
  });
  expect(existsSync(join(f.project, ".loopy", "loopies", "saved.json"))).toBe(false);
  const other = join(f.project, "other.ts");
  writeFileSync(other, "");
  await registry.save({
    ...definition,
    revision: "d".repeat(64),
    source: { ...definition.source, path: other },
  });
  expect(new Registry(f.home, f.root).get("saved").revision).toBe("c".repeat(64));
  expect(registry.get("saved").revision).toBe("d".repeat(64));
});

test("stale registry entries are ignored and replaced without preserving the old format", async () => {
  const f = fixture();
  const registry = new Registry(f.home, f.project);
  mkdirSync(registry.projectDirectory, { recursive: true });
  const file = join(registry.projectDirectory, "saved.json");
  writeFileSync(file, JSON.stringify({ slug: "saved", source: "different", bundleHash: "old" }));
  expect(registry.list()).toEqual([]);
  expect(() => registry.get("saved")).toThrow("No saved loopy");
  await registry.save(await compiledBody("saved", f.source));
  expect(registry.get("saved")).toMatchObject({ version: 2, graph: { name: "saved" } });
  expect(registry.get("saved")).not.toHaveProperty("bundleHash");
});
