import { type BodyLimitError, type BodyReadError, readBoundedBody } from "@loopy/runtime/http";
import { Effect } from "effect";
import { CloudError } from "./operation";

export const mebibytes = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;

export function acceptsOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");

  return origin === null || origin === new URL(request.url).origin;
}

export function readBoundedText(
  response: Response,
  limit: number,
): Effect.Effect<string, CloudError | BodyLimitError | BodyReadError> {
  if (!response.body) {
    return Effect.fail(
      new CloudError({ operation: "read body", cause: "Sandbox returned an empty response body." }),
    );
  }

  return readBoundedBody(response.body, limit).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );
}
