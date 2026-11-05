import { Effect } from "effect";
import { FixtureError, fixtureIO } from "./fixture-effect.js";

export interface WaitClient {
  pid: number;
  readonly exitCode: number | null;
  kill: () => void;
  exited: Promise<number>;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

export function withWaitClient<A, E, R, E2, R2>(
  acquire: Effect.Effect<WaitClient, E2, R2>,
  use: (client: WaitClient) => Effect.Effect<A, E, R>,
  options: { shutdownMs?: number } = {},
) {
  return Effect.acquireUseRelease(acquire, use, (client) =>
    fixtureIO("wait client shutdown", async () => {
      if (client.exitCode === null) {
        client.kill();
      }

      const timeout = Promise.withResolvers<never>();

      const timer = setTimeout(
        () =>
          timeout.reject(
            new FixtureError({
              operation: "wait client shutdown",
              cause: undefined,
              message:
                "Wait client shutdown did not finish. Reconcile the owned process and streams before retrying.",
            }),
          ),
        options.shutdownMs ?? 5000,
      );

      try {
        await Promise.race([
          Promise.all([client.exited, client.stdout, client.stderr]),
          timeout.promise,
        ]);
      } finally {
        clearTimeout(timer);
      }
    }).pipe(Effect.orDie),
  );
}
