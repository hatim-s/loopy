import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/core/command.js";
import { concat, eq, file, node, trigger } from "../src/core/workflow.js";
import { Registry } from "../src/local/registry.js";

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "loopy-registry-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const workflow = (message: string) =>
  trigger("hello").node("echo", command("echo", message)).build();

test("slugs belong to canonical sources and transfer only with explicit replacement", () => {
  const home = directory();
  const registry = new Registry(home, home);
  const source = join(home, "hello.ts");
  const alias = join(home, "alias.ts");
  const other = join(home, "other.ts");
  writeFileSync(source, "");
  symlinkSync(source, alias);
  registry.save(workflow("first"), source);
  registry.save(workflow("updated"), alias);
  expect(registry.get("hello").workflow).toEqual(workflow("updated"));
  expect(() => registry.save(workflow("collision"), other)).toThrow("belongs to");
  expect(registry.get("hello").source).toBe(realpathSync(source));
  registry.save(workflow("replacement"), other, { replace: true });
  expect(registry.list()[0]?.source).toBe(other);
  expect(() => registry.save(workflow("old owner"), source)).toThrow("belongs to");
  expect(existsSync(join(registry.directory, "hello.json.lock"))).toBe(false);
});

test("a held slug lock prevents competing writes, including explicit replacements", () => {
  const registry = new Registry(directory(), directory());
  registry.save(workflow("original"), "original.ts");
  mkdirSync(join(registry.directory, "hello.json.lock"));
  expect(() => registry.save(workflow("competing"), "other.ts", { replace: true })).toThrow(
    "Another save holds",
  );
  expect(registry.get("hello").workflow).toEqual(workflow("original"));
});

test("changing a source into a symlink cannot transfer stored ownership", () => {
  const home = directory();
  const registry = new Registry(home, home);
  const source = join(home, "original.ts");
  const other = join(home, "other.ts");
  writeFileSync(source, "");
  writeFileSync(other, "");
  registry.save(workflow("original"), source);
  rmSync(source);
  symlinkSync(other, source);
  expect(() => registry.save(workflow("other"), other)).toThrow("belongs to");
  expect(registry.get("hello").workflow).toEqual(workflow("original"));
});

function sourceFile(path: string, slug: string) {
  writeFileSync(
    path,
    `import { trigger, command } from ${JSON.stringify(join(import.meta.dir, "../src/core/index.ts"))};
export default trigger(${JSON.stringify(slug)}).node('echo', command('echo', 'hello'));`,
  );
}

test("folder saves discover project workflows and reject duplicate slugs before writes", async () => {
  const folder = directory();
  const registry = new Registry(directory(), directory());
  mkdirSync(join(folder, "nested"));
  mkdirSync(join(folder, "node_modules"));
  mkdirSync(join(folder, ".hidden"));
  sourceFile(join(folder, "first.loopy.ts"), "first");
  sourceFile(join(folder, "nested", "second.loopy.ts"), "second");
  writeFileSync(join(folder, "node_modules", "bad.loopy.ts"), "invalid");
  writeFileSync(join(folder, ".hidden", "bad.loopy.ts"), "invalid");
  writeFileSync(join(folder, "helper.ts"), "invalid");
  symlinkSync(folder, join(folder, "cycle"));
  expect((await registry.saveDirectory(folder)).map((saved) => saved.workflow.slug)).toEqual([
    "first",
    "second",
  ]);
  const duplicate = new Registry(directory(), directory());
  sourceFile(join(folder, "duplicate.loopy.ts"), "second");
  await expect(duplicate.saveDirectory(folder, { replace: true })).rejects.toThrow(
    "Duplicate slug",
  );
  expect(duplicate.list()).toEqual([]);
});

