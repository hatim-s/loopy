import { expect, test } from "bun:test";
import type { ExecutionResult } from "@loopy/contract";
import type { AuthorityInput } from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem/authority";
import { failure } from "../../../apps/sandbox/src/operations";
import {
  artifactReader,
  authorityFixture,
  successful,
  uncertain,
} from "./fixtures/sandbox-authority";
import { openAttemptsWith, run } from "./fixtures/sandbox-run";

class DelayedCommit extends FilesystemAuthority {
  private pending: AuthorityInput<"admit"> | null = null;
  override admit(input: AuthorityInput<"admit">) {
    const baseadmit = super.admit.bind(this);

    return Effect.gen({ self: this }, function* () {
      if (this.pending === null) {
        this.pending = input;

        return yield* Effect.fail(
          failure("fixture", new Error("Admit timed out before eventual commit")),
        );
      }

      return yield* baseadmit(input);
    });
  }
  commit() {
    const baseadmit = super.admit.bind(this);

    return Effect.gen({ self: this }, function* () {
      if (!this.pending) {
        return yield* Effect.fail(failure("fixture", new Error("No delayed admission")));
      }

      return yield* baseadmit(this.pending);
    });
  }
}

for (const trigger of ["start", "lookup"] as const) {
  test(`delayed admission commit after absent resolving read starts once on later ${trigger}`, async () => {
    const { config, request, resultsFor } = await authorityFixture();
    const authority = new DelayedCommit(config.stateRoot);
    const completed = Promise.withResolvers<ExecutionResult>();
    let starts = 0;
    let recoveries = 0;

    const service = await openAttemptsWith(config, {
      authority,
      resultsFor,
      artifactReader,
      backend: {
        start: () =>
          Effect.gen(function* () {
            starts++;

            return yield* Effect.promise(() => completed.promise);
          }),
        recover: () =>
          Effect.gen(function* () {
            recoveries++;

            return uncertain;
          }),
      },
    });

    await expect(run(service.start(request))).rejects.toThrow("timed out before eventual commit");
    expect(starts).toBe(0);
    expect(await run(service.lookup(request))).toEqual({ kind: "none" });
    expect((await run(authority.commit())).kind).toBe("created");
    expect(await run(service[trigger](request))).toEqual({ kind: "started" });
    await run(service.start(request));
    expect(starts).toBe(1);
    expect(recoveries).toBe(0);
    completed.resolve(successful);
    await run(service.drain());
    expect(await run(service.lookup(request))).toEqual({ kind: "finished", result: successful });
  });
}

test("a failed admission releases its retained request at the plan deadline", async () => {
  const { config, request, resultsFor } = await authorityFixture();
  config.maxTimeoutMs = 50;
  const authority = new DelayedCommit(config.stateRoot);
  let starts = 0;
  let recoveries = 0;

  const service = await openAttemptsWith(config, {
    authority,
    resultsFor,
    artifactReader,
    backend: {
      start: () =>
        Effect.sync(() => {
          starts++;

          return successful;
        }),
      recover: () =>
        Effect.sync(() => {
          recoveries++;

          return uncertain;
        }),
    },
  });

  // The eviction fiber forks from the start call, so start, adjust and lookup share one clock.
  await run(
    Effect.gen(function* () {
      const failed = yield* Effect.flip(service.start(request));
      expect(failed.message).toContain("timed out before eventual commit");
      yield* TestClock.adjust(config.maxTimeoutMs);
      expect((yield* authority.commit()).kind).toBe("created");
      expect(yield* service.lookup(request)).toEqual({ kind: "started" });
      yield* service.drain();
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(starts).toBe(0);
  expect(recoveries).toBe(1);
});
