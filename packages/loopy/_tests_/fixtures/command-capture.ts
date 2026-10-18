import type { ExecutionResult, ExecutionSpec, RunOutcome } from "../../src/core/index.js";
import { initialState, step } from "../../src/engine/index.js";
import { renderCommand } from "../../src/local/execution-host.js";
import { loopy } from "../../src/sdk/graph/index.js";

type Capture = {
  executor: { calls: { program: string; args: string[] }[] };
  specs: Extract<ExecutionSpec, { kind: "command" }>[];
  result: RunOutcome;
};

export function capture(run: () => void): Capture {
  const specs: Extract<ExecutionSpec, { kind: "command" }>[] = [];
  const calls: { program: string; args: string[] }[] = [];

  try {
    const graph = loopy("capture", {
      input: {},
      run: () => {
        run();

        return null;
      },
    }).graph;

    for (const node of graph.nodes) {
      if (node.kind === "command" && node.parse) {
        node.parse.bundleHash = "a".repeat(64);
      }
    }

    let transition = step(graph, initialState("capture", {}), {
      kind: "run_started",
      at: "2026-10-18T00:00:00.000Z",
    });

    while (transition.state.phase.kind !== "finished") {
      const dispatch = transition.effects.find((effect) => effect.kind === "dispatch");

      if (dispatch?.kind !== "dispatch" || dispatch.spec.kind !== "command") {
        throw new Error("Expected command dispatch");
      }

      specs.push(dispatch.spec);
      const [program, ...args] = renderCommand(dispatch.spec);
      calls.push({ program: program ?? "", args });

      const result: Extract<ExecutionResult, { kind: "succeeded" }> = {
        kind: "succeeded",
        output: { stdout: "", stderr: "", exitCode: 0 },
        logs: [],
      };

      transition = step(graph, transition.state, {
        kind: "execution_completed",
        executionKey: dispatch.executionKey,
        attempt: dispatch.attempt,
        result,
        at: "2026-10-18T00:00:00.000Z",
      });
    }

    return { executor: { calls }, specs, result: transition.state.phase.outcome };
  } catch (cause) {
    return {
      executor: { calls },
      specs,
      result: { status: "failed", error: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}
