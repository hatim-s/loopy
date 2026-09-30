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
import { command } from "../src/core/command.ts";
import { trigger } from "../src/core/workflow.ts";
import { Registry } from "../src/local/registry.ts";

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
  const registry = new Registry(home);
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
  const registry = new Registry(directory());
  registry.save(workflow("original"), "original.ts");
  mkdirSync(join(registry.directory, "hello.json.lock"));
  expect(() => registry.save(workflow("competing"), "other.ts", { replace: true })).toThrow(
    "Another save holds",
  );
  expect(registry.get("hello").workflow).toEqual(workflow("original"));
});

test("changing a source into a symlink cannot transfer stored ownership", () => {
  const home = directory();
  const registry = new Registry(home);
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
  const registry = new Registry(directory());
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
  const duplicate = new Registry(directory());
  sourceFile(join(folder, "duplicate.loopy.ts"), "second");
  await expect(duplicate.saveDirectory(folder, { replace: true })).rejects.toThrow(
    "Duplicate slug",
  );
  expect(duplicate.list()).toEqual([]);
});

test("folder ownership conflicts and invalid code leave all saved graphs unchanged", async () => {
  const folder = directory();
  const registry = new Registry(directory());
  sourceFile(join(folder, "a.loopy.ts"), "first");
  sourceFile(join(folder, "z.loopy.ts"), "hello");
  registry.save(workflow("original"), "owner.ts");
  await expect(registry.saveDirectory(folder)).rejects.toThrow("belongs to");
  expect(registry.list().map((saved) => saved.slug)).toEqual(["hello"]);
  writeFileSync(join(folder, "invalid.loopy.ts"), "export default null;");
  await expect(registry.saveDirectory(folder, { replace: true })).rejects.toThrow("default-export");
  expect(registry.get("hello").workflow).toEqual(workflow("original"));
});
