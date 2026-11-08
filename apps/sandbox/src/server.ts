import { timingSafeEqual } from "node:crypto";
import {
  SANDBOX_MAX_REQUEST_BYTES,
  type SandboxError,
  sandboxArtifactRequestSchema,
  sandboxAttemptIdentitySchema,
  sandboxAttemptRequestSchema,
} from "@loopy/contract";
import { struct } from "@loopy/contract/codec";
import { Cause, Effect, Result, Schema } from "effect";
import { DockerArtifacts } from "./artifacts";
import { Attempts } from "./attempt";
import type { AttemptDependenciesFactory } from "./attempt/dependencies";
import type { SandboxConfig } from "./config";
import { DockerBackend } from "./docker";
import { DockerClient } from "./docker/client";
import { filesystemStorage } from "./filesystem";
import { readBounded } from "./http-body";
import { checked, io, type SandboxFailure } from "./operations";
import {
  ExportCleanupError,
  type SandboxErrorCode,
  SandboxRequestError,
  statusFor,
} from "./request-error";
import { closeableScope } from "./scope";

function error(code: SandboxErrorCode, message: string, status: number = statusFor[code]) {
  return Response.json({ error: { code, message } } satisfies SandboxError, { status });
}

function authenticated(request: Request, token: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);

  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

const attemptBodySchema = Schema.fromJsonString(sandboxAttemptRequestSchema);

const identityQuerySchema = struct({
  ...sandboxAttemptIdentitySchema.fields,
  executionKey: Schema.fromJsonString(sandboxAttemptIdentitySchema.fields.executionKey),
});

const artifactQuerySchema = struct({
  ...identityQuerySchema.fields,
  path: sandboxArtifactRequestSchema.fields.path,
});

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

function identityQuery(url: URL) {
  return {
    workspace: url.searchParams.get("workspace"),
    executionKey: url.searchParams.get("key"),
    attempt: Number(url.searchParams.get("attempt")),
  };
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

  if (!authenticated(request, token)) {
    return error("unauthorized", "Supply the sandbox bearer token.");
  }

  if (route === "POST /attempts") {
    const body =
      request.body === null
        ? Buffer.alloc(0)
        : await readBounded(request.body, SANDBOX_MAX_REQUEST_BYTES);

    // The size limit keeps the request code and reports the HTTP 413 transport status.
    if (body === null) {
      return error("invalid_request", "Attempt request exceeds its byte limit.", 413);
    }

    return respond(
      decodeRequest(
        attemptBodySchema,
        "Request does not match the sandbox attempt schema.",
        body.toString("utf8"),
      ),
      (input) => attempts.start(input),
      202,
    );
  }

  if (route === "GET /artifacts") {
    return respond(
      decodeRequest(
        artifactQuerySchema,
        "Supply an attempt identity and a relative artifact file path.",
        { ...identityQuery(url), path: url.searchParams.get("path") },
      ),
      (input) => attempts.artifact(input),
    );
  }

  if (route === "GET /attempts") {
    return respond(
      decodeRequest(
        identityQuerySchema,
        "Supply workspace, JSON execution key and positive attempt.",
        identityQuery(url),
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

        return { server, attempts, close: () => Effect.uninterruptible(close) };
      }),
  );
}
