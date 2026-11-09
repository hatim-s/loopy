import { nodeDetailEvent, type routes, serverEvent } from "@loopy/contract";
import type { Schema } from "effect";
import { Effect } from "effect";
import type { ServiceContext } from "./context";
import { requireDefinition } from "./definition";
import { ServiceError } from "./error";
import type { RunViews } from "./run-views";

type Query<K extends keyof typeof routes> = Schema.Schema.Type<(typeof routes)[K]["query"]>;

export function makeRunQueries(context: ServiceContext, runViews: RunViews) {
  const { store, requireRun, requireRunReference } = context;

  const present = <A, E>(lookup: Effect.Effect<A | undefined, E>) =>
    Effect.flatMap(lookup, (value) =>
      value === undefined ? Effect.fail(new ServiceError("not_found")) : Effect.succeed(value),
    );

  const runPayload = Effect.fn("queries.runPayload")(function* (id: string) {
    const run = yield* requireRun(id);

    return run.status === "succeeded"
      ? { input: run.input, output: run.output }
      : { input: run.input };
  });

  const logs = Effect.fn("queries.logs")(function* (id: string, query: Query<"logs">) {
    yield* requireRun(id);

    return yield* store.getLogs(id, query.after, query.limit);
  });

  const executions = Effect.fn("queries.executions")(function* (
    id: string,
    query: Query<"executions">,
  ) {
    yield* requireRunReference(id);

    return yield* store.nodePage(id, query);
  });

  const scopes = Effect.fn("queries.scopes")(function* (id: string, query: Query<"scopes">) {
    yield* requireRunReference(id);

    return yield* store.scopeCounts(id, query.parentScope);
  });

  const scopeItems = Effect.fn("queries.scopeItems")(function* (
    id: string,
    query: Query<"scopeItems">,
  ) {
    yield* requireRunReference(id);

    return yield* store.scopeItems(id, query);
  });

  const execution = Effect.fn("queries.execution")(function* (
    id: string,
    query: Query<"execution">,
  ) {
    yield* requireRunReference(id);

    return yield* present(store.execution(id, query.key, query.attemptsAfter));
  });

  const event = Effect.fn("queries.event")(function* (sequence: number) {
    const event = yield* present(store.eventDetail(sequence));

    if (event.entity === "node") {
      return nodeDetailEvent(event);
    }

    return serverEvent(
      event,
      yield* runViews.resolve(event.entity === "run" ? [event.record] : []),
    );
  });

  const runSource = Effect.fn("queries.runSource")(function* (id: string) {
    const run = yield* requireRunReference(id);

    return yield* (yield* context.registry(run.workspace)).revisionSource(run.slug, run.revision);
  });

  const loopySource = Effect.fn("queries.loopySource")(function* (slug: string, workspace: string) {
    const registry = yield* context.registry(workspace);
    const saved = yield* requireDefinition(registry, slug);

    return yield* registry.revisionSource(slug, saved.revision);
  });

  return {
    runGraph: context.runGraph,
    runPayload,
    logs,
    overview: (query: Query<"overview">) => store.overview(query),
    executions,
    scopes,
    scopeItems,
    execution,
    globalLogs: (query: Query<"globalLogs">) => store.logPage(query),
    log: (id: number) => present(store.logDetail(id)),
    eventHistory: (query: Query<"eventHistory">) => store.eventPage(query),
    event,
    runSource,
    loopySource,
  };
}
