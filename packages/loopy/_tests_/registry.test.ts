import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revision } from "../src/core/index.js";
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
    revision: await revision({
      ...definition.graph,
      meta: { ...definition.graph.meta, scope: "global" },
    }),
    graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
    source: { ...definition.source, path: f.source },
  });
  const projectSource = join(f.project, "local.ts");
  writeFileSync(projectSource, "");
  await registry.save({
    ...definition,
    revision: definition.revision,
    source: { ...definition.source, path: projectSource },
  });
  const child = join(f.project, "nested", "child");
  mkdirSync(child, { recursive: true });
  expect(new Registry(f.home, child).project).toBe(f.project);
  expect(new Registry(f.home, child).get("saved").revision).toBe(definition.revision);
  expect(new Registry(f.home, f.root).get("saved").revision).toBe(
    await revision({ ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } }),
  );
  expect(new Registry(f.home, child).list()).toHaveLength(1);
});

test("changing scope removes only the other entry owned by the same source", async () => {
  const f = fixture();
  const registry = new Registry(f.home, f.project);
  const definition = await compiledBody("saved", f.source);
  await registry.save({
    ...definition,
    revision: await revision({
      ...definition.graph,
      meta: { ...definition.graph.meta, scope: "global" },
    }),
    graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
    source: { ...definition.source, path: f.source },
  });
  await registry.save({
    ...definition,
    revision: definition.revision,
    source: { ...definition.source, path: f.source },
  });
  expect(existsSync(join(f.home, "loopies", "saved.json"))).toBe(false);
  await registry.save({
    ...definition,
    revision: await revision({
      ...definition.graph,
      meta: { ...definition.graph.meta, scope: "global" },
    }),
    graph: { ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } },
    source: { ...definition.source, path: f.source },
  });
  expect(existsSync(join(f.project, ".loopy", "loopies", "saved.json"))).toBe(false);
  const other = join(f.project, "other.ts");
  writeFileSync(other, "");
  await registry.save({
    ...definition,
    revision: definition.revision,
    source: { ...definition.source, path: other },
  });
  expect(new Registry(f.home, f.root).get("saved").revision).toBe(
    await revision({ ...definition.graph, meta: { ...definition.graph.meta, scope: "global" } }),
  );
  expect(registry.get("saved").revision).toBe(definition.revision);
});

test("registry open deletes invalid project and global entries while retaining schema-valid entries", async () => {
  const f = fixture();
  const registry = new Registry(f.home, f.project);
  const saved = await registry.save(await compiledBody("saved", f.source));

  for (const directory of [registry.projectDirectory, registry.globalDirectory]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pre-v2.json"), JSON.stringify({ slug: "pre-v2" }));
    writeFileSync(join(directory, "malformed.json"), "{");
  }

  const reopened = new Registry(f.home, f.project);
  expect(reopened.list()).toEqual([saved]);

  for (const directory of [registry.projectDirectory, registry.globalDirectory]) {
    expect(existsSync(join(directory, "pre-v2.json"))).toBe(false);
    expect(existsSync(join(directory, "malformed.json"))).toBe(false);
  }
});
