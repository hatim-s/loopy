import {
  type SandboxArtifactRead,
  type SandboxArtifactRequest,
  type SandboxAttemptRequest,
  sandboxArtifactSchema,
  sandboxErrorSchema,
  sandboxReceiptSchema,
} from "../../../packages/loopy/src/contract/index.js";
import type { ExecutionKey, ExecutionSpec } from "../../../packages/loopy/src/core/index.js";
import type { DurableExecutionProvider } from "../../../packages/loopy/src/host/index.js";
import type { R2ArtifactRegistry } from "./artifacts.js";
import { localEndpoint } from "./environment.js";
import { readBoundedText } from "./http.js";

export class SandboxProvider implements DurableExecutionProvider {
  private readonly base: URL;
  constructor(
    private readonly options: {
      url: string;
      token: string;
      workspace: string;
      artifacts: R2ArtifactRegistry;
    },
  ) {
    this.base = localEndpoint(options.url);
  }

  private async request(url: URL, body?: SandboxAttemptRequest) {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Sandbox returned HTTP ${response.status}. Restore the local provider before resuming.`,
      );
    }

    const text = await readBoundedText(response, 4 * 1024 * 1024);

    return sandboxReceiptSchema.parse(JSON.parse(text));
  }

  lookup(key: ExecutionKey, attempt: number) {
    const url = new URL("/attempts", this.base);
    url.searchParams.set("workspace", this.options.workspace);
    url.searchParams.set("key", JSON.stringify(key));
    url.searchParams.set("attempt", String(attempt));

    return this.request(url);
  }

  async artifact(request: SandboxArtifactRequest): Promise<SandboxArtifactRead> {
    const url = new URL("/artifacts", this.base);
    url.searchParams.set("workspace", this.options.workspace);
    url.searchParams.set("key", JSON.stringify(request.executionKey));
    url.searchParams.set("attempt", String(request.attempt));
    url.searchParams.set("path", request.path);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      signal: AbortSignal.timeout(15_000),
    });

    const body: unknown = JSON.parse(await readBoundedText(response, 2 * 1024 * 1024));

    if (!response.ok) {
      const { error } = sandboxErrorSchema.parse(body);

      if (![400, 404, 409, 413].includes(response.status)) {
        throw new Error(`Sandbox artifact request returned HTTP ${response.status}.`);
      }

      return { kind: "error", error };
    }

    return { kind: "artifact", artifact: sandboxArtifactSchema.parse(body) };
  }

  async start(executionKey: ExecutionKey, attempt: number, spec: ExecutionSpec) {
    const hashes =
      spec.kind === "code" ? [spec.bundleHash] : spec.parse ? [spec.parse.bundleHash] : [];

    const bundles = await Promise.all(
      hashes.map(async (hash) => ({
        hash,
        bytes: await this.options.artifacts.getBundle(hash),
      })),
    );

    return this.request(new URL("/attempts", this.base), {
      workspace: this.options.workspace,
      executionKey,
      attempt,
      spec,
      bundles,
    });
  }
}
