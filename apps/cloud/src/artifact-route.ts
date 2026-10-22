import { sandboxArtifactRequestSchema } from "../../../packages/loopy/src/contract/index.js";
import type { Store } from "../../../packages/loopy/src/core/index.js";
import { errorResponse, json } from "../../../packages/loopy/src/service/index.js";
import type { SandboxProvider } from "./provider.js";

export async function artifactResponse(options: {
  url: URL;
  workspace: string;
  store: Store;
  provider: SandboxProvider;
}): Promise<Response> {
  const { url, workspace, store, provider } = options;
  let key: unknown;

  try {
    key = JSON.parse(url.searchParams.get("key") ?? "null");
  } catch {
    return errorResponse("bad_request", "Supply a JSON execution key.");
  }

  const parsed = sandboxArtifactRequestSchema.safeParse({
    workspace,
    executionKey: key,
    attempt: Number(url.searchParams.get("attempt")),
    path: url.searchParams.get("path"),
  });

  if (!parsed.success) {
    return errorResponse(
      "bad_request",
      "Supply an execution key, positive attempt and relative file path.",
    );
  }

  const run = await store.getRun(parsed.data.executionKey.runId);

  if (!run || run.workspace !== workspace) {
    return errorResponse("not_found");
  }

  if (!["succeeded", "failed", "cancelled"].includes(run.status)) {
    return errorResponse(
      "conflict",
      "Wait for the run to finish before reading its workspace files.",
    );
  }

  const result = await provider.artifact(parsed.data);

  if (result.kind === "error") {
    const code =
      result.error.code === "not_found"
        ? "not_found"
        : result.error.code === "conflict"
          ? "conflict"
          : "bad_request";

    return errorResponse(code, result.error.message);
  }

  return json(result.artifact);
}
