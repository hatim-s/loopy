// package.ts copies this file into the packed consumer and points the private
// compiler specifier at the vendored dist module, which has no public entry.
import { join } from "node:path";
import { compile } from "@loopy/compiler";
import { Effect } from "effect";
import { localDaemon, makeLocalService, openRunStore, readDaemonFile } from "loopy/local";

const [home, cwd] = process.argv.slice(2);

if (!home || !cwd) {
  throw new Error("Pass the Loopy home and consumer directory: bun execute.ts <home> <cwd>.");
}

const entry = join(cwd, "entry.ts");

const cliPath = join(cwd, "node_modules/loopy/dist/cli/src/index.js");

const compiled = await Effect.runPromise(compile(entry));

if (!compiled.ok) {
  throw new Error(JSON.stringify(compiled.diagnostics));
}

const assertDashboardServed = async (url: string) => {
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
};

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openRunStore(home);
      const service = makeLocalService({ home, store, clock: { now: Date.now } });
      const daemon = yield* localDaemon({
        home,
        cwd,
        store,
        concurrency: 1,
        port: 0,
        assets: join(cwd, "node_modules/loopy/dist/dashboard"),
      });
      const url = yield* daemon.start;
      yield* Effect.promise(() => assertDashboardServed(url));
      yield* service.putLoopy("packed", {
        graph: compiled.graph,
        revision: compiled.revision,
        bundles: compiled.bundles,
        replace: false,
        source: { path: entry, workspace: cwd },
      });
      const run = yield* service.startRun("packed", {}, cwd);
      yield* Effect.forkScoped(daemon.run);
      let snapshot = yield* service.runSnapshot(run.id);

      for (
        let attempt = 0;
        attempt < 600 && (snapshot.run.status === "queued" || snapshot.run.status === "running");
        attempt++
      ) {
        yield* Effect.sleep(50);
        snapshot = yield* service.runSnapshot(run.id);
      }

      if (snapshot.run.status !== "succeeded" || snapshot.run.output !== 42) {
        throw new Error(JSON.stringify(snapshot));
      }
    }),
  ),
);

const stopAutostartedDaemon = async () => {
  const daemon = readDaemonFile(home);

  if (!daemon) {
    return;
  }

  process.kill(daemon.pid, "SIGTERM");

  for (let attempt = 0; attempt < 100 && readDaemonFile(home); attempt++) {
    await Bun.sleep(50);
  }

  if (readDaemonFile(home)) {
    process.kill(daemon.pid, "SIGKILL");
    throw new Error("Packaged CLI daemon did not stop cleanly.");
  }
};

try {
  const cli = Bun.spawn(
    [process.execPath, "--no-env-file", cliPath, "--home", home, "--cwd", cwd, "list"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr, exit] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);

  if (exit !== 0 || !readDaemonFile(home)) {
    throw new Error(`Packaged CLI daemon autostart failed: ${stdout}${stderr}`);
  }
} finally {
  await stopAutostartedDaemon();
}

console.log(
  "Packed SDK, strict declarations, compiler, builtin parser, worker, dashboard assets and CLI daemon autostart passed.",
);
