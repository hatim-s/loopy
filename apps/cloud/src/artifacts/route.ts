import { decodeBoundary, type ErrorCode, isTerminalRun } from "@loopy/contract";
import { type SandboxErrorCode, sandboxArtifactRequestSchema } from "@loopy/contract/sandbox";
import { type Store, struct } from "@loopy/core";
import { errorResponse, json } from "@loopy/runtime/service";
import { Effect, Result, Schema } from "effect";
import { cloudSync } from "../operation";
import type { SandboxProvider } from "../provider";

const artifactQuerySchema = struct({
  ...sandboxArtifactRequestSchema.fields,
  executionKey: Schema.fromJsonString(sandboxArtifactRequestSchema.fields.executionKey),
});

const serviceCode = {
  invalid_request: "bad_request",
  output_limit: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  unauthorized: "internal",
  internal: "internal",
} as const satisfies Record<SandboxErrorCode, ErrorCode>;

export function artifactResponse(options: {
  url: URL;
  workspace: string;
  store: Store;
  provider: SandboxProvider;
}) {
  return Effect.gen(function* () {
    const { url, workspace, store, provider } = options;

    const parsed = yield* Effect.result(
      cloudSync("decode artifact request", () =>
        decodeBoundary(artifactQuerySchema)({
          workspace,
          executionKey: url.searchParams.get("key"),
          attempt: Number(url.searchParams.get("attempt")),
          path: url.searchParams.get("path"),
        }),
      ),
    );

    if (Result.isFailure(parsed)) {
      return errorResponse(
        "bad_request",
        "Supply a JSON execution key, positive attempt and relative file path.",
      );
    }

    const run = yield* store.getRun(parsed.success.executionKey.runId);

    if (!run || run.workspace !== workspace) {
      return errorResponse("not_found");
    }

    if (!isTerminalRun(run.status)) {
      return errorResponse(
        "conflict",
        "Wait for the run to finish before reading its workspace files.",
      );
    }

    const result = yield* provider.artifact(parsed.success);

    if (result.kind === "error") {
      return errorResponse(serviceCode[result.error.code], result.error.message);
    }

    return json(result.artifact);
  });
}
