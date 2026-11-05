import { Effect } from "effect";
import { routes } from "../../contract/index.js";
import { executionKeyString, outputBytes } from "../../core/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export function runInspect(context: CliContext) {
  return Effect.gen(function* () {
    const id = yield* requireTarget(context, "Run ID");

    const snapshot = yield* request(
      context,
      `/runs/${encodeURIComponent(id)}`,
      routes.run.response,
    );

    printJson({
      ...snapshot,
      nodeRuns: snapshot.nodeRuns.map((node) => ({
        ...node,
        executionKey: executionKeyString(node.key),
        finishedAt: "endedAt" in node ? node.endedAt : null,
        outputSizeBytes: node.status === "succeeded" ? outputBytes(node.output) : null,
      })),
    });
  });
}
