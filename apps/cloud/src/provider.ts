import { Effect } from "effect";
import {
  decodeBoundary,
  type SandboxArtifactRead,
  type SandboxArtifactRequest,
  type SandboxAttemptRequest,
  sandboxArtifactSchema,
  sandboxErrorSchema,
  sandboxReceiptSchema,
} from "../../../packages/loopy/src/contract/index.js";
import type { ExecutionKey, ExecutionSpec } from "../../../packages/loopy/src/core/index.js";
import {
  type DurableExecutionProvider,
  DurableProviderError,
} from "../../../packages/loopy/src/host/index.js";
import type { R2ArtifactRegistry } from "./artifacts.js";
import { localEndpoint } from "./environment.js";
import { type BodyLimitError, readBoundedText } from "./http.js";
import type { CloudProtocolError } from "./operation.js";
import { CloudError, decodeProtocol, platform } from "./operation.js";

export class SandboxProvider implements DurableExecutionProvider {
  private readonly base: URL;
  constructor(
    private readonly options: {
      url: string;
      token: string;
      workspace: string;
      artifacts: Pick<R2ArtifactRegistry, "getBundle">;
    },
  ) {
    this.base = localEndpoint(options.url);
  }
  private request(url: URL, body?: SandboxAttemptRequest) {
    return Effect.gen({ self: this }, function* () {
      const response = yield* platform("sandbox request", (signal) =>
        fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        }),
      );

      if (!response.ok) {
        const body = response.body;

        if (body) {
          yield* platform("cancel sandbox response", () => body.cancel());
        }

        return yield* Effect.fail(
          new CloudError({
            operation: "sandbox request",
            cause: `Sandbox returned HTTP ${response.status}. Restore the local provider before resuming.`,
          }),
        );
      }

      const text = yield* readBoundedText(response, 4 * 1024 * 1024);

      return yield* decodeProtocol("receipt", () =>
        decodeBoundary(sandboxReceiptSchema)(JSON.parse(text)),
      );
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
        (cause) =>
          new DurableProviderError({
            operation: "lookup",
            reason:
              cause._tag === "BodyLimitError" || cause._tag === "CloudProtocolError"
                ? "protocol"
                : "transport",
            message:
              "Sandbox lookup failed. Reconcile the same attempt after restoring the provider.",
            cause,
          }),
      ),
    );
  }
  artifact(
    request: SandboxArtifactRequest,
  ): Effect.Effect<SandboxArtifactRead, CloudError | BodyLimitError | CloudProtocolError> {
    return Effect.gen({ self: this }, function* () {
      const url = new URL("/artifacts", this.base);
      url.searchParams.set("workspace", this.options.workspace);
      url.searchParams.set("key", JSON.stringify(request.executionKey));
      url.searchParams.set("attempt", String(request.attempt));
      url.searchParams.set("path", request.path);

      const response = yield* platform("sandbox artifact", (signal) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${this.options.token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        }),
      );

      const text = yield* readBoundedText(response, 2 * 1024 * 1024);
      const body: unknown = yield* decodeProtocol("artifact", () => JSON.parse(text));

      if (!response.ok) {
        if (![400, 404, 409, 413].includes(response.status)) {
          return yield* Effect.fail(
            new CloudError({
              operation: "sandbox artifact",
              cause: `Sandbox artifact request returned HTTP ${response.status}.`,
            }),
          );
        }

        const { error } = yield* decodeProtocol("artifact", () =>
          decodeBoundary(sandboxErrorSchema)(body),
        );

        return { kind: "error", error };
      }

      return {
        kind: "artifact",
        artifact: yield* decodeProtocol("artifact", () =>
          decodeBoundary(sandboxArtifactSchema)(body),
        ),
      };
    });
  }
  start(executionKey: ExecutionKey, attempt: number, spec: ExecutionSpec) {
    return Effect.gen({ self: this }, function* () {
      const hashes =
        spec.kind === "code" ? [spec.bundleHash] : spec.parse ? [spec.parse.bundleHash] : [];

      const bundles = yield* Effect.forEach(hashes, (hash) =>
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
        (cause) =>
          new DurableProviderError({
            operation: "start",
            reason:
              cause._tag === "BodyLimitError" || cause._tag === "CloudProtocolError"
                ? "protocol"
                : "transport",
            message: "Sandbox start failed. Reconcile the same attempt before dispatching again.",
            cause,
          }),
      ),
    );
  }
}
