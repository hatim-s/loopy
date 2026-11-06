import {
  executionKeyString,
  type HookRecord,
  type OverviewQuery,
  type RunDefinitionCount,
  type RunPageQuery,
} from "@loopy/core";
import { storageOperation } from "../operation";
import { matchesRun, overviewBuckets } from "../query-utils";
import { MemorySchedules } from "./schedules";

export class MemoryQueryRuns extends MemorySchedules {
  runReference(id: string) {
    return storageOperation("runReference", () => {
      const run = this.runs.get(id);

      return run
        ? { id: run.id, slug: run.slug, workspace: run.workspace, revision: run.revision }
        : undefined;
    });
  }
  runningCount() {
    return storageOperation("runningCount", () => {
      return [...this.runs.values()].filter((run) => run.status === "running").length;
    });
  }
  runWorkspaces() {
    return storageOperation("runWorkspaces", () => {
      return [...new Set([...this.runs.values()].map((run) => run.workspace))];
    });
  }
  pendingHooks(ids: string[], now: string) {
    return storageOperation("pendingHooks", () => this.readPendingHooks(ids, now));
  }
  protected readPendingHooks(ids: string[], now: string) {
    const hooks = new Map<string, HookRecord & { expiresAt: string | null }>();

    for (const wait of this.waits.values()) {
      if (!ids.includes(wait.runId) || hooks.has(wait.runId) || wait.resolvedAt || wait.expiredAt) {
        continue;
      }

      const run = this.runs.get(wait.runId);

      if (run?.status !== "running" && run?.status !== "suspended") {
        continue;
      }

      const node = this.nodes.get(wait.runId)?.get(executionKeyString(wait.executionKey));

      if (node?.status !== "waiting" || (node.wakeAt !== null && node.wakeAt <= now)) {
        continue;
      }

      hooks.set(wait.runId, { ...structuredClone(wait), expiresAt: node.wakeAt });
    }

    return hooks;
  }
  queryRuns(query: RunPageQuery) {
    return storageOperation("queryRuns", () => {
      const hooks =
        query.waiting === undefined
          ? undefined
          : this.readPendingHooks([...this.runs.keys()], query.now);

      return structuredClone(
        [...this.runs.values()]
          .filter(
            (run) =>
              matchesRun(run, query) &&
              (query.waiting === undefined || hooks?.has(run.id) === query.waiting) &&
              (query.before === undefined || `${run.createdAt}|${run.id}` < query.before),
          )
          .sort((a, b) =>
            a.createdAt === b.createdAt
              ? a.id < b.id
                ? 1
                : -1
              : a.createdAt < b.createdAt
                ? 1
                : -1,
          )
          .slice(0, Math.min(query.limit, 200)),
      );
    });
  }
  runCountsByDefinition() {
    return storageOperation("runCountsByDefinition", () => {
      const counts = new Map<string, RunDefinitionCount>();

      for (const { workspace, slug, status } of this.runs.values()) {
        const key = JSON.stringify([workspace, slug, status]);
        const row = counts.get(key) ?? { workspace, slug, status, count: 0 };
        row.count++;
        counts.set(key, row);
      }

      return [...counts.values()];
    });
  }
  overview(query: OverviewQuery) {
    return storageOperation("overview", () => {
      const result = overviewBuckets(query);

      for (const run of this.runs.values()) {
        if (!matchesRun(run, query)) {
          continue;
        }

        const bucket =
          result.buckets[
            Math.floor(
              (Date.parse(run.createdAt) - Date.parse(query.from)) / (query.bucketSeconds * 1000),
            )
          ];

        if (bucket) {
          bucket.counts[run.status]++;
          result.counts[run.status]++;
        }
      }

      return result;
    });
  }
}
