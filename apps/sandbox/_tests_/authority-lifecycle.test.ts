import { expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionResult } from "@loopy/contract";
import type { AuthorityInput } from "@loopy/contract/sandbox";
import { Effect } from "effect";
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

class FaultAuthority extends FilesystemAuthority {
  drop = false;
  unavailable = false;
  failBeforeCommit = false;
  reads = 0;
  readonly dropped = Promise.withResolvers<void>();
  override read(input: AuthorityInput<"read">) {
    const baseread = super.read.bind(this);

    return Effect.gen({ self: this }, function* () {
      this.reads++;

      if (this.unavailable) {
        return yield* Effect.fail(failure("fixture", new Error("Authority read unavailable")));
      }

      return yield* baseread(input);
    });
  }
  override admit(input: AuthorityInput<"admit">) {
    const baseadmit = super.admit.bind(this);

    return Effect.gen({ self: this }, function* () {
      if (this.failBeforeCommit) {
        this.failBeforeCommit = false;

        return yield* Effect.fail(failure("fixture", new Error("Before commit")));
      }

      const reply = yield* baseadmit(input);

      if (this.drop) {
        this.drop = false;
        this.unavailable = true;
        this.dropped.resolve();

        return yield* Effect.fail(failure("fixture", new Error("Acknowledgement dropped")));
      }

      return reply;
    });
  }
}

test("lost admission acknowledgement and unavailable resolving reads retain one same-session start gate", async () => {
  const { config, request, resultsFor } = await authorityFixture();
  const authority = new FaultAuthority(config.stateRoot);
  const complete = Promise.withResolvers<ExecutionResult>();
  const counting = new CountingBackend(Effect.promise(() => complete.promise));

  const service = await openAttemptsWith(config, {
    authority,
    resultsFor,
    artifactReader,
    close: () => authority.close(),
    backend: counting,
  });

  authority.drop = true;
  const first = run(service.start(request));
  await authority.dropped.promise;
  const second = run(service.start(request));
  expect(counting.starts).toBe(0);
  authority.unavailable = false;
  expect(await first).toEqual({ kind: "started" });
  expect(await second).toEqual({ kind: "started" });
  expect(counting.starts).toBe(1);
  const reads = authority.reads;

  for (let index = 0; index < 20; index++) {
    expect(await run(service.lookup(request))).toEqual({ kind: "started" });
  }

  expect(authority.reads - reads).toBe(0);
  complete.resolve(successful);
  await run(service.drain());
  expect(await run(service.lookup(request))).toEqual({ kind: "finished", result: successful });
  expect(counting.starts).toBe(1);
  expect(counting.recoveries).toBe(0);
  expect(
    (await readdir(stateLayout(config.stateRoot).receipts)).filter((name) =>
      name.endsWith(".json"),
    ),
  ).toHaveLength(1);
});

test("pre-commit failure has no backend effect and the next request can admit normally", async () => {
  const { config, request, resultsFor } = await authorityFixture();
  const authority = new FaultAuthority(config.stateRoot);
  const counting = new CountingBackend();

  const service = await openAttemptsWith(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: counting,
  });

  authority.failBeforeCommit = true;
  await expect(run(service.start(request))).rejects.toThrow("Before commit");
  expect(counting.starts).toBe(0);
  expect(await run(service.lookup(request))).toEqual({ kind: "none" });
  await run(service.start(request));
  await run(service.drain());
  expect(counting.starts).toBe(1);
});

test("shutdown ends unresolved admission before lock release and a successor only recovers the old admission", async () => {
  const { config, request, resultsFor } = await authorityFixture();
  const authority = new FaultAuthority(config.stateRoot);
  const backend = new CountingBackend();

  const first = await openAttemptsWith(config, {
    authority,
    resultsFor,
    artifactReader,
    backend,
    close: () => authority.close(),
  });

  authority.drop = true;
  const pending = run(first.start(request)).catch(() => undefined);
  await authority.dropped.promise;
  await run(first.close());
  await pending;
  await expect(run(first.start(request))).rejects.toThrow("stopping");
  const successor = new FilesystemAuthority(config.stateRoot);
  const recovering = new CountingBackend();

  const second = await openAttemptsWith(config, {
    authority: successor,
    resultsFor,
    artifactReader,
    backend: recovering,
  });

  await run(second.drain());
  expect(await run(second.start(request))).toEqual({ kind: "finished", result: uncertain });
  expect(backend.starts + recovering.starts).toBe(0);
  expect(recovering.recoveries).toBe(1);
});

test("ambiguous admission resolved to another admitting session recovers without a start", async () => {
  const { config, request, resultsFor } = await authorityFixture();

  class OlderAdmission extends FilesystemAuthority {
    override admit(input: AuthorityInput<"admit">) {
      const baseadmit = super.admit.bind(this);

      return Effect.gen({ self: this }, function* () {
        const reply = yield* baseadmit(input);

        if (reply.kind === "created") {
          yield* Effect.promise(() =>
            writeFile(
              join(stateLayout(config.stateRoot).receipts, `${input.plan.id}.json`),
              JSON.stringify({ ...reply.record, session: { epoch: 1, nonce: "older-session" } }),
            ),
          );

          return yield* Effect.fail(
            failure("fixture", new Error("Lost reply to older admitting session")),
          );
        }

        return reply;
      });
    }
  }

  const authority = new OlderAdmission(config.stateRoot);
  const counting = new CountingBackend();

  const service = await openAttemptsWith(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: counting,
  });

  await run(service.start(request));
  await run(service.drain());
  expect(counting.starts).toBe(0);
  expect(counting.recoveries).toBe(1);
  expect(await run(service.lookup(request))).toEqual({ kind: "finished", result: uncertain });
});
