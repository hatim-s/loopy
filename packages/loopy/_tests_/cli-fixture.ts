import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compile } from "../src/compiler/index.js";
import { requireRecord } from "../src/core/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import { activate, SYSTEM_CLOCK } from "../src/host/index.js";
import { LoopyService, Registry } from "../src/local/index.js";
import { SecretStore } from "../src/local/secrets.js";
import { openRunStore } from "../src/store/index.js";
import { present } from "./fixture.js";

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
    `import { loopy, log, sh, code, sleep, wait } from ${JSON.stringify(SDK)};
export default loopy(${JSON.stringify(name)}, { input: {}, ${definition} });`,
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
  const result = await compile(f.file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  const store = openRunStore(f.home);

  try {
    const service = new LoopyService({
      home: f.home,
      store,
      registry: () => new Registry(f.home, f.cwd),
      clock: SYSTEM_CLOCK,
    });

    await service.putLoopy(result.graph.name, {
      ...result,
      bundles: result.bundles.map((bundle) => Buffer.from(bundle.bytes).toString("base64")),
      source: { path: f.file, workspace: f.cwd },
      replace: false,
    });

    return present(new Registry(f.home, f.cwd).get(result.graph.name));
  } finally {
    store.close();
  }
}

export async function runFixture(f: ReturnType<typeof fixture>) {
  const saved = new Registry(f.home, f.cwd).list()[0];

  if (!saved) {
    throw new Error("Save fixture before running it.");
  }

  const store = openRunStore(f.home);

  const service = new LoopyService({
    home: f.home,
    store,
    registry: () => new Registry(f.home, f.cwd),
    clock: SYSTEM_CLOCK,
  });

  try {
    const run = await service.startRun(saved.graph.name, {}, f.cwd);
    await activate({
      store,
      runId: run.id,
      graph: saved.graph,
      executor: new LocalExecutor({
        home: f.home,
        workspace: f.cwd,
        mode: saved.graph.meta.mode,
        secrets: Object.fromEntries(
          saved.graph.meta.secrets.map((name) => [
            name,
            present(new SecretStore(f.home).get(name)),
          ]),
        ),
        bundlePath: (hash) => new Registry(f.home, f.cwd).bundlePath(hash),
      }),
    });

    return { stdout: JSON.stringify(await store.getRun(run.id)), stderr: "", code: 0 };
  } finally {
    store.close();
  }
}
