import type {
  DaemonView,
  ExecutionDetail,
  GraphRevisionView,
  LogRecord,
  OverviewView,
  RunSnapshotView,
  routes,
  ScheduleOverviewView,
  ScheduleView,
  ScopeCountsView,
  ServerEvent,
  SourceArtifact,
} from "@loopy/contract";
import { useQuery } from "@tanstack/react-query";
import type { Schema } from "effect";
import { useBackend } from "../router-context";
import { useClock } from "./clock";
import { loaded, mapLoaded } from "./loaded";
import { PERIOD, type Period, periodStart } from "./period";
import {
  daemonQuery,
  eventQuery,
  executionQuery,
  logQuery,
  loopiesQuery,
  loopyGraphQuery,
  loopySourceQuery,
  overviewQuery,
  runGraphQuery,
  runPayloadQuery,
  runQuery,
  runSourceQuery,
  scheduleOverviewQuery,
  schedulesQuery,
  scopesQuery,
  workspaceLoopiesQuery,
} from "./queries";
import type { ExecutionView, Lazy, Loaded, LoopyRow, ScopeTuple } from "./view-models";

// The overview window moves a minute at a time so its query key stays put between ticks.
const OVERVIEW_TICK_MS = 60_000;

export function useOverview(period: Period, slug?: string): Loaded<OverviewView> {
  const now = useClock(OVERVIEW_TICK_MS);

  return loaded(
    useQuery(
      overviewQuery(useBackend(), {
        slug,
        from: periodStart(period, now),
        to: new Date(now).toISOString(),
        bucketSeconds: PERIOD[period].bucketSeconds,
      }),
    ),
  );
}

export function useLoopyRows(): Loaded<LoopyRow[]> {
  return mapLoaded(loaded(useQuery(loopiesQuery(useBackend()))), (rows) =>
    rows.map((row) => ({ ...row, latestRuns: row.latestRuns ?? [] })),
  );
}

export function useWorkspaceLoopyRows(workspace: string | null): Lazy<LoopyRow[]> {
  const query = useQuery(workspaceLoopiesQuery(useBackend(), workspace));

  if (workspace === null) {
    return { state: "idle" };
  }

  return mapLoaded(loaded(query), (rows) =>
    rows.map((row) => ({ ...row, latestRuns: row.latestRuns ?? [] })),
  );
}

export function useRunSnapshot(id: string): Loaded<RunSnapshotView> {
  return loaded(useQuery(runQuery(useBackend(), id)));
}

export function useRunGraph(id: string): Loaded<GraphRevisionView> {
  return loaded(useQuery(runGraphQuery(useBackend(), id)));
}

export function useLoopyGraph(slug: string, workspace: string): Loaded<GraphRevisionView> {
  return loaded(useQuery(loopyGraphQuery(useBackend(), slug, workspace)));
}

export function useRunPayload(
  runId: string | null,
): Lazy<Schema.Schema.Type<typeof routes.runPayload.response>> {
  const query = useQuery(runPayloadQuery(useBackend(), runId));

  return runId === null ? { state: "idle" } : loaded(query);
}

export function useRunSource(runId: string): Loaded<SourceArtifact> {
  return loaded(useQuery(runSourceQuery(useBackend(), runId)));
}

export function useLoopySource(slug: string, workspace: string): Loaded<SourceArtifact> {
  return loaded(useQuery(loopySourceQuery(useBackend(), slug, workspace)));
}

export function useScopes(runId: string, parentScope: ScopeTuple): Loaded<ScopeCountsView[]> {
  return loaded(useQuery(scopesQuery(useBackend(), runId, JSON.stringify(parentScope))));
}

function attemptsIncomplete(detail: ExecutionDetail): boolean {
  return detail.attemptsNext !== null || detail.attempts.length < detail.node.attempt;
}

export function useExecution(runId: string, key: string | null): Lazy<ExecutionView> {
  const query = useQuery(executionQuery(useBackend(), runId, key ?? undefined));

  if (key === null) {
    return { state: "idle" };
  }

  return mapLoaded(loaded(query), (data) => ({
    ...data,
    attemptsIncomplete: attemptsIncomplete(data),
  }));
}

export function useLog(id: number | null): Lazy<LogRecord> {
  const query = useQuery(logQuery(useBackend(), id ?? undefined));

  return id === null ? { state: "idle" } : mapLoaded(loaded(query), (data) => data.log);
}

export function useEvent(sequence: number | null): Lazy<ServerEvent> {
  const query = useQuery(eventQuery(useBackend(), sequence ?? undefined));

  return sequence === null ? { state: "idle" } : loaded(query);
}

export function useDaemon(): Loaded<DaemonView> {
  return loaded(useQuery(daemonQuery(useBackend())));
}

export function useScheduleOverview(): Loaded<ScheduleOverviewView> {
  return loaded(useQuery(scheduleOverviewQuery(useBackend())));
}

export function useSchedules(workspace: string | null): Loaded<ScheduleView[]> {
  return loaded(useQuery(schedulesQuery(useBackend(), workspace)));
}
