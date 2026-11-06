import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeBoundary, type RunSnapshotView, routes } from "../../packages/loopy/src/contract";
import { io, type Runtime, verify } from "./runtime";

export const cases = [
  "values",
  "values-no",
  "recovery",
  "wait",
  "sleep",
  "failure",
  "invalid",
] as const;

export type CaseName = (typeof cases)[number];

export const prepareWait = (runtime: Runtime, name: CaseName, id: string) =>
  Effect.gen(function* () {
    if (name === "recovery") {
      yield* runtime.until(
        runtime
          .snapshot(id)
          .pipe(
            Effect.map((snapshot) =>
              snapshot.nodeRuns.some(
                (node) => node.key.nodeId.endsWith(":retry-command") && node.status === "retrying",
              ),
            ),
          ),
      );
      const retry = yield* runtime.snapshot(id);
      yield* io("write retry", () =>
        Bun.write(join(runtime.root, "retry-pending.json"), JSON.stringify(retry, null, 2)),
      );
    }

    if (name === "wait") {
      yield* runtime.until(
        runtime
          .snapshot(id)
          .pipe(Effect.map((snapshot) => snapshot.run.waitingOn?.hook === "approval")),
      );
      const before = yield* runtime.snapshot(id);
      yield* io("write pending hook", () =>
        Bun.write(join(runtime.root, "hook-before-restart.json"), JSON.stringify(before, null, 2)),
      );
      yield* runtime.stop();
      yield* runtime.start();
      const resumed = yield* runtime.snapshot(id);
      yield* verify(() => assert.deepEqual(resumed.run.waitingOn, before.run.waitingOn));
      yield* runtime.cli("hook", id, "approval", "--payload", '{"answer":"approved"}');
    }

    if (name === "sleep") {
      yield* runtime.until(
        runtime.snapshot(id).pipe(Effect.map((snapshot) => snapshot.run.status === "suspended")),
      );
      const before = yield* runtime.snapshot(id);
      yield* io("write pending sleep", () =>
        Bun.write(join(runtime.root, "sleep-before-restart.json"), JSON.stringify(before, null, 2)),
      );
      yield* runtime.stop();
      yield* runtime.start();
      const resumed = yield* runtime.snapshot(id);
      yield* verify(() => {
        assert.equal(before.run.status, "suspended");
        assert.equal(resumed.run.status, "suspended");

        if (before.run.status === "suspended" && resumed.run.status === "suspended") {
          assert.equal(resumed.run.wakeAt, before.run.wakeAt);
        }
      });
    }
  });

export const verifyCase = (runtime: Runtime, name: CaseName, snapshot: RunSnapshotView) =>
  Effect.gen(function* () {
    const marker = (file: string) =>
      io(`read ${file}`, () => readFile(join(runtime.workspace, file), "utf8"));

    const { run } = snapshot;

    if (name === "values" || name === "values-no") {
      const graph = yield* runtime.graph(run.id);
      yield* verify(() => {
        assert.equal(run.status, "succeeded");

        if (run.status === "succeeded") {
          assert.deepEqual(run.output, {
            command: "hello",
            doubled: 14,
            parsed: 7,
            choice: name === "values" ? "yes" : { stdout: "no", stderr: "", exitCode: 0 },
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

      yield* verify(() => assert.equal(exists, name === "values-no"));
    }

    if (name === "recovery") {
      const attempts = yield* marker("attempts");
      const cleanup = yield* marker("cleanup");

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

        const retried = snapshot.nodeRuns.filter((node) =>
          node.key.nodeId.endsWith(":retry-command"),
        );

        assert.deepEqual(
          retried.map((node) => [node.attempt, node.status]),
          [[2, "succeeded"]],
        );

        const first = decodeBoundary(routes.run.response)(pending).nodeRuns.find((node) =>
          node.key.nodeId.endsWith(":retry-command"),
        );

        assert.equal(first?.attempt, 1);
        assert.equal(first?.status, "retrying");
        assert.deepEqual(first?.key, retried[0]?.key);
      });
    }

    if (name === "wait" || name === "sleep") {
      const effects = yield* marker(name === "wait" ? "effects" : "sleep-effects");
      yield* verify(() => {
        assert.equal(run.status, "succeeded");

        if (run.status === "succeeded") {
          assert.equal(run.output, name === "wait" ? "approved" : "awake");
        }

        assert.equal(effects, "before\nafter\n");
      });
    }

    if (name === "failure") {
      yield* verify(() => {
        assert.equal(run.status, "failed");

        if (run.status === "failed") {
          assert.equal(run.error, "acceptance terminal failure");
        }
      });
    }

    if (name === "invalid") {
      yield* verify(() => {
        assert.equal(run.status, "failed");
        const nodes = snapshot.nodeRuns.filter((node) => node.key.nodeId.endsWith(":invalid"));
        assert.equal(nodes.length, 1);
        const node = nodes[0];
        assert.equal(node?.attempt, 1);
        assert.equal(node?.status, "failed");

        if (node?.status === "failed") {
          assert.equal(node.error.code, "validation");
        }
      });
    }
  });
