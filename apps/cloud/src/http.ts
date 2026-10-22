import { errorResponse } from "../../../packages/loopy/src/service/index.js";

export const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

export async function boundedRequest(request: Request): Promise<Request | Response> {
  if (!request.body) {
    return request;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) {
        break;
      }

      size += next.value.byteLength;

      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();

        return errorResponse("bad_request", "Request exceeds the 24 MiB cloud artifact limit.");
      }

      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

export function acceptsOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");

  return origin === null || origin === new URL(request.url).origin;
}

export async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) {
    throw new Error("Sandbox returned an empty receipt.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;

  try {
    while (true) {
      const part = await reader.read();

      if (part.done) {
        return text + decoder.decode();
      }

      size += part.value.byteLength;

      if (size > limit) {
        await reader.cancel();
        throw new Error("Sandbox receipt exceeds its byte limit.");
      }

      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
