import { expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuthorityInput, JOURNAL_PAGE_LIMIT } from "@loopy/contract/sandbox";
import { Effect, Exit } from "effect";
import type { ArtifactReader } from "../src/artifacts";
import { Attempts } from "../src/attempt";
import { FilesystemAuthority } from "../src/filesystem/authority";
import { failure } from "../src/operations";
import { stateLayout } from "../src/state-root";
import {
  artifactReader,
  authorityFixture,
  CountingBackend,
  successful,
  uncertain,
} from "./fixtures/authority";
import { openAttemptsWith, run } from "./fixtures/run";

test("observed terminal result survives result and terminal-pointer publication failures", async () => {
  const { config, request, resultsFor } = await authorityFixture();

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
  const counting = new CountingBackend();

  const service = await openAttemptsWith(config, {
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
    backend: counting,
  });

  await run(service.start(request));
  await run(service.drain());
  expect(await run(service.lookup(request))).toEqual({ kind: "finished", result: successful });
  expect(puts).toBe(3);
  expect(counting.recoveries).toBe(0);
});

test("failed helper cleanup holds its guard across requests and restart while unrelated volumes progress", async () => {
  const { config, request, resultsFor } = await authorityFixture();
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

  const backend = new CountingBackend();

  const authority = new FilesystemAuthority(config.stateRoot);

  const first = await openAttemptsWith(config, {
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

  const second = await openAttemptsWith(config, {
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

test("dependency construction happens under the process lock, which a failed open releases", async () => {
  const { config } = await authorityFixture();
  const lock = stateLayout(config.stateRoot).lock;
  const owners: string[] = [];

  const opened = await run(
    Effect.scoped(
      Attempts.open(config, () =>
        Effect.gen(function* () {
          owners.push(yield* Effect.promise(() => Bun.file(lock).text()));

          return yield* Effect.fail(failure("fixture", new Error("Factory failed")));
        }),
      ),
    ).pipe(Effect.exit),
  );

  expect(Exit.isFailure(opened)).toBe(true);
  expect(owners.map((owner) => owner.split(" ")[0])).toEqual([String(process.pid)]);
  expect(await Bun.file(lock).exists()).toBe(false);
});

test("oversized terminal metadata becomes a publishable output-limit result", async () => {
  const { config, request, resultsFor } = await authorityFixture();
  const authority = new FilesystemAuthority(config.stateRoot);

  const service = await openAttemptsWith(config, {
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
  const { config, request, resultsFor, plan } = await authorityFixture();
  const authority = new FilesystemAuthority(config.stateRoot);
  let reads = 0;
  let cleanups = 0;
  const guardsDuringExport: number[] = [];

  const service = await openAttemptsWith(config, {
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
          guardsDuringExport.push(
            (yield* authority.exportGuards({ after: null, limit: 1, volume: plan.volume })).exports
              .length,
          );

          return yield* artifactReader.read(plan, path);
        }),
      cleanup: () =>
        Effect.gen(function* () {
          cleanups++;
        }),
    },
    backend: new CountingBackend(),
  });

  await run(service.start(request));
  await run(service.drain());
  await expect(run(service.lookup(request))).rejects.toThrow("Terminal result storage unavailable");
  expect(reads).toBe(1);
  expect(await run(service.artifact({ ...request, path: "out.txt" }))).toEqual(
    await run(artifactReader.read(await plan(), "out.txt")),
  );
  expect(reads).toBe(1);
  expect(guardsDuringExport).toEqual([1]);
  expect(cleanups).toBe(1);
  expect(
    (await run(authority.exportGuards({ after: null, limit: 1, volume: (await plan()).volume })))
      .exports,
  ).toHaveLength(0);
});

test("new admission reconciles only export metadata despite multiple pages of unrelated attempts and terminal history", async () => {
  const { config, request, resultsFor, plan } = await authorityFixture();

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

  const service = await openAttemptsWith(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: new CountingBackend(),
  });

  const session = { epoch: 1, nonce: "historical-session" };
  const ref = await run(resultsFor(request.workspace).put(successful));
  // Each kind fills more than one journal page, so a full scan would need several pages.
  const perKind = JOURNAL_PAGE_LIMIT + 1;

  // Populate after startup so startup recovery keeps its separate combined scan.
  for (let index = 0; index < 2 * perKind; index++) {
    const historical = await plan(1, `history-${index}`);

    const record =
      index < perKind
        ? { kind: "started", session, plan: historical }
        : { kind: "finished", session, plan: historical, result: { kind: "blob", ref } };

    await writeFile(
      join(stateLayout(config.stateRoot).receipts, `${historical.id}.json`),
      JSON.stringify(record),
    );
  }

  expect((await readdir(stateLayout(config.stateRoot).receipts)).length).toBe(2 * perKind);
  const before = authority.recoveryQueries;
  authority.exportQueries.length = 0;
  await run(service.start(request));
  await run(service.drain());
  expect(await run(service.lookup(request))).toEqual({ kind: "finished", result: successful });
  expect(authority.recoveryQueries).toBe(before);
  expect(authority.exportQueries).toEqual([
    { after: null, limit: JOURNAL_PAGE_LIMIT, volume: (await plan()).volume },
  ]);
});
