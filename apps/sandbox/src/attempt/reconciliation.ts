import { Effect, Result } from "effect";
import { AttemptConflict } from "../admission";
import type { SandboxAttemptAuthority, SandboxFailure } from "../operations";
import type { Stopping } from "../stopping";

export function resolveAdmissionRead({
  authority,
  id,
  stopping,
  cause,
}: {
  authority: SandboxAttemptAuthority;
  id: string;
  stopping: Stopping;
  cause: SandboxFailure;
}) {
  return Effect.gen(function* () {
    let backoff = 100;

    while (!stopping.stopped) {
      const read = yield* authority.read(id).pipe(Effect.result);

      if (Result.isSuccess(read)) {
        if (read.success === null) {
          return yield* Effect.fail(cause);
        }

        return read.success;
      }

      yield* stopping.pause(backoff);
      backoff = Math.min(backoff * 2, 5000);
    }

    return yield* Effect.fail(new AttemptConflict("Sandbox service is stopping."));
  });
}
