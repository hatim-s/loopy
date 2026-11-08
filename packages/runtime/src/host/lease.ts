import type { OwnershipError, RunRecord, StorageError, Store } from "@loopy/core";
import { Data, Effect, type Exit } from "effect";

const LEASE_RELEASE_TIMEOUT_MS = 5000;

export class LeaseReleaseUnknown extends Data.TaggedError("LeaseReleaseUnknown")<{
  runId: string;
  primary: Exit.Exit<unknown, unknown>;
}> {}

export class LeaseReleaseFailed extends Data.TaggedError("LeaseReleaseFailed")<{
  runId: string;
  primary: Exit.Exit<unknown, unknown>;
  cause: StorageError | OwnershipError;
}> {}

/** Claims the run under a fresh token, runs use and always releases, bounded so a hung store cannot pin shutdown. */
export function withLease<A, E, R>(
  store: Pick<Store, "claim" | "release">,
  runId: string,
  use: (token: string, run: RunRecord) => Effect.Effect<A, E, R>,
) {
  return Effect.suspend(() => {
    const token = crypto.randomUUID();

    return Effect.acquireUseRelease(
      store.claim(runId, token),
      (run) => use(token, run),
      (lease, primary) =>
        store.release(lease.id, token).pipe(
          Effect.mapError((cause) => new LeaseReleaseFailed({ runId: lease.id, primary, cause })),
          Effect.interruptible,
          Effect.timeoutOrElse({
            duration: LEASE_RELEASE_TIMEOUT_MS,
            orElse: () => Effect.fail(new LeaseReleaseUnknown({ runId: lease.id, primary })),
          }),
        ),
    );
  });
}
