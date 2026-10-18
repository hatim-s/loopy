import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRecord } from "../src/core/index.js";
import { LocalExecutor, openRunStore, Registry } from "../src/local/index.js";
import type { Loopy } from "../src/sdk/host.js";
import { compiledBody } from "./compiled-fixture.js";
import { startLoopy } from "./fixture.js";

export const roots: string[] = [];

export const CLI = resolve(import.meta.dir, "../src/cli/index.ts");

export const SDK = resolve(import.meta.dir, "../src/sdk/index.ts");

export function fixture(name: string, definition: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-cli-sdk-")));
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
  const { default: definition }: { default: Loopy } = await import(f.file);

  const body = await compiledBody(definition.name, f.file, {
    scope: definition.scope,
    mode: definition.mode,
    secrets: [...definition.secrets],
    schedule: definition.schedule ?? null,
    description: definition.description ?? null,
  });

  if (definition.input && !("~standard" in definition.input)) {
    body.graph.input = definition.input;
  }

  return new Registry(f.home, f.cwd).save(body);
}

export async function runFixture(f: ReturnType<typeof fixture>) {
  const { default: definition }: { default: Loopy } = await import(f.file);
  const store = openRunStore(f.home);
  const id = crypto.randomUUID();

  try {
    await startLoopy({
      loopy: definition,
      input: {},
      store,
      executor: new LocalExecutor({ home: f.home, secrets: definition.secrets }),
      runId: id,
      bundleHash: "a".repeat(64),
      workspace: f.cwd,
    });

    return { stdout: JSON.stringify(await store.getRun(id)), stderr: "", code: 0 };
  } finally {
    store.close();
  }
}
