import { afterEach, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { ArtifactReader } from "../../../apps/sandbox/src/artifacts";
import { Attempts } from "../../../apps/sandbox/src/attempt";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem/authority";
import { failure } from "../../../apps/sandbox/src/operations";
import type { AuthorityInput } from "../src/contract/sandbox-journal-rpc";
import { artifactReader, successful, uncertain } from "./fixtures/sandbox-authority";
import { cleanup, fixture, open } from "./fixtures/sandbox-authority-lifecycle";
import { run } from "./fixtures/sandbox-run";

afterEach(cleanup);

test("observed terminal result survives result and terminal-pointer publication failures", async () => {
  const { config, request, resultsFor } = await fixture();

  class FailingComplete extends FilesystemAuthority {
    failures = 1;
    override complete(input: AuthorityInput<"complete">) {
      const basecomplete = super.complete.bind(this);

      return Effect.gen({ self: this }, function* () {
        if (this.failures-- > 0) {
          return yield* Effect.fail(failure("fixture", new Error("Pointer unavailable")));
        }

        return yield* basecomplete(input);
      });
    }
  }

  const authority = new FailingComplete(config.stateRoot);
  let puts = 0;
  let recoveries = 0;

  const service = await open(config, {
    authority,
    artifactReader,
    resultsFor: (workspace) => ({
      put: (result) =>
        Effect.gen(function* () {
          puts++;

          if (puts === 1) {
            return yield* Effect.fail(failure("fixture", new Error("Bytes unavailable")));
          }

          return yield* resultsFor(workspace).put(result);
        }),
      get: (ref) => resultsFor(workspace).get(ref),
    }),
    backend: {
      start: () =>
        Effect.gen(function* () {
          return successful;
        }),
      recover: () =>
        Effect.gen(function* () {
          recoveries++;

          return uncertain;
        }),
    },
  });

  await run(service.start(request));
  await run(service.drain());
  expect(await run(service.lookup(request))).toEqual({ kind: "finished", result: successful });
  expect(puts).toBe(3);
  expect(recoveries).toBe(0);
});

test("failed helper cleanup holds its guard across requests and restart while unrelated volumes progress", async () => {
  const { config, request, resultsFor } = await fixture();
  let helperPresent = false;
  let cleanupFails = true;
  let exports = 0;

  const reader: ArtifactReader = {
    read: (receipt, path) =>
      Effect.gen(function* () {
        exports++;
        helperPresent = true;

        return yield* artifactReader.read(receipt, path);
      }),
    cleanup: () =>
      Effect.gen(function* () {
        if (cleanupFails && helperPresent) {
          return yield* Effect.fail(failure("fixture", new Error("Docker cleanup unavailable")));
        }

        helperPresent = false;
      }),
  };

  const backend = {
    start: () =>
      Effect.gen(function* () {
        return successful;
      }),
    recover: () =>
      Effect.gen(function* () {
        return uncertain;
      }),
  };

  const authority = new FilesystemAuthority(config.stateRoot);

  const first = await open(config, {
    authority,
    resultsFor,
    artifactReader: reader,
    backend,
    close: () => authority.close(),
  });

  await run(first.start(request));
  await run(first.drain());
  await expect(run(first.artifact({ ...request, path: "out.txt" }))).rejects.toMatchObject({
    code: "conflict",
  });
  expect(helperPresent).toBe(true);
  expect((await run(authority.recoverable({ after: null, limit: 200 }))).exports).toHaveLength(1);
  await expect(run(first.start({ ...request, attempt: 2 }))).rejects.toMatchObject({
    code: "conflict",
  });
  await run(first.close());
  const successor = new FilesystemAuthority(config.stateRoot);

  const second = await open(config, {
    authority: successor,
    resultsFor,
    artifactReader: reader,
    backend,
  });

  await expect(run(second.start({ ...request, attempt: 2 }))).rejects.toMatchObject({
    code: "conflict",
  });
  await run(
    second.start({ ...request, executionKey: { ...request.executionKey, runId: "other" } }),
  );
  expect((await run(successor.recoverable({ after: null, limit: 200 }))).exports).toHaveLength(1);
  expect(exports).toBe(1);
  cleanupFails = false;
  await run(second.start({ ...request, attempt: 2 }));
  await run(second.drain());
  expect(helperPresent).toBe(false);
  expect((await run(successor.recoverable({ after: null, limit: 200 }))).exports).toHaveLength(0);
});

test("dependency construction happens under the process lock, and root path validation remains strict", async () => {
  const { config } = await fixture();
  let called = false;
  await expect(
    run(
      Effect.scoped(
        Attempts.open(config, () =>
          Effect.promise(async () => {
            called = true;
            const lock = JSON.parse(await Bun.file(join(config.stateRoot, "service.lock")).text());
            expect(lock.pid).toBe(process.pid);
            throw new Error("Factory rejected populated filesystem receipts");
          }),
        ),
      ),
    ),
  ).rejects.toThrow("populated filesystem receipts");
  expect(called).toBe(true);
  await writeFile(join(config.stateRoot, "receipts", "unrelated.txt"), "preserved");
  expect(await Bun.file(join(config.stateRoot, "service.lock")).exists()).toBe(false);
});

test("oversized terminal metadata becomes a publishable output-limit result", async () => {
  const { config, request, resultsFor } = await fixture();
  const authority = new FilesystemAuthority(config.stateRoot);

  const service = await open(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: {
      start: () =>
        Effect.gen(function* () {
          return {
            ...uncertain,
            kind: "failed",
            error: { code: "execution", message: "x".repeat(2 * 1024 * 1024) },
            exitCode: null,
            logs: [],
          };
        }),
      recover: () =>
        Effect.gen(function* () {
          return uncertain;
        }),
    },
  });

  await run(service.start(request));
  await run(service.drain());
  const receipt = await run(service.lookup(request));
  expect(
    receipt.kind === "finished" && receipt.result.kind === "failed" && receipt.result.error.code,
  ).toBe("output_limit");
});