test("folder ownership conflicts and invalid code leave all saved graphs unchanged", async () => {
  const folder = directory();
  const registry = new Registry(directory(), directory());
  sourceFile(join(folder, "a.loopy.ts"), "first");
  sourceFile(join(folder, "z.loopy.ts"), "hello");
  registry.save(workflow("original"), "owner.ts");
  await expect(registry.saveDirectory(folder)).rejects.toThrow("belongs to");
  expect(registry.list().map((saved) => saved.slug)).toEqual(["hello"]);
  writeFileSync(join(folder, "invalid.loopy.ts"), "export default null;");
  await expect(registry.saveDirectory(folder, { replace: true })).rejects.toThrow("default-export");
  expect(registry.get("hello").workflow).toEqual(workflow("original"));
});

test("projects isolate slugs, inherit from parent directories, and override globals", () => {
  const home = directory();
  const first = directory();
  const second = directory();
  const a = new Registry(home, first);
  const b = new Registry(home, second);
  a.save(workflow("local a"), join(first, "hello.ts"));
  b.save(workflow("local b"), join(second, "hello.ts"));
  expect(a.get("hello").workflow).toEqual(workflow("local a"));
  expect(b.get("hello").workflow).toEqual(workflow("local b"));
  const outside = new Registry(home, directory());
  expect(outside.list()).toEqual([]);
  expect(() => outside.get("hello")).toThrow("No saved loopy");
  mkdirSync(join(first, "child"));
  expect(new Registry(home, join(first, "child")).get("hello").workflow).toEqual(
    workflow("local a"),
  );
  outside.save({ ...workflow("global"), config: { scope: "global" } }, join(home, "global.ts"));
  expect(outside.get("hello").workflow.nodes).toEqual(workflow("global").nodes);
  expect(a.list()[0]?.scope).toBe("project");
  expect(a.get("hello").workflow).toEqual(workflow("local a"));
});

test("changing scope removes the same source's previous registration", () => {
  const home = directory();
  const project = directory();
  const registry = new Registry(home, project);
  const source = join(project, "hello.ts");
  registry.save(workflow("local"), source);
  new Registry(home, directory()).save(
    { ...workflow("global"), config: { scope: "global" } },
    source,
  );
  expect(registry.list()[0]?.scope).toBe("global");
  expect(new Registry(home, directory()).get("hello").workflow.config?.scope).toBe("global");
  registry.save(workflow("local again"), source);
  expect(new Registry(home, directory()).list()).toEqual([]);
  expect(registry.get("hello").workflow).toEqual(workflow("local again"));
});

test("global snapshots resolve marked files, relative programs, cwd, and nested branch paths", () => {
  const root = directory();
  const registry = new Registry(directory(), root);
  const graph = trigger("paths")
    .config({ scope: "global" })
    .node("first", {
      program: "./bin/tool",
      args: ["./input.json", file("asset.json"), "ordinary text"],
      stdin: file("stdin.txt"),
      cwd: "./work",
    })
    .condition(
      "branch",
      eq(file("condition.txt"), "expected"),
      node("yes", command("bun", file("scripts/run.ts"), concat("--file=", file("data.json")))),
      node("no", command("echo", "no")),
    )
    .build();
  const saved = registry.save(graph, join(root, "paths.ts")).workflow;
  const first = saved.nodes[0];
  if (first?.kind !== "command") throw new Error("Missing command");
  expect(first.command.cwd).toBe(join(root, "work"));
  expect(first.command.program).toBe(join(root, "work", "bin/tool"));
  expect(first.command.stdin).toBe(join(root, "work/stdin.txt"));
  expect(first.command.args).toEqual([
    join(root, "work/input.json"),
    join(root, "work/asset.json"),
    "ordinary text",
  ]);
  const branch = saved.nodes[1];
  if (branch?.kind !== "condition" || branch.then[0]?.kind !== "command")
    throw new Error("Missing branch");
  expect(branch.test).toEqual({ $op: "eq", args: [join(root, "condition.txt"), "expected"] });
  expect(branch.then[0].command.args).toEqual([
    join(root, "scripts/run.ts"),
    { $op: "concat", args: ["--file=", join(root, "data.json")] },
  ]);
  expect(graph.nodes[0]).not.toEqual(first);
});
