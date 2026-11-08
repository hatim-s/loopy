// package.ts copies this file into the packed consumer, which imports only public entries.
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { localDaemon, makeLocalService, openRunStore, readDaemonFile } from "loopy/local";

const [home, cwd] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.String]))(
  process.argv.slice(2),
);

const cliPath = join(cwd, "node_modules/loopy/dist/cli/src/index.js");

/** Runs the packed CLI against this home and returns its stdout, failing on a nonzero exit. */
async function packedCli(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", cliPath, "--home", home, "--cwd", cwd, ...args],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exit !== 0) {
    throw new Error(`Packed CLI ${args.join(" ")} exited ${exit}: ${stdout}${stderr}`);
  }

  return stdout;
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
      const service = makeLocalService({ home, store });

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
      // The packed CLI compiles and saves through this daemon, as an installed user would.
      yield* Effect.promise(() => packedCli(["save", "entry.ts"]));

      const { id } = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
      )(yield* Effect.promise(() => packedCli(["run", "packed"])));

      yield* Effect.forkScoped(daemon.run);
      let snapshot = yield* service.runSnapshot(id);

      for (
        let attempt = 0;
        attempt < 600 && (snapshot.run.status === "queued" || snapshot.run.status === "running");
        attempt++
      ) {
        yield* Effect.sleep(50);
        snapshot = yield* service.runSnapshot(id);
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
  await packedCli(["list"]);

  if (!readDaemonFile(home)) {
    throw new Error("Packaged CLI daemon autostart left no discovery file.");
  }
} finally {
  await stopAutostartedDaemon();
}

console.log(
  "Packed SDK, strict declarations, CLI save and run, builtin parser, worker, dashboard assets and CLI daemon autostart passed.",
);
