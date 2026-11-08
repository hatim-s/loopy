import { afterEach, expect, test } from "bun:test";
import type { SandboxExecutionResult } from "@loopy/contract";
import { Effect } from "effect";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem/authority";
import { failure } from "../../../apps/sandbox/src/operations";
import type { AuthorityInput } from "../../contract/src/sandbox-journal-rpc";
import { artifactReader, successful, uncertain } from "./fixtures/sandbox-authority";
import { cleanup, fixture, open } from "./fixtures/sandbox-authority-lifecycle";
import { run } from "./fixtures/sandbox-run";

afterEach(cleanup);

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
    const { config, request, resultsFor } = await fixture();
    const authority = new DelayedCommit(config.stateRoot);
    const completed = Promise.withResolvers<SandboxExecutionResult>();
    let starts = 0;
    let recoveries = 0;

    const service = await open(config, {
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
  const { config, request, resultsFor } = await fixture();
  config.maxTimeoutMs = 50;
  const authority = new DelayedCommit(config.stateRoot);
  let starts = 0;
  let recoveries = 0;

  const service = await open(config, {
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

  await expect(run(service.start(request))).rejects.toThrow("timed out before eventual commit");
  await Bun.sleep(100);
  expect((await run(authority.commit())).kind).toBe("created");
  expect(await run(service.lookup(request))).toEqual({ kind: "started" });
  await run(service.drain());
  expect(starts).toBe(0);
  expect(recoveries).toBe(1);
});
