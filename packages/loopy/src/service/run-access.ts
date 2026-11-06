import { Effect } from "effect";
import { graphView } from "../contract";
import { ServiceError } from "./error";
import type { ServiceOptions } from "./registry";

export function makeRunAccess(options: ServiceOptions) {
  const requireRun = Effect.fn("run-access.requireRun")(function* (id: string) {
    const run = yield* options.store.getRun(id);

    if (!run) {
      return yield* Effect.fail(
        new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`),
      );
    }

    return run;
  });

  const runGraph = Effect.fn("run-access.runGraph")(function* (id: string) {
    const run = yield* requireRun(id);

    return {
      revision: run.revision,
      graph: graphView(yield* (yield* options.registry(run.workspace)).revisionGraph(run.revision)),
    };
  });

  return { requireRun, runGraph };
}
