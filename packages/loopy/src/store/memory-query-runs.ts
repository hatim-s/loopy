import {
  executionKeyString,
  type HookRecord,
  type OverviewQuery,
  type RunDefinitionCount,
  type RunPageQuery,
} from "../core/index.js";
import { MemorySchedules } from "./memory-schedules.js";
import { matchesRun, overviewBuckets } from "./query-utils.js";

export class MemoryQueryRuns extends MemorySchedules {
  async runReference(id: string) {
    const run = this.runs.get(id);

    return run
      ? { id: run.id, slug: run.slug, workspace: run.workspace, revision: run.revision }
      : undefined;
  }
  async runningCount() {
    return [...this.runs.values()].filter((run) => run.status === "running").length;
  }
  async runWorkspaces() {
    return [...new Set([...this.runs.values()].map((run) => run.workspace))];
  }
  async pendingHooks(ids: string[], now: string) {
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
  async queryRuns(query: RunPageQuery) {
    const hooks =
      query.waiting === undefined
        ? undefined
        : await this.pendingHooks([...this.runs.keys()], query.now);

    return structuredClone(
      [...this.runs.values()]
        .filter(
          (run) =>
            matchesRun(run, query) &&
            (query.waiting === undefined || hooks?.has(run.id) === query.waiting) &&
            (query.before === undefined || `${run.createdAt}|${run.id}` < query.before),
        )
        .sort((a, b) =>
          a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
        )
        .slice(0, Math.min(query.limit, 200)),
    );
  }
  async runCountsByDefinition(): Promise<RunDefinitionCount[]> {
    const counts = new Map<string, RunDefinitionCount>();

    for (const { workspace, slug, status } of this.runs.values()) {
      const key = JSON.stringify([workspace, slug, status]);
      const row = counts.get(key) ?? { workspace, slug, status, count: 0 };
      row.count++;
      counts.set(key, row);
    }

    return [...counts.values()];
  }
  async overview(query: OverviewQuery) {
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
  }
}
