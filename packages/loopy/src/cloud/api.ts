import type { Json } from "../core/model.js";
import type { ProtocolError, RunRequest } from "../protocol/index.js";
import { assertJson } from "../runtime/values.js";
import {
  type Authenticator,
  ControlError,
  type HostedControl,
  type VerifiedPrincipal,
} from "./control.js";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function parseAdmission(request: Request, maxBodyBytes: number): Promise<RunRequest> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new ControlError(400, "invalid-input", "JSON body required");
  const reader = request.body?.getReader();
  if (!reader) throw new ControlError(400, "invalid-input", "Request body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new ControlError(413, "invalid-input", "Request body too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ControlError(400, "invalid-input", "Invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ControlError(400, "invalid-input", "Run request must be an object");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["versionId", "idempotencyKey", "input"].includes(key)) ||
    typeof record.versionId !== "string" ||
    !record.versionId ||
    record.versionId.length > 200 ||
    typeof record.idempotencyKey !== "string" ||
    !record.idempotencyKey ||
    record.idempotencyKey.length > 200 ||
    !("input" in record)
  )
    throw new ControlError(400, "invalid-input", "Invalid run request");
  try {
    assertJson(record.input);
  } catch {
    throw new ControlError(400, "invalid-input", "Input must be JSON");
  }
  return {
    versionId: record.versionId,
    idempotencyKey: record.idempotencyKey,
    input: record.input as Json,
  };
}

/** Fetch handler for Worker or any host implementing Request/Response. */
export function createControlHandler(
  control: HostedControl,
  authenticate: Authenticator,
  options: { maxBodyBytes?: number } = {},
): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? 262_144;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("Invalid body limit");
  return async (request) => {
    try {
      let principal: VerifiedPrincipal | undefined;
      try {
        principal = await authenticate(request);
      } catch {}
      if (!principal || !principal.subject || !principal.tenantId)
        throw new ControlError(401, "unauthorized", "Authentication required");
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/capabilities")
        return json({
          ...control.capabilities,
          operations: control.capabilities.operations.filter((operation) =>
            principal.operations.includes(operation),
          ),
        });
      if (request.method === "POST" && path === "/runs") {
        const result = await control.admit(principal, await parseAdmission(request, maxBodyBytes));
        return json(result, result.state === "created" ? 201 : 200);
      }
      const match = /^\/runs\/([^/]+)(\/cancel)?$/.exec(path);
      if (match) {
        let runId: string;
        try {
          runId = decodeURIComponent(match[1] ?? "");
        } catch {
          throw new ControlError(400, "invalid-input", "Invalid run identifier");
        }
        if (!runId || runId.length > 200)
          throw new ControlError(400, "invalid-input", "Invalid run identifier");
        if (request.method === "GET" && !match[2])
          return json(await control.inspect(principal, runId));
        if (request.method === "POST" && match[2]) {
          await control.cancel(principal, runId);
          return json({ state: "requested" }, 202);
        }
      }
      throw new ControlError(404, "not-found", "Endpoint not found");
    } catch (error) {
      if (error instanceof ControlError)
        return json(
          { code: error.code, message: error.message } satisfies ProtocolError,
          error.status,
        );
      return json(
        { code: "unsupported", message: "Control service unavailable" } satisfies ProtocolError,
        503,
      );
    }
  };
}
