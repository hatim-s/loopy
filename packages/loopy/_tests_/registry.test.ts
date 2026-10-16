import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Registry } from "../src/local/index.js";
import { loopy } from "../src/sdk/index.js";

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

test("registry lookup uses the nearest project root and falls back to global entries", () => {
  const f = fixture();
  const registry = new Registry(f.home, f.project);
  const definition = loopy({ name: "saved", run: () => 1 });
  registry.save({ ...definition, scope: "global" }, { source: f.source, bundleHash: "global" });
  const projectSource = join(f.project, "local.ts");
  writeFileSync(projectSource, "");
  registry.save(definition, { source: projectSource, bundleHash: "project" });
  const child = join(f.project, "nested", "child");
  mkdirSync(child, { recursive: true });
  expect(new Registry(f.home, child).project).toBe(f.project);
  expect(new Registry(f.home, child).get("saved").bundleHash).toBe("project");
  expect(new Registry(f.home, f.root).get("saved").bundleHash).toBe("global");
  expect(new Registry(f.home, child).list()).toHaveLength(1);
});

test("saving an absolute source from outside cwd registers it beside its source", async () => {
  const f = fixture();
  const sdk = resolve(import.meta.dir, "../src/sdk/index.ts");
  writeFileSync(
    f.source,
    `import { loopy } from ${JSON.stringify(sdk)};
    export default loopy({ name: "saved", run: () => 1 });`,
  );

  const caller = join(f.root, "caller");
  mkdirSync(caller);

  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/cli/index.ts"),
      "--home",
      f.home,
      "save",
      f.source,
    ],
    {
      cwd: caller,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ source: f.source });
  expect(new Registry(f.home, f.project).get("saved").source).toBe(f.source);
  expect(existsSync(join(f.root, ".loopy", "loopies", "saved.json"))).toBe(false);
});

test("changing scope removes only the other entry owned by the same source", () => {
  const f = fixture();
  const registry = new Registry(f.home, f.project);
  const definition = loopy({ name: "saved", run: () => 1 });
  registry.save({ ...definition, scope: "global" }, { source: f.source, bundleHash: "one" });
  registry.save(definition, { source: f.source, bundleHash: "two" });
  expect(existsSync(join(f.home, "loopies", "saved.json"))).toBe(false);
  registry.save({ ...definition, scope: "global" }, { source: f.source, bundleHash: "three" });
  expect(existsSync(join(f.project, ".loopy", "loopies", "saved.json"))).toBe(false);
  const other = join(f.project, "other.ts");
  writeFileSync(other, "");
  registry.save(definition, { source: other, bundleHash: "other" });
  expect(new Registry(f.home, f.root).get("saved").bundleHash).toBe("three");
  expect(registry.get("saved").bundleHash).toBe("other");
});
