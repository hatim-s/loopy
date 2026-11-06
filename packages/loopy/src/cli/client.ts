import { resolve } from "node:path";
import { Data, Effect, Schema } from "effect";
import { boundaryOptions, errorBodySchema } from "../contract";
import { readDaemonFile } from "../local";
import type { CliContext } from "./context";
import { CliError, cliSync } from "./errors";

type ClientContext = Pick<CliContext, "home" | "cwd">;

export class HttpError extends Data.TaggedError("HttpError")<{
  status: number;
  code: typeof errorBodySchema.Type.error.code;
  message: string;
}> {}

export class TransportError extends Data.TaggedError("TransportError")<{
  operation: "fetch" | "decode";
  cause: unknown;
}> {
  override get message() {
    return `Daemon HTTP ${this.operation} failed. Inspect the daemon before retrying a mutation.`;
  }
}

const daemon = Effect.fn(function* (context: ClientContext) {
  const current = yield* cliSync(() => readDaemonFile(context.home));

  if (current) {
    return current;
  }

  const spawn = cliSync(() =>
    Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, import.meta.path.endsWith(".ts") ? "index.ts" : "index.js"),
        "--home",
        context.home,
        "--cwd",
        context.cwd,
        "daemon",
        "run",
        "--port",
        "0",
      ],
      { cwd: context.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    ),
  );

  let discovered = false;

  return yield* Effect.acquireUseRelease(
    spawn,
    (child) =>
      Effect.gen(function* () {
        child.unref();

        for (let attempt = 0; attempt < 100; attempt++) {
          const record = yield* cliSync(() => readDaemonFile(context.home));

          if (record) {
            // A concurrent command may have started the daemon that won discovery.
            if (record.pid !== child.pid) {
              child.kill();
            }

            discovered = true;

            return record;
          }

          yield* Effect.sleep(50);
        }

        return yield* Effect.fail(
          new CliError({
            message: "The daemon did not start. Run loopy daemon run to inspect the error.",
          }),
        );
      }),
    (child) =>
      Effect.sync(() => {
        if (!discovered) {
          child.kill();
        }
      }),
  );
});

export const request = <S extends Schema.Top & { readonly DecodingServices: never }>(
  context: ClientContext,
  path: string,
  schema: S,
  options: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: object } = { method: "GET" },
) =>
  Effect.gen(function* () {
    const record = yield* daemon(context);

    // Consume the body while fetch still owns its cancellation signal. Never retry mutations.
    const { ok, status, value } = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`http://127.0.0.1:${record.port}/api${path}`, {
          method: options.method,
          headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json" },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
        });

        const value: unknown = await response.json();

        return { ok: response.ok, status: response.status, value };
      },
      catch: (cause) => new TransportError({ operation: "fetch", cause }),
    });

    if (!ok) {
      const { error } = yield* Schema.decodeUnknownEffect(errorBodySchema)(
        value,
        boundaryOptions,
      ).pipe(Effect.mapError((cause) => new TransportError({ operation: "decode", cause })));

      return yield* Effect.fail(new HttpError({ status, ...error }));
    }

    return yield* Schema.decodeUnknownEffect(schema)(value, boundaryOptions).pipe(
      Effect.mapError((cause) => new TransportError({ operation: "decode", cause })),
    );
  });
