import { routes } from "@loopy/contract";
import { executionKeyString, outputBytes } from "@loopy/core";
import { Effect } from "effect";
import { request } from "../client";
import { type CliContext, requireTarget } from "../context";
import { printJson } from "../output";

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
