import type { R2Bucket } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { CloudError, platform } from "../operation";

export const ARTIFACT_LIMITS = {
  definitions: 1000,
  graphBytes: 1024 * 1024,
  bundleBytes: 8 * 1024 * 1024,
  totalBundleBytes: 16 * 1024 * 1024,
  sourceBytes: 512 * 1024,
  listBytes: 32 * 1024 * 1024,
  // Reserve space for SQLite record headers below workerd's 2 MiB row limit.
  metadataRowBytes: 2 * 1024 * 1024 - 1024,
} as const;

/** One key scheme for every immutable object this Worker stores in R2. */
export const r2Key = {
  workspace: (workspace: string) => `workspaces/${encodeURIComponent(workspace)}/`,
  graph: (hash: string) => `graphs/${hash}.json`,
  bundle: (hash: string) => `bundles/${hash}.js`,
  source: (slug: string, hash: string) => `sources/${slug}/${hash}.json`,
  results: (namespace: string, workspace: string) =>
    `receipts/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(workspace)}/results/`,
};

/** Write-once objects under one key prefix, read back within a byte limit. */
export class ImmutableBucket {
  constructor(
    private readonly bucket: Pick<R2Bucket, "get" | "put">,
    private readonly prefix: string,
  ) {}

  /** Resolves false when the key already held an object, which callers may need to verify. */
  put(key: string, bytes: string | Uint8Array) {
    return platform("publish immutable bytes", () =>
      this.bucket.put(this.prefix + key, bytes, { onlyIf: { etagDoesNotMatch: "*" } }),
    ).pipe(Effect.map((created) => created !== null));
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
        yield* platform("cancel immutable read", () => object.body.cancel());

        return yield* Effect.fail(
          new CloudError({
            operation: "read immutable bytes",
            cause: `Object exceeds its ${limit} byte limit.`,
          }),
        );
      }

      return new Uint8Array(yield* platform("read immutable bytes", () => object.arrayBuffer()));
    });
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }

  return btoa(binary);
}
