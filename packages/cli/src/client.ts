import {
  decodeRouteResponse,
  type ErrorCode,
  type Route,
  type RouteInput,
  routeRequest,
} from "@loopy/contract";
import { readDaemonFile } from "@loopy/runtime/local";
import { Data, Effect, Exit } from "effect";
import type { Context } from "./context";
import { daemonCommand } from "./entry";
import { CliError, cliSync } from "./errors";

type ClientContext = Pick<Context, "home" | "cwd">;

type Method = Route["method"];

const DISCOVERY_TIMEOUT_MS = 5000;

const DISCOVERY_POLL_MS = 50;

export class HttpError extends Data.TaggedError("HttpError")<{
  status: number;
  code: ErrorCode;
  message: string;
}> {}

export class TransportError extends Data.TaggedError("TransportError")<{
  operation: "fetch" | "decode";
  method: Method;
  cause: unknown;
}> {
  override get message() {
    const next =
      this.method === "GET"
        ? "Check that the daemon is running and retry."
        : `Inspect the daemon before retrying the ${this.method} request.`;

    return `Daemon HTTP ${this.operation} failed. ${next}`;
  }
}

const daemon = Effect.fn(function* (context: ClientContext) {
  const current = yield* cliSync(() => readDaemonFile(context.home));

  if (current) {
    return current;
  }

  return yield* Effect.acquireUseRelease(
    cliSync(() =>
      Bun.spawn(daemonCommand({ home: context.home, cwd: context.cwd, port: 0 }), {
        cwd: context.cwd,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    ),
    (child) =>
      Effect.gen(function* () {
        child.unref();

        for (let waited = 0; waited < DISCOVERY_TIMEOUT_MS; waited += DISCOVERY_POLL_MS) {
          const record = yield* cliSync(() => readDaemonFile(context.home));

          if (record) {
            // A concurrent command may have started the daemon that won discovery.
            if (record.pid !== child.pid) {
              child.kill();
            }

            return record;
          }

          yield* Effect.sleep(DISCOVERY_POLL_MS);
        }

        return yield* new CliError({
          message: `The daemon did not publish discovery within ${DISCOVERY_TIMEOUT_MS} ms. Run loopy daemon run to inspect the error.`,
        });
      }),
    (child, exit) => (Exit.isFailure(exit) ? Effect.sync(() => child.kill()) : Effect.void),
  );
});

/** Calls one contract route on the daemon, starting it first when no daemon is published. */
export const request = <R extends Route>(context: ClientContext, route: R, input: RouteInput<R>) =>
  Effect.gen(function* () {
    const record = yield* daemon(context);
    const { method, url, headers, body } = yield* cliSync(() => routeRequest(route, input));

    // Consume the body while fetch still owns its cancellation signal. Never retry mutations.
    const { status, text } = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`http://127.0.0.1:${record.port}${url}`, {
          method,
          headers: { ...headers, Authorization: `Bearer ${record.token}` },
          body,
          signal,
        });

        return { status: response.status, text: await response.text() };
      },
      catch: (cause) => new TransportError({ operation: "fetch", method, cause }),
    });

    const outcome = decodeRouteResponse(route, status, text);

    switch (outcome.kind) {
      case "ok": {
        return outcome.value;
      }

      case "error": {
        return yield* new HttpError({ status, ...outcome.error });
      }

      case "malformed": {
        return yield* new TransportError({ operation: "decode", method, cause: undefined });
      }
    }
  });
