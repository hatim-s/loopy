import { executionKeyString, routes } from "@loopy/contract";
import { assert, equal } from "../shared/assert";
import type { Journey } from "./client";

export async function execution(journey: Journey, runId: string, chooseYes: boolean) {
  const snapshot = await journey.wait(runId);
  assert(snapshot.run.status === "succeeded", "execution_run_did_not_succeed", {
    runId: runId,
    runStatus: snapshot.run.status,
    nodeStatuses: snapshot.nodeRuns.map(
      (node) => `${node.key.nodeId}:${node.status}:${node.attempt}`,
    ),
  });
  equal(
    snapshot.run.output,
    {
      selected: chooseYes ? "yes" : "no",
      mapped: [
        { doubled: 4, index: 0 },
        { doubled: 8, index: 1 },
        { doubled: 12, index: 2 },
      ],
      paired: {
        descriptor: { stdout: "fixture", stderr: "", exitCode: 0 },
        bundle: { greeting: "Hello fixture", uid: 1000 },
      },
      retried: { stdout: "retry-ok", stderr: "", exitCode: 0 },
    },
    "compiled_execution_output_mismatch",
  );
  const retryNode = snapshot.nodeRuns.find((node) => node.key.nodeId.endsWith(":firstfail"));
  assert(
    retryNode?.attempt === 2 && retryNode.status === "succeeded",
    "controlled_retry_did_not_use_two_attempts",
  );

  const retry = await journey.call(routes.execution, {
    params: { id: runId },
    query: { key: executionKeyString(retryNode.key) },
  });

  assert(
    retry.attempts.some(
      (node) => node.attempt === 1 && "error" in node && node.error.code === "exit",
    ),
    "first_exit_failure_attempt_missing",
  );
  const logs = await journey.call(routes.logs, { params: { id: runId }, query: { limit: 200 } });

  for (const message of [
    chooseYes ? "branch-yes" : "branch-no",
    "double-item",
    "bundle-greeting",
    "journey-finished",
  ]) {
    assert(
      logs.some((log) => log.message === message),
      "expected_execution_log_missing",
      { message, runId: runId },
    );
  }

  assert(
    !logs.some((log) => log.message === (chooseYes ? "branch-no" : "branch-yes")),
    "unselected_branch_executed",
  );

  return {
    runId: runId,
    status: snapshot.run.status,
    mapItems: 3,
    retryAttempts: retryNode.attempt,
    logCount: logs.length,
    sandboxUid: 1000,
  };
}
