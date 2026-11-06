import type { Schema } from "effect";
import { Effect } from "effect";
import { type routes, serverEvent } from "../contract";
import { requireDefinition } from "./definition";
import { ServiceError } from "./error";
import type { ServiceOptions } from "./registry";
import { makeRunAccess } from "./run-access";
import type { RunViews } from "./run-views";
import { nodeDetailEvent } from "./views";

export function makeRunQueries(options: ServiceOptions, runViews: RunViews) {
  const { requireRun, runGraph } = makeRunAccess(options);

  const runPayload = Effect.fn("queries.runPayload")(function* (id: string) {
    const run = yield* requireRun(id);

    return run.output === undefined
      ? { input: run.input }
      : { input: run.input, output: run.output };
  });

  const logs = Effect.fn("queries.logs")(function* (id: string, after?: number, limit?: number) {
    yield* requireRun(id);

    return yield* options.store.getLogs(id, after, limit);
  });

  const readRunReference = Effect.fn("queries.readRunReference")(function* (id: string) {
    const run = yield* options.store.runReference(id);

    if (!run) {
      return yield* Effect.fail(new ServiceError("not_found"));
    }

    return run;
  });

  const overview = Effect.fn("queries.overview")(function* (
    query: Schema.Schema.Type<typeof routes.overview.query>,
  ) {
    return yield* options.store.overview(query);
  });

  const executions = Effect.fn("queries.executions")(function* (
    id: string,
    query: Schema.Schema.Type<typeof routes.executions.query>,
  ) {
    yield* readRunReference(id);

    return yield* options.store.nodePage(id, query);
  });

  const scopes = Effect.fn("queries.scopes")(function* (
    id: string,
    query: Schema.Schema.Type<typeof routes.scopes.query>,
  ) {
    yield* readRunReference(id);

    return yield* options.store.scopeCounts(id, query.parentScope);
  });

  const scopeItems = Effect.fn("queries.scopeItems")(function* (
    id: string,
    query: Schema.Schema.Type<typeof routes.scopeItems.query>,
  ) {
    yield* readRunReference(id);

    return yield* options.store.scopeItems(id, query);
  });

  const execution = Effect.fn("queries.execution")(function* (
    id: string,
    query: Schema.Schema.Type<typeof routes.execution.query>,
  ) {
    yield* readRunReference(id);
    const detail = yield* options.store.execution(id, query.key, query.attemptsAfter);

    if (!detail) {
      return yield* Effect.fail(new ServiceError("not_found"));
    }

    return detail;
  });

  const globalLogs = Effect.fn("queries.globalLogs")(function* (
    query: Schema.Schema.Type<typeof routes.globalLogs.query>,
  ) {
    return yield* options.store.logPage(query);
  });

  const log = Effect.fn("queries.log")(function* (id: number) {
    const log = yield* options.store.logDetail(id);

    if (!log) {
      return yield* Effect.fail(new ServiceError("not_found"));
    }

    return log;
  });

  const eventHistory = Effect.fn("queries.eventHistory")(function* (
    query: Schema.Schema.Type<typeof routes.eventHistory.query>,
  ) {
    return yield* options.store.eventPage(query);
  });

  const event = Effect.fn("queries.event")(function* (sequence: number) {
    const event = yield* options.store.eventDetail(sequence);

    if (!event) {
      return yield* Effect.fail(new ServiceError("not_found"));
    }

    if (event.entity === "node") {
      return nodeDetailEvent(event);
    }

    return serverEvent(
      event,
      yield* runViews.resolve(event.entity === "run" ? [event.record] : []),
    );
  });

  const runSource = Effect.fn("queries.runSource")(function* (id: string) {
    const run = yield* readRunReference(id);

    return yield* (yield* options.registry(run.workspace)).revisionSource(run.slug, run.revision);
  });

  const loopySource = Effect.fn("queries.loopySource")(function* (slug: string, workspace: string) {
    const registry = yield* options.registry(workspace);
    const saved = yield* requireDefinition(registry, slug);

    return yield* registry.revisionSource(slug, saved.revision);
  });

  return {
    runGraph,
    runPayload,
    logs,
    overview,
    executions,
    scopes,
    scopeItems,
    execution,
    globalLogs,
    log,
    eventHistory,
    event,
    runSource,
    loopySource,
  };
}

export type RunQueries = ReturnType<typeof makeRunQueries>;
