import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/core/command.js";
import { trigger } from "../src/core/workflow.js";
import { Registry } from "../src/local/registry.js";

const directories: string[] = [];
const modulePath = join(import.meta.dir, "../src/core/index.ts");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-migration-")));
  directories.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(home, "workflows"), { recursive: true });
  const source = join(project, "legacy.loopy.ts");
  const registration = join(home, "workflows/legacy.json");
  const old = JSON.stringify({
    workflow: trigger("legacy").node("one", command("echo", "old")).build(),
    source,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(registration, old);
  const registry = new Registry(home, root);
  const sourceText = (scope?: "project" | "global", slug = "legacy") =>
    `import {trigger, command, file} from ${JSON.stringify(modulePath)}; export default trigger(${JSON.stringify(slug)})${scope ? `.config({scope:${JSON.stringify(scope)}})` : ""}.node('one', command('bun', file('./helper.ts')));`;
  return { home, root, project, source, registration, old, registry, sourceText };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("migration preview never imports source or changes registrations", () => {
  const { source, registration, old, registry } = fixture();
  writeFileSync(source, "throw new Error('Do not import during dry run');");
  expect(registry.planScopeMigration()).toMatchObject([
    { slug: "legacy", source, sourceExists: true },
  ]);
  expect(readFileSync(registration, "utf8")).toBe(old);
  expect(readFileSync(source, "utf8")).toContain("Do not import");
});

test("migration requires explicit source scope and preserves source ownership and absolute file paths", async () => {
  const { project, source, registration, old, registry, sourceText } = fixture();
  writeFileSync(source, sourceText());
  await expect(registry.migrateScope("legacy")).rejects.toThrow("Choose an explicit scope");
  expect(readFileSync(registration, "utf8")).toBe(old);
  const text = sourceText("global");
  writeFileSync(source, text);
  const migrated = await registry.migrateScope("legacy");
  expect(migrated.source).toBe(source);
  expect(migrated.workflow.config?.scope).toBe("global");
  const node = migrated.workflow.nodes[0];
  if (node?.kind !== "command") throw new Error("Expected command");
  expect(node.command.args).toEqual([join(project, "helper.ts")]);
  expect(readFileSync(source, "utf8")).toBe(text);
  expect(registry.get("legacy")).toEqual(migrated);
  expect(registry.planScopeMigration()).toEqual([]);
  expect(existsSync(join(project, ".loopy"))).toBe(false);
  await expect(registry.migrateScope("legacy")).rejects.toThrow("No migration is needed");
});

test("project migration uses the owner source project and refuses another owner's slug", async () => {
  const { home, root, project, source, registration, old, registry, sourceText } = fixture();
  writeFileSync(source, sourceText("project"));
  const local = new Registry(home, project);
  local.save(trigger("legacy").node("other", command("echo")).build(), join(project, "other.ts"));
  await expect(registry.migrateScope("legacy")).rejects.toThrow("belongs to");
  expect(readFileSync(registration, "utf8")).toBe(old);
  rmSync(join(project, ".loopy/workflows/legacy.json"));
  const migrated = await registry.migrateScope("legacy");
  expect(migrated.source).toBe(source);
  expect(migrated.workflow.config?.scope).toBe("project");
  expect(existsSync(registration)).toBe(false);
  expect(existsSync(join(root, ".loopy/workflows/legacy.json"))).toBe(false);
  expect(local.get("legacy")).toEqual(migrated);
});

test("migration refuses missing source and a changed slug without touching the old registration", async () => {
  const { source, registration, old, registry, sourceText } = fixture();
  expect(registry.planScopeMigration()[0]?.sourceExists).toBe(false);
  await expect(registry.migrateScope("legacy")).rejects.toThrow("Restore the owner source");
  writeFileSync(source, sourceText("global", "renamed"));
  await expect(registry.migrateScope("legacy")).rejects.toThrow("Restore the original slug");
  expect(readFileSync(registration, "utf8")).toBe(old);
});
