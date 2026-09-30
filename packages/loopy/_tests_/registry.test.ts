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
