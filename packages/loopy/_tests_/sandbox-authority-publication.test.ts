import { afterEach, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactReader } from "../../../apps/sandbox/src/artifacts.js";
import { Attempts } from "../../../apps/sandbox/src/attempts.js";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem-authority.js";
import type { AuthorityInput } from "../src/contract/sandbox-journal-rpc.js";
import { artifactReader, successful, uncertain } from "./fixtures/sandbox-authority.js";
import { cleanup, fixture, open } from "./fixtures/sandbox-authority-lifecycle.js";

afterEach(cleanup);

test("observed terminal result survives result and terminal-pointer publication failures", async () => {
  const { config, request, resultsFor } = await fixture();

  class FailingComplete extends FilesystemAuthority {
    failures = 1;
    override async complete(input: AuthorityInput<"complete">) {
      if (this.failures-- > 0) {
        throw new Error("Pointer unavailable");
      }

      return super.complete(input);
    }
  }

  const authority = new FailingComplete(config.stateRoot);
  let puts = 0;
  let recoveries = 0;

  const service = await open(config, {
    authority,
    artifactReader,
    resultsFor: (workspace) => ({
      put: async (result) => {
        puts++;

        if (puts === 1) {
          throw new Error("Bytes unavailable");
        }

        return resultsFor(workspace).put(result);
      },
      get: (ref) => resultsFor(workspace).get(ref),
    }),
    backend: {
      start: async () => successful,
      recover: async () => {
        recoveries++;

        return uncertain;
      },
    },
  });

  await service.start(request);
  await service.drain();
  expect(await service.lookup(request)).toEqual({ kind: "finished", result: successful });
  expect(puts).toBe(3);
  expect(recoveries).toBe(0);
});

test("failed helper cleanup holds its guard across requests and restart while unrelated volumes progress", async () => {
  const { config, request, resultsFor } = await fixture();
  let helperPresent = false;
  let cleanupFails = true;
  let exports = 0;

  const reader: ArtifactReader = {
    read: async (receipt, path) => {
      exports++;
      helperPresent = true;

      return artifactReader.read(receipt, path);
    },
    cleanup: async () => {
      if (cleanupFails && helperPresent) {
        throw new Error("Docker cleanup unavailable");
      }

      helperPresent = false;
    },
  };

  const backend = { start: async () => successful, recover: async () => uncertain };
  const authority = new FilesystemAuthority(config.stateRoot);

  const first = await open(config, {
    authority,
    resultsFor,
    artifactReader: reader,
    backend,
    close: () => authority.close(),
  });

  await first.start(request);
  await first.drain();
  await expect(first.artifact({ ...request, path: "out.txt" })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(helperPresent).toBe(true);
  expect((await authority.recoverable({ after: null, limit: 200 })).exports).toHaveLength(1);
  await expect(first.start({ ...request, attempt: 2 })).rejects.toMatchObject({ code: "conflict" });
  await first.close();
  const successor = new FilesystemAuthority(config.stateRoot);

  const second = await open(config, {
    authority: successor,
    resultsFor,
    artifactReader: reader,
    backend,
  });

  await expect(second.start({ ...request, attempt: 2 })).rejects.toMatchObject({
    code: "conflict",
  });
  await second.start({ ...request, executionKey: { ...request.executionKey, runId: "other" } });
  expect((await successor.recoverable({ after: null, limit: 200 })).exports).toHaveLength(1);
  expect(exports).toBe(1);
  cleanupFails = false;
  await second.start({ ...request, attempt: 2 });
  await second.drain();
  expect(helperPresent).toBe(false);
  expect((await successor.recoverable({ after: null, limit: 200 })).exports).toHaveLength(0);
});

test("dependency construction happens under the process lock, and root path validation remains strict", async () => {
  const { config } = await fixture();
  let called = false;
  await expect(
    Attempts.open(config, async () => {
      called = true;
      const lock = JSON.parse(await Bun.file(join(config.stateRoot, "service.lock")).text());
      expect(lock.pid).toBe(process.pid);
      throw new Error("Factory rejected populated filesystem receipts");
    }),
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
      start: async () => ({
        ...uncertain,
        kind: "failed",
        error: { code: "execution", message: "x".repeat(2 * 1024 * 1024) },
        exitCode: null,
        logs: [],
      }),
      recover: async () => uncertain,
    },
  });

  await service.start(request);
  await service.drain();
  const receipt = await service.lookup(request);
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
      get: async () => {
        reads++;
        throw new Error("Terminal result storage unavailable");
      },
    }),
    artifactReader: {
      read: async (plan, path) => {
        exports++;
        expect(
          (await authority.exportGuards({ after: null, limit: 1, volume: plan.volume })).exports,
        ).toHaveLength(1);

        return artifactReader.read(plan, path);
      },
      cleanup: async () => {
        cleanups++;
      },
    },
    backend: { start: async () => successful, recover: async () => uncertain },
  });

  await service.start(request);
  await service.drain();
  await expect(service.lookup(request)).rejects.toThrow("Terminal result storage unavailable");
  expect(reads).toBe(1);
  expect(await service.artifact({ ...request, path: "out.txt" })).toEqual(
    await artifactReader.read(plan(), "out.txt"),
  );
  expect(reads).toBe(1);
  expect(exports).toBe(1);
  expect(cleanups).toBe(1);
  expect(
    (await authority.exportGuards({ after: null, limit: 1, volume: plan().volume })).exports,
  ).toHaveLength(0);
});

test("new admission reconciles only export metadata despite multiple pages of unrelated attempts and terminal history", async () => {
  const { config, request, resultsFor, plan } = await fixture();

  class CountingAuthority extends FilesystemAuthority {
    recoveryQueries = 0;
    exportQueries: AuthorityInput<"exportGuards">[] = [];
    override async recoverable(input: AuthorityInput<"recoverable">) {
      this.recoveryQueries++;

      return super.recoverable(input);
    }
    override async exportGuards(input: AuthorityInput<"exportGuards">) {
      this.exportQueries.push(input);

      return super.exportGuards(input);
    }
  }

  const authority = new CountingAuthority(config.stateRoot);

  const service = await open(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: { start: async () => successful, recover: async () => uncertain },
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
  await service.start(request);
  await service.drain();
  expect(await service.lookup(request)).toEqual({ kind: "finished", result: successful });
  expect(authority.recoveryQueries).toBe(before);
  expect(authority.exportQueries).toEqual([{ after: null, limit: 200, volume: plan().volume }]);
});
