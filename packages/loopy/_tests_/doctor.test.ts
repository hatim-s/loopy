import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/core/command.js";
import { trigger } from "../src/core/workflow.js";
import { doctor } from "../src/local/doctor.js";
import { Registry } from "../src/local/registry.js";

const directories: string[] = [];
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "loopy-doctor-"));
  directories.push(cwd);
  const home = join(cwd, "home");
  return { cwd, home, registry: new Registry(home, cwd) };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("doctor exposes legacy global registrations without importing or changing their source", async () => {
  const { cwd, home, registry } = fixture();
  const source = join(cwd, "legacy.loopy.ts");
  const sourceText = `throw new Error('Doctor must not import source');`;
  writeFileSync(source, sourceText);
  mkdirSync(join(home, "workflows"), { recursive: true });
  const file = join(home, "workflows/legacy.json");
  const saved = JSON.stringify({
    workflow: trigger("legacy").node("one", command("echo")).build(),
    source,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(file, saved);
  expect(registry.list()).toEqual([]);
  const result = await doctor(registry, cwd);
  expect(result.ok).toBe(false);
  expect(result.registrations[0]?.error).toContain("global scope");
  expect(readFileSync(source, "utf8")).toBe(sourceText);
  expect(readFileSync(file, "utf8")).toBe(saved);
  expect(existsSync(join(home, "runs.sqlite"))).toBe(false);
});

test("doctor checks executable availability and treats absent path arguments as advisory", async () => {
  const { cwd, registry } = fixture();
  const missing = join(cwd, "missing-helper.ts");
  registry.save(
    trigger("dependencies")
      .node("script", command(process.execPath, missing))
      .node("missing-program", command("loopy-no-such-program-01234"))
      .build(),
    join(cwd, "source.ts"),
  );
  const result = await doctor(registry, cwd, "dependencies");
  expect(result.ok).toBe(false);
  expect(result.commands[0]?.resolvedProgram).toBeTruthy();
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      level: "warning",
      nodeId: "script",
      message: expect.stringContaining(missing),
    }),
  );
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      level: "error",
      nodeId: "missing-program",
      message: expect.stringContaining("Executable not found"),
    }),
  );
});

test("doctor reports project package mismatches without evaluating its module", async () => {
  const { cwd, registry } = fixture();
  const packageRoot = join(cwd, "node_modules/loopy");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "loopy", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(
    join(packageRoot, "index.js"),
    "throw new Error('Doctor must not evaluate the authoring package');",
  );
  const result = await doctor(registry, cwd);
  expect(result.authoring?.version).toBe("0.0.0");
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("differs from this CLI build"),
    }),
  );
});
