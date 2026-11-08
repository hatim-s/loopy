import { type ErrorCode, isTerminalRun } from "@loopy/contract";
import { cloudRoutes, type SandboxErrorCode } from "@loopy/contract/sandbox";
import type { Store } from "@loopy/core";
import { errorResponse, json } from "@loopy/runtime/service";
import { Effect, Result, Schema } from "effect";
import type { SandboxProvider } from "../provider";

const serviceCode = {
  invalid_request: "bad_request",
  too_large: "bad_request",
  output_limit: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  unauthorized: "internal",
  internal: "internal",
} as const satisfies Record<SandboxErrorCode, ErrorCode>;

// The workspace guard upstream may leave a matching `workspace` search value in place.
const decodeQuery = Schema.decodeUnknownResult(cloudRoutes.artifact.query);

export function artifactResponse(options: {
  url: URL;
  workspace: string;
  store: Store;
  provider: SandboxProvider;
}) {
  return Effect.gen(function* () {
    const { url, workspace, store, provider } = options;
    const parsed = decodeQuery(Object.fromEntries(url.searchParams));

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
