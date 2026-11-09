import { decodeBoundary, receiptSchema } from "@loopy/contract";
import {
  type SandboxArtifactRead,
  type SandboxArtifactRequest,
  type SandboxAttemptRequest,
  sandboxArtifactSchema,
  sandboxErrorSchema,
  sandboxErrorStatus,
} from "@loopy/contract/sandbox";
import { type ExecutionKey, type ExecutionSpec, specBundles } from "@loopy/core";
import { type DurableExecutionProvider, DurableProviderError } from "@loopy/runtime/host";
import type { BodyLimitError, BodyReadError } from "@loopy/runtime/service";
import { Effect } from "effect";
import type { R2ArtifactRegistry } from "./artifacts";
import type { CloudConfig } from "./environment";
import { readBoundedText } from "./http";
import type { CloudProtocolError } from "./operation";
import { CloudError, decodeProtocol, platform } from "./operation";

export const SANDBOX_REQUEST_TIMEOUT_MS = 5000;

const SANDBOX_ARTIFACT_TIMEOUT_MS = 15_000;

export class SandboxProvider implements DurableExecutionProvider {
  private readonly base: URL;
  constructor(
    private readonly options: CloudConfig["sandbox"] & {
      workspace: string;
      artifacts: Pick<R2ArtifactRegistry, "getBundle">;
    },
  ) {
    this.base = options.url;
  }
  private send(url: URL, timeoutMs: number, body?: SandboxAttemptRequest) {
    return platform("sandbox request", (signal) =>
      fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      }),
    );
  }
  private request(url: URL, body?: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      const response = yield* this.send(url, SANDBOX_REQUEST_TIMEOUT_MS, body);
      const text = yield* readBoundedText(response, 4 * 1024 * 1024);

      if (!response.ok) {
        const { error } = yield* sandboxError(response, text);

        return yield* Effect.fail(
          new CloudError({
            operation: "sandbox request",
            cause: `Sandbox rejected the attempt request (${error.code}): ${error.message}`,
          }),
        );
      }

      return yield* decodeProtocol(() => decodeBoundary(receiptSchema)(JSON.parse(text)));
    });
  }
  lookup(key: ExecutionKey, attempt: number) {
    return Effect.gen({ self: this }, function* () {
      const url = new URL("/attempts", this.base);
      url.searchParams.set("workspace", this.options.workspace);
      url.searchParams.set("key", JSON.stringify(key));
      url.searchParams.set("attempt", String(attempt));

      return yield* this.request(url);
    }).pipe(
      Effect.mapError(
        providerError(
          "lookup",
          "Sandbox lookup failed. Reconcile the same attempt after restoring the provider.",
        ),
      ),
    );
  }
  artifact(
    request: SandboxArtifactRequest,
  ): Effect.Effect<
    SandboxArtifactRead,
    CloudError | BodyLimitError | BodyReadError | CloudProtocolError
  > {
    return Effect.gen({ self: this }, function* () {
      const url = new URL("/artifacts", this.base);
      url.searchParams.set("workspace", this.options.workspace);
      url.searchParams.set("key", JSON.stringify(request.executionKey));
      url.searchParams.set("attempt", String(request.attempt));
      url.searchParams.set("path", request.path);

      const response = yield* this.send(url, SANDBOX_ARTIFACT_TIMEOUT_MS);
      const text = yield* readBoundedText(response, 2 * 1024 * 1024);

      if (!response.ok) {
        const { error } = yield* sandboxError(response, text);

        // Credentials and sandbox faults belong to the provider, not to the reader's request.
        if (error.code === "unauthorized" || error.code === "internal") {
          return yield* Effect.fail(
            new CloudError({
              operation: "sandbox artifact",
              cause: `Sandbox artifact request failed (${error.code}): ${error.message}`,
            }),
          );
        }

        return { kind: "error", error };
      }

      return {
        kind: "artifact",
        artifact: yield* decodeProtocol(() =>
          decodeBoundary(sandboxArtifactSchema)(JSON.parse(text)),
        ),
      };
    });
  }
  start(executionKey: ExecutionKey, attempt: number, spec: ExecutionSpec) {
    return Effect.gen({ self: this }, function* () {
      const bundles = yield* Effect.forEach(specBundles(spec), (hash) =>
        this.options.artifacts.getBundle(hash).pipe(Effect.map((bytes) => ({ hash, bytes }))),
      );

      return yield* this.request(new URL("/attempts", this.base), {
        workspace: this.options.workspace,
        executionKey,
        attempt,
        spec,
        bundles,
      });
    }).pipe(
      Effect.mapError(
        providerError(
          "start",
          "Sandbox start failed. Reconcile the same attempt before dispatching again.",
        ),
      ),
    );
  }
}

/** Every non-ok sandbox response carries a coded error whose status the contract fixes. */
function sandboxError(response: Response, text: string) {
  return decodeProtocol(() => {
    const body = decodeBoundary(sandboxErrorSchema)(JSON.parse(text));

    if (sandboxErrorStatus[body.error.code] !== response.status) {
      throw new Error(`Sandbox answered ${body.error.code} with HTTP ${response.status}.`);
    }

    return body;
  });
}

function providerError(operation: "lookup" | "start", message: string) {
  return (cause: { readonly _tag: string }) =>
    new DurableProviderError({
      operation,
      reason:
        cause._tag === "BodyLimitError" || cause._tag === "CloudProtocolError"
          ? "protocol"
          : "transport",
      message,
      cause,
    });
}
