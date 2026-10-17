import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRecord } from "../src/core/index.js";

export const roots: string[] = [];

export const CLI = resolve(import.meta.dir, "../src/cli/index.ts");

export const SDK = resolve(import.meta.dir, "../src/sdk/index.ts");

export function fixture(name: string, definition: string) {
  const root = mkdtempSync(join(tmpdir(), "loopy-cli-sdk-"));
  roots.push(root);
  const home = join(root, "home");
  const file = join(root, `${name}.loopy.ts`);
  writeFileSync(
    file,
    `import { loopy, step, sleep, hook, command } from ${JSON.stringify(SDK)};
export default loopy({ name: ${JSON.stringify(name)}, ${definition} });`,
  );

  return { cwd: root, home, file };
}

export async function cli(f: ReturnType<typeof fixture>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, "--home", f.home, ...args], {
    cwd: f.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}

export function object(text: string) {
  return requireRecord(JSON.parse(text), "CLI output");
}

export async function save(f: ReturnType<typeof fixture>) {
  const result = await cli(f, "save", f.file);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);

  return object(result.stdout);
}
