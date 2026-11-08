import { graphView } from "@loopy/contract";
import { Clock, Effect } from "effect";
import { ServiceError } from "./error";
import type { ServiceOptions } from "./registry";

export const runNotFound = (id: string) =>
  new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);

// Effect's Clock is the time source the store and host read too, so one request stamps one timeline.
const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

/** Shared by every operation group so one request sees one clock and one not-found rule. */
export function makeServiceContext(options: ServiceOptions) {
  const found = <A, E>(id: string, lookup: Effect.Effect<A | null | undefined, E>) =>
    Effect.flatMap(lookup, (run) =>
      run === null || run === undefined ? Effect.fail(runNotFound(id)) : Effect.succeed(run),
    );

  const requireRun = Effect.fn("context.requireRun")(function* (id: string) {
    return yield* found(id, options.store.getRun(id));
  });

  const requireRunReference = Effect.fn("context.requireRunReference")(function* (id: string) {
    return yield* found(id, options.store.runReference(id));
  });

  const runGraph = Effect.fn("context.runGraph")(function* (id: string) {
    const run = yield* requireRunReference(id);

    return {
      revision: run.revision,
      graph: graphView(yield* (yield* options.registry(run.workspace)).revisionGraph(run.revision)),
    };
  });

  return { ...options, now, requireRun, requireRunReference, runGraph };
}

export type ServiceContext = ReturnType<typeof makeServiceContext>;
