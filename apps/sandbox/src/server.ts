import { timingSafeEqual } from "node:crypto";
import { Cause, Effect, Exit, Result, Schema, Scope } from "effect";
import {
  decodeBoundary,
  SANDBOX_MAX_REQUEST_BYTES,
  type SandboxArtifact,
  type SandboxError,
  type SandboxReceipt,
  sandboxArtifactRequestSchema,
  sandboxAttemptIdentitySchema,
  sandboxAttemptRequestSchema,
} from "../../../packages/loopy/src/contract/index.js";
import { InvalidAttempt } from "./admission.js";
import { ArtifactError, ExportCleanupError } from "./artifact-error.js";
import type { AttemptDependenciesFactory } from "./attempt-dependencies.js";
import { AttemptConflict, Attempts } from "./attempts.js";
import { type SandboxConfig, sandboxConfigSchema } from "./config.js";
import { filesystemDependencies } from "./filesystem.js";
import { checked, failure, io, type SandboxFailure } from "./operations.js";

class RequestTooLarge extends Error {}

async function readBody(request: Request) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  if (request.body === null) {
    throw new InvalidAttempt("Supply a JSON attempt request.");
  }

  const reader = request.body.getReader();

  while (true) {
    const { done, value: chunk } = await reader.read();

    if (done) {
      break;
    }

    bytes += chunk.byteLength;

    if (bytes > SANDBOX_MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestTooLarge();
    }

    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function error(code: SandboxError["error"]["code"], message: string, status: number) {
  return Response.json({ error: { code, message } } satisfies SandboxError, { status });
}

function authenticated(request: Request, token: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);

  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

// Only known failures become public HTTP errors.
function requestError(cause: unknown) {
  if (cause instanceof ExportCleanupError) {
    return error("conflict", cause.message, 409);
  }

  if (cause instanceof ArtifactError) {
    const status = {
      unauthorized: 401,
      invalid_request: 400,
      conflict: 409,
      not_found: 404,
      output_limit: 413,
      internal: 500,
    };

    return error(cause.code, cause.message, status[cause.code]);
  }

  if (cause instanceof AttemptConflict) {
    return error("conflict", cause.message, 409);
  }

  if (cause instanceof InvalidAttempt || cause instanceof SyntaxError) {
    return error(
      "invalid_request",
      "Supply valid JSON and matching required execution bundles.",
      400,
    );
  }

  if (cause instanceof RequestTooLarge) {
    return error("invalid_request", "Attempt request exceeds its byte limit.", 413);
  }

  return error(
    "internal",
    "Sandbox operation failed. Inspect its durable state before retrying.",
    500,
  );
}

function httpFailure(cause: Cause.Cause<SandboxFailure>) {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.logError(cause).pipe(Effect.andThen(Effect.failCause(cause)));
  }

  const failures = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
  const cleanup = failures.find((error) => error instanceof ExportCleanupError);

  const response = cleanup
    ? error("conflict", cleanup.message, 409)
    : failures.length === 1
      ? requestError(failures[0])
      : requestError(cause);

  return Effect.logError(cause).pipe(Effect.as(response));
}

function responseJson(value: SandboxReceipt | SandboxArtifact | Response, status = 200) {
  return value instanceof Response ? value : Response.json(value, { status });
}

export function attemptHandler(attempts: Attempts, token: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (!authenticated(request, token)) {
      return error("unauthorized", "Supply the sandbox bearer token.", 401);
    }

    try {
      if (request.method === "POST" && url.pathname === "/attempts") {
        const parsed = Schema.decodeUnknownResult(sandboxAttemptRequestSchema, {
          onExcessProperty: "error",
        })(await readBody(request));

        if (Result.isFailure(parsed)) {
          return error(
            "invalid_request",
            "Request does not match the sandbox attempt schema.",
            400,
          );
        }

        const response = await Effect.runPromise(
          attempts.start(parsed.success).pipe(Effect.catchCause(httpFailure)),
        );

        return responseJson(response, 202);
      }

      if (request.method === "GET" && url.pathname === "/artifacts") {
        const parsed = Schema.decodeUnknownResult(sandboxArtifactRequestSchema, {
          onExcessProperty: "error",
        })({
          workspace: url.searchParams.get("workspace"),
          executionKey: JSON.parse(url.searchParams.get("key") ?? "null"),
          attempt: Number(url.searchParams.get("attempt")),
          path: url.searchParams.get("path"),
        });

        if (Result.isFailure(parsed)) {
          return error(
            "invalid_request",
            "Supply an attempt identity and a relative artifact file path.",
            400,
          );
        }

        const response = await Effect.runPromise(
          attempts.artifact(parsed.success).pipe(Effect.catchCause(httpFailure)),
        );

        return responseJson(response);
      }

      if (request.method === "GET" && url.pathname === "/attempts") {
        const parsed = Schema.decodeUnknownResult(sandboxAttemptIdentitySchema, {
          onExcessProperty: "error",
        })({
          workspace: url.searchParams.get("workspace"),
          executionKey: JSON.parse(url.searchParams.get("key") ?? "null"),
          attempt: Number(url.searchParams.get("attempt")),
        });

        if (Result.isFailure(parsed)) {
          return error(
            "invalid_request",
            "Supply workspace, JSON execution key and positive attempt.",
            400,
          );
        }

        const response = await Effect.runPromise(
          attempts.lookup(parsed.success).pipe(Effect.catchCause(httpFailure)),
        );

        return responseJson(response);
      }

      return error("not_found", "Sandbox route was not found.", 404);
    } catch (cause) {
      return requestError(cause);
    }
  };
}

export function startSandbox(
  input: SandboxConfig,
  createDependencies?: AttemptDependenciesFactory,
) {
  return Effect.gen(function* () {
    const resources = yield* Scope.make();

    const closeResources = yield* Effect.cached(
      Scope.close(resources, Exit.void).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            failure(
              "server release",
              cause,
              "Sandbox server release failed. Inspect durable state before restarting.",
            ),
          ),
        ),
        Effect.uninterruptible,
      ),
    );

    yield* Effect.addFinalizer(() => Effect.uninterruptible(closeResources).pipe(Effect.orDie));

    return yield* Effect.gen(function* () {
      const config = yield* checked("configuration", () =>
        decodeBoundary(sandboxConfigSchema)(input),
      );

      const attempts = yield* Attempts.open(
        config,
        createDependencies ?? filesystemDependencies(config),
      );

      const server = yield* Effect.acquireRelease(
        checked("HTTP server", () =>
          Bun.serve({
            hostname: config.hostname,
            port: config.port,
            maxRequestBodySize: SANDBOX_MAX_REQUEST_BYTES,
            fetch: attemptHandler(attempts, config.token),
          }),
        ),
        (server) =>
          Effect.gen(function* () {
            const stopped = yield* Effect.sync(() => server.stop(true));
            yield* attempts.close();
            yield* io("HTTP stop", () => stopped);
          }).pipe(Effect.orDie),
      );

      return {
        server,
        attempts,
        close: () => Effect.uninterruptible(closeResources),
      };
    }).pipe(
      Effect.provideService(Scope.Scope, resources),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Effect.uninterruptible(closeResources).pipe(Effect.orDie)
          : Effect.void,
      ),
    );
  });
}
