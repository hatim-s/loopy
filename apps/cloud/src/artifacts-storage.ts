import type { R2Bucket } from "@cloudflare/workers-types";

export const ARTIFACT_LIMITS = {
  definitions: 1000,
  requestBytes: 24 * 1024 * 1024,
  graphBytes: 1024 * 1024,
  bundleBytes: 8 * 1024 * 1024,
  totalBundleBytes: 16 * 1024 * 1024,
  sourceBytes: 512 * 1024,
  listBytes: 32 * 1024 * 1024,
} as const;

export class ArtifactStorage {
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    workspace: string,
  ) {
    if (workspace.length === 0 || workspace.length > 512) {
      throw new Error("Workspace identity must contain between 1 and 512 characters.");
    }

    this.prefix = `workspaces/${encodeURIComponent(workspace)}/`;
  }

  async put(key: string, bytes: string | Uint8Array): Promise<void> {
    await this.bucket.put(this.prefix + key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
  }

  async read(key: string, limit: number): Promise<Uint8Array | null> {
    // The range bounds the response even before inspecting R2's object size.
    const object = await this.bucket.get(this.prefix + key, {
      range: { offset: 0, length: limit + 1 },
    });

    if (!object) {
      return null;
    }

    if (object.size > limit) {
      await object.body.cancel();
      throw new Error(`Artifact exceeds its ${limit} byte limit.`);
    }

    const bytes = new Uint8Array(await object.arrayBuffer());

    if (bytes.byteLength > limit) {
      throw new Error(`Artifact exceeds its ${limit} byte limit.`);
    }

    return bytes;
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
