import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { Registry } from "../src/local";
import { compiledBody } from "./fixtures/compiled";
import { qualityTestRoot } from "./fixtures/quality-test-root";

function fixture() {
  const root = qualityTestRoot("registry");
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(project, ".loopy", "loopies"), { recursive: true });
  const source = join(project, "saved.loopy.ts");
  writeFileSync(source, "");

  return { root, home, project, source };
}

test("registry lookup uses the nearest project root and falls back to global entries", async () => {
  const f = fixture();
  const registry = Effect.runSync(Registry.make(f.home, f.project));
  const definition = await compiledBody("saved", f.source);
  Effect.runSync(
    registry.publish({
      ...definition,
      revision: "a".repeat(64),
      graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
      source: { ...definition.source, path: f.source },
    }),
  );
  const projectSource = join(f.project, "local.ts");
  writeFileSync(projectSource, "");
  Effect.runSync(
    registry.publish({
      ...definition,
      revision: "b".repeat(64),
      source: { ...definition.source, path: projectSource },
    }),
  );
  const child = join(f.project, "nested", "child");
  mkdirSync(child, { recursive: true });
  expect(Effect.runSync(Registry.make(f.home, child)).project).toBe(f.project);
  expect(Effect.runSync(Effect.runSync(Registry.make(f.home, child)).get("saved"))?.revision).toBe(
    "b".repeat(64),
  );
  expect(Effect.runSync(Effect.runSync(Registry.make(f.home, f.root)).get("saved"))?.revision).toBe(
    "a".repeat(64),
  );
  expect(Effect.runSync(Effect.runSync(Registry.make(f.home, child)).list())).toHaveLength(1);
});

test("changing scope removes only the other entry owned by the same source", async () => {
  const f = fixture();
  const registry = Effect.runSync(Registry.make(f.home, f.project));
  const definition = await compiledBody("saved", f.source);
  Effect.runSync(
    registry.publish({
      ...definition,
      revision: "a".repeat(64),
      graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
      source: { ...definition.source, path: f.source },
    }),
  );
  Effect.runSync(
    registry.publish({
      ...definition,
      revision: "b".repeat(64),
      source: { ...definition.source, path: f.source },
    }),
  );
  expect(existsSync(join(f.home, "loopies", "saved.json"))).toBe(false);
  Effect.runSync(
    registry.publish({
      ...definition,
      revision: "c".repeat(64),
      graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
      source: { ...definition.source, path: f.source },
    }),
  );
  expect(existsSync(join(f.project, ".loopy", "loopies", "saved.json"))).toBe(false);
  const other = join(f.project, "other.ts");
  writeFileSync(other, "");
  Effect.runSync(
    registry.publish({
      ...definition,
      revision: "d".repeat(64),
      source: { ...definition.source, path: other },
    }),
  );
  expect(Effect.runSync(Effect.runSync(Registry.make(f.home, f.root)).get("saved"))?.revision).toBe(
    "c".repeat(64),
  );
  expect(Effect.runSync(registry.get("saved"))?.revision).toBe("d".repeat(64));
});

test("an old-format registry entry fails loudly until it is deleted and saved again", async () => {
  const f = fixture();
  const registry = Effect.runSync(Registry.make(f.home, f.project));
  mkdirSync(registry.projectDirectory, { recursive: true });
  const file = join(registry.projectDirectory, "saved.json");
  writeFileSync(file, JSON.stringify({ slug: "saved", source: "different", bundleHash: "old" }));
  const body = await compiledBody("saved", f.source);

  expect(() => Effect.runSync(registry.list())).toThrow("uses an old or invalid format");
  expect(() => Effect.runSync(registry.get("saved"))).toThrow("uses an old or invalid format");
  expect(() => Effect.runSync(registry.publish(body))).toThrow("uses an old or invalid format");

  rmSync(file);
  Effect.runSync(registry.publish(body));
  expect(Effect.runSync(registry.get("saved"))).toMatchObject({
    version: 3,
    graph: { name: "saved" },
  });
});

test("marked temporary projects isolate saves and global fallback from an ancestor registry", async () => {
  const root = qualityTestRoot("registry-isolation");
  const home = join(root, "home");
  const project = join(root, "project");
  const fallback = join(root, "fallback");

  mkdirSync(project);
  const ancestor = Effect.runSync(Registry.make(home, root));
  Effect.runSync(ancestor.publish(await compiledBody("sentinel", join(root, "sentinel.ts"))));
  const sentinel = join(ancestor.projectDirectory, "sentinel.json");
  const before = readFileSync(sentinel, "utf8");

  // An unmarked fixture inherits the ancestor before its first save.
  expect(Effect.runSync(Registry.make(home, project)).project).toBe(root);
  expect(
    Effect.runSync(Effect.runSync(Registry.make(home, project)).list()).map((entry) => entry.slug),
  ).toEqual(["sentinel"]);

  for (const directory of [project, fallback]) {
    mkdirSync(join(directory, ".loopy", "loopies"), { recursive: true });
  }

  const registry = Effect.runSync(Registry.make(home, project));
  expect(registry.project).toBe(project);
  expect(Effect.runSync(registry.list())).toEqual([]);
  Effect.runSync(registry.publish(await compiledBody("local", join(project, "local.ts"))));
  Effect.runSync(
    registry.publish(await compiledBody("global", join(project, "global.ts"), { scope: "global" })),
  );

  const nested = join(project, "nested");
  mkdirSync(nested);
  expect(Effect.runSync(Registry.make(home, nested)).project).toBe(project);
  expect(Effect.runSync(Registry.make(home, fallback)).project).toBe(fallback);
  expect(
    Effect.runSync(Effect.runSync(Registry.make(home, fallback)).list()).map((entry) => entry.slug),
  ).toEqual(["global"]);
  expect(Effect.runSync(ancestor.list()).map((entry) => entry.slug)).toEqual([
    "global",
    "sentinel",
  ]);
  expect(readFileSync(sentinel, "utf8")).toBe(before);
});
