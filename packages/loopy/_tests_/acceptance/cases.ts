import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeBoundary, type RunSnapshotView, routes } from "@loopy/contract";
import { Effect } from "effect";
import { type AcceptanceError, io, type Runtime, verify } from "./runtime";

type Step<A> = (value: A, runtime: Runtime) => Effect.Effect<void, AcceptanceError>;

export type AcceptanceCase = {
  name: string;
  fixture: string;
  input?: { choose: boolean; items: number[] };
  prepare?: Step<string>;
  verify: Step<RunSnapshotView>;
};

const marker = (runtime: Runtime, file: string) =>
  io(`read ${file}`, () => readFile(join(runtime.workspace, file), "utf8"));

const writeEvidence = (runtime: Runtime, file: string, value: RunSnapshotView) =>
  io(`write ${file}`, () => Bun.write(join(runtime.root, file), JSON.stringify(value, null, 2)));

const restart = (runtime: Runtime) =>
  Effect.gen(function* () {
    yield* runtime.stop();
    yield* runtime.start();
  });

const isRetrying = (node: RunSnapshotView["nodeRuns"][number]) =>
  node.key.nodeId.endsWith(":retry-command");

const values =
  (choose: boolean): Step<RunSnapshotView> =>
  (snapshot, runtime) =>
    Effect.gen(function* () {
      const { run } = snapshot;
      const graph = yield* runtime.graph(run.id);
      yield* verify(() => {
        assert.equal(run.status, "succeeded");

        if (run.status === "succeeded") {
          assert.deepEqual(run.output, {
            command: "hello",
            doubled: 14,
            parsed: 7,
            choice: choose ? "yes" : { stdout: "no", stderr: "", exitCode: 0 },
            values: [6, 2, 8],
          });
        }

        const parallel = graph.graph.nodes.find((node) => node.kind === "parallel");
        assert.ok(parallel);

        const children = graph.graph.nodes.filter(
          (node) => node.scope === parallel.id && (node.kind === "command" || node.kind === "code"),
        );

        assert.equal(children.length, 2);

        for (const child of children) {
          assert.ok(
            snapshot.nodeRuns.some(
              (node) => node.key.nodeId === child.id && node.status === "succeeded",
            ),
          );
        }
      });

      const exists = yield* io("branch marker", () =>
        Bun.file(join(runtime.workspace, "forbidden-arm")).exists(),
      );

      yield* verify(() => assert.equal(exists, !choose));
    });

const effectsAround =
  (file: string, output: string): Step<RunSnapshotView> =>
  ({ run }, runtime) =>
    Effect.gen(function* () {
      const effects = yield* marker(runtime, file);
      yield* verify(() => {
        assert.equal(run.status, "succeeded");

        if (run.status === "succeeded") {
          assert.equal(run.output, output);
        }

        assert.equal(effects, "before\nafter\n");
      });
    });

export const cases: readonly AcceptanceCase[] = [
  {
    name: "values",
    fixture: "values",
    input: { choose: true, items: [3, 1, 4] },
    verify: values(true),
  },
  {
    name: "values-no",
    fixture: "values",
    input: { choose: false, items: [3, 1, 4] },
    verify: values(false),
  },
  {
    name: "recovery",
    fixture: "recovery",
    prepare: (id, runtime) =>
      Effect.gen(function* () {
        yield* runtime.until(
          runtime
            .snapshot(id)
            .pipe(
              Effect.map((snapshot) =>
                snapshot.nodeRuns.some((node) => isRetrying(node) && node.status === "retrying"),
              ),
            ),
        );
        yield* writeEvidence(runtime, "retry-pending.json", yield* runtime.snapshot(id));
      }),
    verify: (snapshot, runtime) =>
      Effect.gen(function* () {
        const { run } = snapshot;
        const attempts = yield* marker(runtime, "attempts");
        const cleanup = yield* marker(runtime, "cleanup");

        const pending = yield* io("read retry", () =>
          Bun.file(join(runtime.root, "retry-pending.json")).json(),
        );

        yield* verify(() => {
          assert.equal(run.status, "succeeded");

          if (run.status === "succeeded") {
            assert.deepEqual(run.output, {
              retried: "recovered",
              rescued: "expected authored failure",
            });
          }

          assert.equal(attempts, "attempt\nattempt\n");
          assert.equal(cleanup, "cleanup\n");

          const retried = snapshot.nodeRuns.filter(isRetrying);

          assert.deepEqual(
            retried.map((node) => [node.attempt, node.status]),
            [[2, "succeeded"]],
          );

          const first = decodeBoundary(routes.run.response)(pending).nodeRuns.find(isRetrying);

          assert.equal(first?.attempt, 1);
          assert.equal(first?.status, "retrying");
          assert.deepEqual(first?.key, retried[0]?.key);
        });
      }),
  },
  {
    name: "wait",
    fixture: "wait",
    prepare: (id, runtime) =>
      Effect.gen(function* () {
        yield* runtime.until(
          runtime
            .snapshot(id)
            .pipe(Effect.map((snapshot) => snapshot.run.waitingOn?.hook === "approval")),
        );
        const before = yield* runtime.snapshot(id);
        yield* writeEvidence(runtime, "hook-before-restart.json", before);
        yield* restart(runtime);
        const resumed = yield* runtime.snapshot(id);
        yield* verify(() => assert.deepEqual(resumed.run.waitingOn, before.run.waitingOn));
        yield* runtime.cli("hook", id, "approval", "--payload", '{"answer":"approved"}');
      }),
    verify: effectsAround("effects", "approved"),
  },
  {
    name: "sleep",
    fixture: "sleep",
    prepare: (id, runtime) =>
      Effect.gen(function* () {
        yield* runtime.until(
          runtime.snapshot(id).pipe(Effect.map((snapshot) => snapshot.run.status === "suspended")),
        );
        const before = yield* runtime.snapshot(id);
        yield* writeEvidence(runtime, "sleep-before-restart.json", before);
        yield* restart(runtime);
        const resumed = yield* runtime.snapshot(id);
        yield* verify(() => {
          assert.equal(before.run.status, "suspended");
          assert.equal(resumed.run.status, "suspended");

          if (before.run.status === "suspended" && resumed.run.status === "suspended") {
            assert.equal(resumed.run.wakeAt, before.run.wakeAt);
          }
        });
      }),
    verify: effectsAround("sleep-effects", "awake"),
  },
  {
    name: "failure",
    fixture: "failure",
    verify: ({ run }) =>
      verify(() => {
        assert.equal(run.status, "failed");

        if (run.status === "failed") {
          assert.equal(run.error, "acceptance terminal failure");
        }
      }),
  },
  {
    name: "invalid",
    fixture: "invalid",
    verify: (snapshot) =>
      verify(() => {
        assert.equal(snapshot.run.status, "failed");
        const nodes = snapshot.nodeRuns.filter((node) => node.key.nodeId.endsWith(":invalid"));
        assert.equal(nodes.length, 1);
        const node = nodes[0];
        assert.equal(node?.attempt, 1);
        assert.equal(node?.status, "failed");

        if (node?.status === "failed") {
          assert.equal(node.error.code, "validation");
        }
      }),
  },
];
