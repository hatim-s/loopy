import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../../..");

async function assertPrivateImportsAbsent(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);

    if (entry.isDirectory()) {
      await assertPrivateImportsAbsent(file);
    } else if (file.endsWith(".js") || file.endsWith(".d.ts")) {
      const source = await Bun.file(file).text();

      if (
        /(?:from\s*|import\s*(?:\(\s*)?|Bun\.resolveSync\(\s*|import\.meta\.resolve\(\s*)["']@loopy\//.test(
          source,
        )
      ) {
        throw new Error(`Packed file still references a private package: ${file}`);
      }
    }
  }
}

export async function verifyPackedDistribution() {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "loopy-package-")));
  const home = join(fixture, "home");

  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: fixture,
    TMPDIR: fixture,
    LOOPY_HOME: home,
  };

  async function run(args: string[], cwd = fixture) {
    const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => child.kill(), 120_000);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      if (code !== 0) {
        throw new Error(`${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
      }

      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const archive = join(fixture, "loopy.tgz");
    await run(
      ["pm", "pack", "--ignore-scripts", "--filename", archive],
      join(repository, "packages/loopy"),
    );
    await Bun.write(
      join(fixture, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { loopy: `file:${archive}` },
        devDependencies: { typescript: "5.9.2", "bun-types": "1.4.0" },
      }),
    );
    await run(["install", "--ignore-scripts"]);
    await mkdir(join(fixture, ".loopy/loopies"), { recursive: true });
    await mkdir(join(fixture, "listing"));
    await assertPrivateImportsAbsent(join(fixture, "node_modules/loopy/dist"));
    await Bun.write(
      join(fixture, "consumer.ts"),
      `
import {loopy} from "loopy";
import type {Ref} from "loopy/graph";
import * as contract from "loopy/contract";
import * as engine from "loopy/engine";
import * as local from "loopy/local";
const definition = loopy("typed-package", {input: {}, run: () => 42});
const value: Ref<number> | undefined = undefined;
void [definition, value, contract, engine, local];
`,
    );
    await run([
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--target",
      "ES2022",
      "--types",
      "bun-types",
      "consumer.ts",
    ]);
    await Bun.write(
      join(fixture, "entry.ts"),
      `
import {loopy, fs, code} from "loopy";
export default loopy("packed", {input: {}, run: () => {
  fs.ls({args: ["./listing"]});
  return code("answer", {in: {}, out: {kind: "value", type: "number"}, module: "./answer.ts"});
}});
`,
    );
    await Bun.write(join(fixture, "answer.ts"), "export default () => 42;");
    await run([
      "node_modules/loopy/dist/cli/src/index.js",
      "--home",
      home,
      "--cwd",
      fixture,
      "graph",
      "entry.ts",
    ]);
    await Bun.write(
      join(fixture, "execute.ts"),
      `
import {Effect} from "effect";
import {compile} from "./node_modules/loopy/dist/compiler/src/index.js";
import {openRunStore, makeLocalService, localDaemon, readDaemonFile} from "loopy/local";
const compiled = await Effect.runPromise(compile(${JSON.stringify(join(fixture, "entry.ts"))}));
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const home = ${JSON.stringify(home)};
  const cwd = ${JSON.stringify(fixture)};
  const store = yield* openRunStore(home);
  const service = makeLocalService({home, cwd, store, clock: {now: Date.now}});
  const daemon = yield* localDaemon({home, cwd, store, concurrency: 1, port: 0});
  const url = yield* daemon.start;
  yield* Effect.promise(async () => {
    const response = await fetch(url);
    const html = await response.text();
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (!response.ok || !html.includes("<html") || !script) {
      throw new Error("Packaged dashboard HTML was not served.");
    }
    const asset = await fetch(new URL(script, url));
    if (!asset.ok || !(await asset.text()).length) {
      throw new Error("Packaged dashboard JavaScript asset was not served.");
    }
  });
  yield* service.putLoopy("packed", {
    graph: compiled.graph, revision: compiled.revision,
    bundles: compiled.bundles,
    replace: false, source: {path: ${JSON.stringify(join(fixture, "entry.ts"))}, workspace: cwd},
  });
  const run = yield* service.startRun("packed", {}, cwd);
  yield* Effect.forkScoped(daemon.run);
  let snapshot = yield* service.runSnapshot(run.id);
  for (let attempt = 0; attempt < 600 && (snapshot.run.status === "queued" || snapshot.run.status === "running"); attempt++) {
    yield* Effect.sleep(50);
    snapshot = yield* service.runSnapshot(run.id);
  }
  if (snapshot.run.status !== "succeeded" || snapshot.run.output !== 42) {
    throw new Error(JSON.stringify(snapshot));
  }
})));
const home = ${JSON.stringify(home)};
try {
  const cli = Bun.spawn([process.execPath, "--no-env-file", "node_modules/loopy/dist/cli/src/index.js", "--home", home, "--cwd", ${JSON.stringify(fixture)}, "list"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited,
  ]);
  if (exit !== 0 || !readDaemonFile(home)) {
    throw new Error("Packaged CLI daemon autostart failed: " + stdout + stderr);
  }
} finally {
  const daemon = readDaemonFile(home);
  if (daemon) {
    process.kill(daemon.pid, "SIGTERM");
    for (let attempt = 0; attempt < 100 && readDaemonFile(home); attempt++) {
      await Bun.sleep(50);
    }
    if (readDaemonFile(home)) {
      process.kill(daemon.pid, "SIGKILL");
      throw new Error("Packaged CLI daemon did not stop cleanly.");
    }
  }
}
console.log("Packed SDK, strict declarations, compiler, builtin parser, worker, dashboard assets and CLI daemon autostart passed.");
`,
    );
    console.log(await run(["execute.ts"]));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await verifyPackedDistribution();
}
