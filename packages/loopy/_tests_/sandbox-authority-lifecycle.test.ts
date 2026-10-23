import { afterEach, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem-authority.js";
import type { SandboxExecutionResult } from "../src/contract/index.js";
import type { AuthorityInput } from "../src/contract/sandbox-journal-rpc.js";
import { artifactReader, successful, uncertain } from "./fixtures/sandbox-authority.js";

import { cleanup, fixture, open } from "./fixtures/sandbox-authority-lifecycle.js";

afterEach(cleanup);

class FaultAuthority extends FilesystemAuthority {
  drop = false;
  unavailable = false;
  failBeforeCommit = false;
  reads = 0;
  drops = 0;
  override async read(id: string) {
    this.reads++;

    if (this.unavailable) {
      throw new Error("Authority read unavailable");
    }

    return super.read(id);
  }
  override async admit(input: AuthorityInput<"admit">) {
    if (this.failBeforeCommit) {
      this.failBeforeCommit = false;
      throw new Error("Before commit");
    }

    const reply = await super.admit(input);

    if (this.drop) {
      this.drop = false;
      this.drops++;
      this.unavailable = true;
      throw new Error("Acknowledgement dropped");
    }

    return reply;
  }
}

async function eventually(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Expected bounded reconciliation progress.");
}

test("lost admission acknowledgement and unavailable resolving reads retain one same-session start gate", async () => {
  const { config, request, resultsFor } = await fixture();
  const authority = new FaultAuthority(config.stateRoot);
  const complete = Promise.withResolvers<SandboxExecutionResult>();
  let starts = 0;
  let recoveries = 0;

  const service = await open(config, {
    authority,
    resultsFor,
    artifactReader,
    close: () => authority.close(),
    backend: {
      start: async () => {
        starts++;

        return complete.promise;
      },
      recover: async () => {
        recoveries++;

        return uncertain;
      },
    },
  });

  authority.drop = true;
  const first = service.start(request);
  await eventually(() => authority.drops === 1);
  const second = service.start(request);
  expect(starts).toBe(0);
  authority.unavailable = false;
  expect(await first).toEqual({ kind: "started" });
  expect(await second).toEqual({ kind: "started" });
  expect(starts).toBe(1);
  const reads = authority.reads;

  for (let index = 0; index < 20; index++) {
    expect(await service.lookup(request)).toEqual({ kind: "started" });
  }

  expect(authority.reads - reads).toBe(0);
  complete.resolve(successful);
  await service.drain();
  expect(await service.lookup(request)).toEqual({ kind: "finished", result: successful });
  expect(starts).toBe(1);
  expect(recoveries).toBe(0);
  expect(
    (await readdir(join(config.stateRoot, "receipts"))).filter((name) => name.endsWith(".json")),
  ).toHaveLength(1);
});

test("pre-commit failure has no backend effect and the next request can admit normally", async () => {
  const { config, request, resultsFor } = await fixture();
  const authority = new FaultAuthority(config.stateRoot);
  let starts = 0;

  const service = await open(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: {
      start: async () => {
        starts++;

        return successful;
      },
      recover: async () => uncertain,
    },
  });

  authority.failBeforeCommit = true;
  await expect(service.start(request)).rejects.toThrow("Before commit");
  expect(starts).toBe(0);
  expect(await service.lookup(request)).toEqual({ kind: "none" });
  await service.start(request);
  await service.drain();
  expect(starts).toBe(1);
});

test("shutdown ends unresolved admission before lock release and a successor only recovers the old admission", async () => {
  const { config, request, resultsFor } = await fixture();
  const authority = new FaultAuthority(config.stateRoot);
  let starts = 0;

  const backend = {
    start: async () => {
      starts++;

      return successful;
    },
    recover: async () => uncertain,
  };

  const first = await open(config, {
    authority,
    resultsFor,
    artifactReader,
    backend,
    close: () => authority.close(),
  });

  authority.drop = true;
  const pending = first.start(request).catch(() => undefined);
  await eventually(() => authority.drops === 1);
  await first.close();
  await pending;
  await expect(first.start(request)).rejects.toThrow("stopping");
  const successor = new FilesystemAuthority(config.stateRoot);
  let recoveries = 0;

  const second = await open(config, {
    authority: successor,
    resultsFor,
    artifactReader,
    backend: {
      start: backend.start,
      recover: async () => {
        recoveries++;

        return uncertain;
      },
    },
  });

  await second.drain();
  expect(await second.start(request)).toEqual({ kind: "finished", result: uncertain });
  expect(starts).toBe(0);
  expect(recoveries).toBe(1);
});

test("ambiguous admission resolved to another admitting session recovers without a start", async () => {
  const { config, request, resultsFor } = await fixture();

  class OlderAdmission extends FilesystemAuthority {
    override async admit(input: AuthorityInput<"admit">) {
      const reply = await super.admit(input);

      if (reply.kind === "created") {
        await writeFile(
          join(config.stateRoot, "receipts", `${input.plan.id}.json`),
          JSON.stringify({ ...reply.record, session: { epoch: 1, nonce: "older-session" } }),
        );
        throw new Error("Lost reply to older admitting session");
      }

      return reply;
    }
  }

  const authority = new OlderAdmission(config.stateRoot);
  let starts = 0;
  let recovered = 0;

  const service = await open(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: {
      start: async () => {
        starts++;

        return successful;
      },
      recover: async () => {
        recovered++;

        return uncertain;
      },
    },
  });

  await service.start(request);
  await service.drain();
  expect(starts).toBe(0);
  expect(recovered).toBe(1);
  expect(await service.lookup(request)).toEqual({ kind: "finished", result: uncertain });
});
