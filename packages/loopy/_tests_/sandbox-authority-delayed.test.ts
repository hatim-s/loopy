import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { FilesystemAuthority } from "../../../apps/sandbox/src/filesystem-authority.js";
import { failure } from "../../../apps/sandbox/src/operations.js";
import type { SandboxExecutionResult } from "../src/contract/index.js";
import type { AuthorityInput } from "../src/contract/sandbox-journal-rpc.js";
import { artifactReader, successful, uncertain } from "./fixtures/sandbox-authority.js";
import { cleanup, fixture, open } from "./fixtures/sandbox-authority-lifecycle.js";
import { run } from "./fixtures/sandbox-run.js";

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
