import type { R2Bucket } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { CloudError, platform } from "./operation.js";

export const ARTIFACT_LIMITS = {
  definitions: 1000,
  requestBytes: 24 * 1024 * 1024,
  graphBytes: 1024 * 1024,
  bundleBytes: 8 * 1024 * 1024,
  totalBundleBytes: 16 * 1024 * 1024,
  sourceBytes: 512 * 1024,
  listBytes: 32 * 1024 * 1024,
  // Reserve space for SQLite record headers below workerd's 2 MiB row limit.
  metadataRowBytes: 2 * 1024 * 1024 - 1024,
} as const;

export class ArtifactStorage {
  private readonly prefix: string;

  constructor(
    private readonly bucket: Pick<R2Bucket, "get" | "put">,
    workspace: string,
  ) {
    if (workspace.length === 0 || workspace.length > 512) {
      throw new Error("Workspace identity must contain between 1 and 512 characters.");
    }

    this.prefix = `workspaces/${encodeURIComponent(workspace)}/`;
  }

  put(key: string, bytes: string | Uint8Array) {
    return Effect.gen({ self: this }, function* () {
      yield* platform("publish immutable bytes", () =>
        this.bucket.put(this.prefix + key, bytes, { onlyIf: { etagDoesNotMatch: "*" } }),
      );
    });
  }

  read(key: string, limit: number) {
    return Effect.gen({ self: this }, function* () {
      // The range bounds the response even before inspecting R2's object size.
      const object = yield* platform("read immutable bytes", () =>
        this.bucket.get(this.prefix + key, {
          range: { offset: 0, length: limit + 1 },
        }),
      );

      if (!object) {
        return null;
      }

      if (object.size > limit) {
        yield* platform("cancel artifact read", () => object.body.cancel());

        return yield* Effect.fail(
          new CloudError({
            operation: "read artifact",
            cause: `Artifact exceeds its ${limit} byte limit.`,
          }),
        );
      }

      const bytes = new Uint8Array(
        yield* platform("read artifact bytes", () => object.arrayBuffer()),
      );

      if (bytes.byteLength > limit) {
        return yield* Effect.fail(
          new CloudError({
            operation: "read artifact",
            cause: `Artifact exceeds its ${limit} byte limit.`,
          }),
        );
      }

      return bytes;
    });
  }
}

export function hashKey(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Invalid artifact hash. Save the loopy again.");
  }

  return hash;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }

  return btoa(binary);
}
