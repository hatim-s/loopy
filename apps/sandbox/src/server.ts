import {
  SANDBOX_MAX_REQUEST_BYTES,
  type SandboxError,
  type SandboxErrorCode,
  sandboxArtifactQuerySchema,
  sandboxAttemptQuerySchema,
  sandboxAttemptRequestSchema,
  sandboxErrorStatus,
} from "@loopy/contract/sandbox";
import { bearerMatches, readBoundedBody } from "@loopy/runtime/http";
import { Cause, Effect, Result, Schema } from "effect";
import { DockerArtifacts } from "./artifacts";
import { Attempts } from "./attempt";
import type { AttemptDependenciesFactory } from "./attempt/dependencies";
import type { SandboxConfig } from "./config";
import { DockerBackend } from "./docker";
import { DockerClient } from "./docker/client";
import { filesystemStorage } from "./filesystem";
import { checked, io, type SandboxFailure } from "./operations";
import { ExportCleanupError, SandboxRequestError } from "./request-error";
import { closeableScope } from "./scope";

function error(code: SandboxErrorCode, message: string) {
  return Response.json({ error: { code, message } } satisfies SandboxError, {
    status: sandboxErrorStatus[code],
  });
}

const attemptBodySchema = Schema.fromJsonString(sandboxAttemptRequestSchema);

// BOUNDARY: HTTP request bodies and query parameters are checked against the sandbox wire schemas.
function decodeRequest<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  message: string,
  value: unknown,
) {
  const decoded = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(value);

  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(new SandboxRequestError("invalid_request", message));
}

function internalError() {
  return error("internal", "Sandbox operation failed. Inspect its durable state before retrying.");
}

function failureResponse(cause: Cause.Cause<SandboxFailure>) {
  const failures = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
  const defect = Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason);
  const [only] = failures;

  const known = defect
    ? undefined
    : (failures.find((failure) => failure instanceof ExportCleanupError) ??
      (failures.length === 1 && only instanceof SandboxRequestError ? only : undefined));

  return Effect.logError(cause).pipe(
    Effect.as(known ? error(known.code, known.message) : internalError()),
  );
}

// Invalid input is answered directly. Only failures of an accepted operation are logged.
function respond<I, A>(
  input: Effect.Effect<I, SandboxRequestError>,
  operation: (input: I) => Effect.Effect<A, SandboxFailure>,
  status = 200,
) {
  return Effect.runPromise(
    input.pipe(
      Effect.matchEffect({
        onFailure: (invalid) => Effect.succeed(error(invalid.code, invalid.message)),
        onSuccess: (value) =>
          operation(value).pipe(
            Effect.map((result) => Response.json(result, { status })),
            Effect.catchCause(failureResponse),
          ),
      }),
    ),
  );
}

async function handle(attempts: Attempts, token: string, request: Request) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /health") {
    return Response.json({ status: "ok" });
  }

  if (!bearerMatches(request.headers.get("authorization"), token)) {
    return error("unauthorized", "Supply the sandbox bearer token.");
  }

  if (route === "POST /attempts") {
    const body = await Effect.runPromise(
      readBoundedBody(request.body, SANDBOX_MAX_REQUEST_BYTES).pipe(
        Effect.catchTag("BodyLimitError", () => Effect.succeed(null)),
      ),
    );

    if (body === null) {
      return error(
        "too_large",
        `Attempt request exceeds ${SANDBOX_MAX_REQUEST_BYTES} bytes. Reduce its bundles or input.`,
      );
    }

    return respond(
      decodeRequest(
        attemptBodySchema,
        "Request does not match the sandbox attempt schema.",
        new TextDecoder().decode(body),
      ),
      (input) => attempts.start(input),
      202,
    );
  }

  if (route === "GET /artifacts") {
    return respond(
      decodeRequest(
        sandboxArtifactQuerySchema,
        "Supply an attempt identity and a relative artifact file path.",
        Object.fromEntries(url.searchParams),
      ),
      (input) => attempts.artifact(input),
    );
  }

  if (route === "GET /attempts") {
    return respond(
      decodeRequest(
        sandboxAttemptQuerySchema,
        "Supply workspace, JSON execution key and positive attempt.",
        Object.fromEntries(url.searchParams),
      ),
      (input) => attempts.lookup(input),
    );
  }

  return error("not_found", "Sandbox route was not found.");
}

export function attemptHandler(attempts: Attempts, token: string) {
  return (request: Request) => handle(attempts, token, request).catch(() => internalError());
}

function dockerDependencies(config: SandboxConfig): AttemptDependenciesFactory {
  return () =>
    Effect.sync(() => {
      const docker = new DockerClient(config);

      return {
        ...filesystemStorage(config.stateRoot),
        backend: new DockerBackend(config, docker),
        artifactReader: new DockerArtifacts(config, docker),
      };
    });
}

export function startSandbox(
  config: SandboxConfig,
  createDependencies?: AttemptDependenciesFactory,
) {
  return closeableScope(
    {
      operation: "server release",
      message: "Sandbox server release failed. Inspect durable state before restarting.",
    },
    (close) =>
      Effect.gen(function* () {
        const attempts = yield* Attempts.open(
          config,
          createDependencies ?? dockerDependencies(config),
        );

        const server = yield* Effect.acquireRelease(
          checked("HTTP server", () =>
            Bun.serve({
              hostname: config.hostname,
              port: config.port,
              // Bun answers a bare 413 above its own cap. Its 128 MiB default sits above any
              // request the contract can build, so the handler answers the coded limit error.
              fetch: attemptHandler(attempts, config.token),
            }),
          ),
          (server) =>
            Effect.gen(function* () {
              // Stop accepting requests before attempts close, then wait for the listener.
              const stopped = server.stop(true);
              yield* attempts.close();
              yield* io("HTTP stop", () => stopped);
            }).pipe(Effect.orDie),
        );

        return { server, attempts, close: () => Effect.uninterruptible(close) };
      }),
  );
}
