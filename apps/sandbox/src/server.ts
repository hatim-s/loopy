import { timingSafeEqual } from "node:crypto";
import {
  SANDBOX_MAX_REQUEST_BYTES,
  type SandboxError,
  sandboxArtifactRequestSchema,
  sandboxAttemptIdentitySchema,
  sandboxAttemptRequestSchema,
} from "../../../packages/loopy/src/contract/index.js";
import { InvalidAttempt } from "./admission.js";
import { ArtifactError } from "./artifact-error.js";
import type { AttemptDependenciesFactory } from "./attempt-dependencies.js";
import { AttemptConflict, Attempts } from "./attempts.js";
import { type SandboxConfig, sandboxConfigSchema } from "./config.js";
import { filesystemDependencies } from "./filesystem.js";

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

// BOUNDARY: Only known exception classes become public HTTP errors.
function requestError(cause: unknown) {
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
        const parsed = sandboxAttemptRequestSchema.safeParse(await readBody(request));

        if (!parsed.success) {
          return error(
            "invalid_request",
            "Request does not match the sandbox attempt schema.",
            400,
          );
        }

        return Response.json(await attempts.start(parsed.data), { status: 202 });
      }

      if (request.method === "GET" && url.pathname === "/artifacts") {
        const parsed = sandboxArtifactRequestSchema.safeParse({
          workspace: url.searchParams.get("workspace"),
          executionKey: JSON.parse(url.searchParams.get("key") ?? "null"),
          attempt: Number(url.searchParams.get("attempt")),
          path: url.searchParams.get("path"),
        });

        if (!parsed.success) {
          return error(
            "invalid_request",
            "Supply an attempt identity and a relative artifact file path.",
            400,
          );
        }

        return Response.json(await attempts.artifact(parsed.data));
      }

      if (request.method === "GET" && url.pathname === "/attempts") {
        const parsed = sandboxAttemptIdentitySchema.safeParse({
          workspace: url.searchParams.get("workspace"),
          executionKey: JSON.parse(url.searchParams.get("key") ?? "null"),
          attempt: Number(url.searchParams.get("attempt")),
        });

        if (!parsed.success) {
          return error(
            "invalid_request",
            "Supply workspace, JSON execution key and positive attempt.",
            400,
          );
        }

        return Response.json(await attempts.lookup(parsed.data));
      }

      return error("not_found", "Sandbox route was not found.", 404);
    } catch (cause) {
      return requestError(cause);
    }
  };
}

export async function startSandbox(
  input: SandboxConfig,
  createDependencies?: AttemptDependenciesFactory,
) {
  const config = sandboxConfigSchema.parse(input);

  const attempts = await Attempts.open(
    config,
    createDependencies ?? filesystemDependencies(config),
  );

  try {
    const server = Bun.serve({
      hostname: config.hostname,
      port: config.port,
      maxRequestBodySize: SANDBOX_MAX_REQUEST_BYTES,
      fetch: attemptHandler(attempts, config.token),
    });

    return {
      server,
      attempts,
      close: async () => {
        const stopped = server.stop(true);
        await attempts.close();
        await stopped;
      },
    };
  } catch (cause) {
    await attempts.close();
    throw cause;
  }
}
