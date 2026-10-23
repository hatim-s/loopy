import type { R2Bucket } from "@cloudflare/workers-types";
import {
  type ImmutableResults,
  type ResultRef,
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxExecutionResult,
  sandboxExecutionResultSchema,
} from "../../../packages/loopy/src/contract/index.js";
import { canonicalJson } from "../../../packages/loopy/src/core/index.js";
import { receiptHash } from "./receipts-identity.js";

export class R2ImmutableResults implements ImmutableResults {
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    namespace: string,
    workspace: string,
  ) {
    this.prefix = `receipts/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(workspace)}/results/`;
  }

  async put(result: SandboxExecutionResult): Promise<ResultRef> {
    let bytes = new TextEncoder().encode(canonicalJson(result));

    if (bytes.byteLength > SANDBOX_MAX_CAPTURE_BYTES) {
      bytes = new TextEncoder().encode(
        canonicalJson({
          kind: "failed",
          error: { code: "output_limit", message: "Serialized attempt result exceeds 2 MiB." },
          exitCode: null,
          logs: [],
        }),
      );
    }

    const ref = { sha256: await receiptHash(bytes), size: bytes.byteLength };

    const created = await this.bucket.put(this.prefix + ref.sha256, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    });

    if (!created) {
      // An existing object must verify before its digest can be reused.
      await this.get(ref);
    }

    return ref;
  }

  async get(ref: ResultRef): Promise<SandboxExecutionResult> {
    const object = await this.bucket.get(this.prefix + ref.sha256, {
      range: { offset: 0, length: ref.size + 1 },
    });

    if (!object) {
      throw new Error("Immutable result is missing. Restore receipt storage before resuming.");
    }

    if (object.size !== ref.size || object.size > SANDBOX_MAX_CAPTURE_BYTES) {
      await object.body.cancel();
      throw new Error("Immutable result size does not match its receipt.");
    }

    const bytes = new Uint8Array(await object.arrayBuffer());

    if (bytes.byteLength !== ref.size || (await receiptHash(bytes)) !== ref.sha256) {
      throw new Error("Immutable result hash does not match its receipt.");
    }

    return sandboxExecutionResultSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  }
}
