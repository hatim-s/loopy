import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeBoundary, routes } from "@loopy/contract";
import { Cause, Effect, Exit, Fiber } from "effect";
import { type CaseName, cases, prepareWait, verifyCase } from "./cases";
import { io, Runtime } from "./runtime";

const repo = resolve(import.meta.dir, "../../../..");

const git = (...args: string[]) =>
  io("git identity", async () => {
    const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);

    try {
      const text = await new Response(child.stdout).text();

      if ((await child.exited) !== 0) {
        throw new Error("Source identity command failed.");
      }

      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  });

const program = Effect.gen(function* () {
  const root = yield* io("prepare fixture", async () => {
    const parent = join(repo, ".loopy", "acceptance");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "run-"));
    await cp(join(import.meta.dir, "fixtures"), join(root, "project"), { recursive: true });
    await mkdir(join(root, "project", ".loopy", "loopies"), { recursive: true });

    return root;
  });

  const runtime = new Runtime(root, join(root, "project"));

  const records: {
    name: CaseName;
    result: "pending" | "pass" | "fail";
    runId?: string;
    revision?: string;
    status?: string;
  }[] = cases.map((name) => ({ name, result: "pending" }));

  const startedAt = new Date().toISOString();

  const source = {
    head: yield* git("rev-parse", "HEAD"),
    status: yield* git("status", "--porcelain"),
    diffSha256: new Bun.CryptoHasher("sha256").update(yield* git("diff", "HEAD")).digest("hex"),
    acceptanceSha256: yield* io("hash suite", async () => {
      const hash = new Bun.CryptoHasher("sha256");

      const paths = await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: import.meta.dir, onlyFiles: true }),
      );

      for (const path of paths.sort()) {
        hash.update(path);
        hash.update(await Bun.file(join(import.meta.dir, path)).arrayBuffer());
      }

      return hash.digest("hex");
    }),
  };

  console.log(`Local acceptance evidence: ${root}`);
  yield* Effect.acquireUseRelease(
    Effect.succeed(runtime),
    () =>
      Effect.gen(function* () {
        yield* runtime.start();

        for (const record of records) {
          const { name } = record;

          const result = yield* Effect.exit(
            Effect.gen(function* () {
              const fixture = name === "values-no" ? "values" : name;

              if (name !== "values-no") {
                yield* runtime.cli("save", `${fixture}.loopy.ts`);
              }

              const input = name.startsWith("values")
                ? { choose: name === "values", items: [3, 1, 4] }
                : {};

              const admitted = decodeBoundary(routes.startRun.response)(
                JSON.parse(
                  yield* runtime.cli(
                    "run",
                    `acceptance-${fixture}`,
                    "--input-json",
                    JSON.stringify(input),
                  ),
                ),
              );

              record.runId = admitted.id;
              record.revision = yield* runtime.revision(admitted.id);

              yield* prepareWait(runtime, name, admitted.id);
              yield* runtime.until(
                runtime
                  .snapshot(admitted.id)
                  .pipe(
                    Effect.map((snapshot) =>
                      ["succeeded", "failed", "cancelled"].includes(snapshot.run.status),
                    ),
                  ),
              );
              const snapshot = yield* runtime.snapshot(admitted.id);
              record.status = snapshot.run.status;
              yield* io("write snapshot", () =>
                Bun.write(join(root, `${name}.json`), JSON.stringify(snapshot, null, 2)),
              );
              yield* verifyCase(runtime, name, snapshot);
            }),
          );

          record.result = Exit.isSuccess(result) ? "pass" : "fail";
          console.log(`${record.result.toUpperCase()} ${name} ${record.runId ?? "not admitted"}`);

          if (Exit.isFailure(result)) {
            return yield* Effect.failCause(result.cause);
          }
        }
      }),
    (owned, exit) =>
      Effect.gen(function* () {
        const cleanup = yield* Effect.exit(owned.stop());
        const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null;
        yield* io("write report", () =>
          Bun.write(
            join(root, "report.json"),
            JSON.stringify(
              {
                startedAt,
                endedAt: new Date().toISOString(),
                source,
                failure,
                records,
                daemonPids: runtime.starts,
                cleanup: Exit.isSuccess(cleanup) ? "stopped" : Cause.pretty(cleanup.cause),
                retained: true,
                scope: "Local Bun CLI, daemon, SQLite and native executor.",
                excluded: [
                  "cloud",
                  "Docker",
                  "providers",
                  "network workloads",
                  "lease loss",
                  "uncertain execution recovery",
                  "SSE",
                  "schedules",
                  "cancellation",
                  "secrets",
                ],
              },
              null,
              2,
            ),
          ),
        );
        console.log(
          `${failure === null && Exit.isSuccess(cleanup) ? "PASS" : "FAIL"} ${records.filter((record) => record.result === "pass").length}/${cases.length} cases; report: ${join(root, "report.json")}`,
        );

        if (Exit.isFailure(cleanup)) {
          return yield* Effect.failCause(cleanup.cause);
        }
      }),
  );
});

const main = Effect.scoped(
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(program);

    const interrupt = () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };

    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);

    return yield* Fiber.join(fiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", interrupt);
        }),
      ),
    );
  }),
);

await Effect.runPromise(Effect.exit(main)).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause));
    process.exitCode = 1;
  }
});