test("artifact export uses terminal authority without reading unavailable result bytes", async () => {
  const { config, request, resultsFor, plan } = await fixture();
  const authority = new FilesystemAuthority(config.stateRoot);
  let reads = 0;
  let cleanups = 0;
  let exports = 0;

  const service = await open(config, {
    authority,
    resultsFor: (workspace) => ({
      put: (result) => resultsFor(workspace).put(result),
      get: () =>
        Effect.gen(function* () {
          reads++;

          return yield* Effect.fail(
            failure("fixture", new Error("Terminal result storage unavailable")),
          );
        }),
    }),
    artifactReader: {
      read: (plan, path) =>
        Effect.gen(function* () {
          exports++;
          expect(
            (yield* authority.exportGuards({ after: null, limit: 1, volume: plan.volume })).exports,
          ).toHaveLength(1);

          return yield* artifactReader.read(plan, path);
        }),
      cleanup: () =>
        Effect.gen(function* () {
          cleanups++;
        }),
    },
    backend: {
      start: () =>
        Effect.gen(function* () {
          return successful;
        }),
      recover: () =>
        Effect.gen(function* () {
          return uncertain;
        }),
    },
  });

  await run(service.start(request));
  await run(service.drain());
  await expect(run(service.lookup(request))).rejects.toThrow("Terminal result storage unavailable");
  expect(reads).toBe(1);
  expect(await run(service.artifact({ ...request, path: "out.txt" }))).toEqual(
    await run(artifactReader.read(plan(), "out.txt")),
  );
  expect(reads).toBe(1);
  expect(exports).toBe(1);
  expect(cleanups).toBe(1);
  expect(
    (await run(authority.exportGuards({ after: null, limit: 1, volume: plan().volume }))).exports,
  ).toHaveLength(0);
});

test("new admission reconciles only export metadata despite multiple pages of unrelated attempts and terminal history", async () => {
  const { config, request, resultsFor, plan } = await fixture();

  class CountingAuthority extends FilesystemAuthority {
    recoveryQueries = 0;
    exportQueries: AuthorityInput<"exportGuards">[] = [];
    override recoverable(input: AuthorityInput<"recoverable">) {
      const baserecoverable = super.recoverable.bind(this);

      return Effect.gen({ self: this }, function* () {
        this.recoveryQueries++;

        return yield* baserecoverable(input);
      });
    }
    override exportGuards(input: AuthorityInput<"exportGuards">) {
      const baseexportGuards = super.exportGuards.bind(this);

      return Effect.gen({ self: this }, function* () {
        this.exportQueries.push(input);

        return yield* baseexportGuards(input);
      });
    }
  }

  const authority = new CountingAuthority(config.stateRoot);

  const service = await open(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: {
      start: () =>
        Effect.gen(function* () {
          return successful;
        }),
      recover: () =>
        Effect.gen(function* () {
          return uncertain;
        }),
    },
  });

  const session = { epoch: 1, nonce: "historical-session" };

  // Populate after startup so startup recovery keeps its separate combined scan.
  for (let index = 0; index < 402; index++) {
    const historical = plan(1, `history-${index}`);

    const record =
      index < 201
        ? { kind: "started", session, plan: historical }
        : {
            kind: "finished",
            session,
            plan: historical,
            result: { kind: "inline", value: successful },
          };

    await writeFile(
      join(config.stateRoot, "receipts", `${historical.id}.json`),
      JSON.stringify(record),
    );
  }

  expect((await readdir(join(config.stateRoot, "receipts"))).length).toBe(402);
  const before = authority.recoveryQueries;
  authority.exportQueries.length = 0;
  await run(service.start(request));
  await run(service.drain());
  expect(await run(service.lookup(request))).toEqual({ kind: "finished", result: successful });
  expect(authority.recoveryQueries).toBe(before);
  expect(authority.exportQueries).toEqual([{ after: null, limit: 200, volume: plan().volume }]);
});
