import {
  type DashboardSnapshot,
  emptyRunCounts,
  executionKeyString,
  type HookRecord,
  type NodePageQuery,
  type OverviewQuery,
  type RunFilter,
  type RunPageQuery,
  type ScopeCounts,
  type ScopeItem,
  type ScopeItemsQuery,
} from "../core/index.js";
import { MemorySchedules } from "./memory-schedules.js";
import { matchesRun, nodePage, overviewBuckets } from "./query-utils.js";

export class MemoryQueries extends MemorySchedules {
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
  async runCounts(filter: RunFilter = {}) {
    const counts = emptyRunCounts();

    for (const run of this.runs.values()) {
      if (matchesRun(run, filter)) {
        counts[run.status]++;
      }
    }

    return counts;
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
  async nodePage(runId: string, query: NodePageQuery) {
    const nodes = [...(this.nodes.get(runId)?.values() ?? [])]
      .filter(
        (node) =>
          JSON.stringify(node.key.scope) === query.scope &&
          (query.nodeId === undefined || query.nodeId === node.key.nodeId) &&
          (query.status === undefined || query.status === node.status) &&
          (query.after === undefined || executionKeyString(node.key) > query.after),
      )
      .sort((a, b) => (executionKeyString(a.key) < executionKeyString(b.key) ? -1 : 1));

    return structuredClone(nodePage(nodes, Math.min(query.limit, 200), nodes.length > query.limit));
  }
  async scopeCounts(runId: string, parentScope = "[]") {
    const summaries = new Map<string, ScopeCounts & { indices: Set<number> }>();

    for (const node of this.nodes.get(runId)?.values() ?? []) {
      for (const [depth, scope] of node.key.scope.entries()) {
        const parent = node.key.scope.slice(0, depth);

        if (JSON.stringify(parent) !== parentScope) {
          continue;
        }

        const summary = summaries.get(scope.nodeId) ?? {
          nodeId: scope.nodeId,
          parentScope: parent,
          total: 0,
          totalKind: "materialized" as const,
          counts: {},
          indices: new Set<number>(),
        };

        summary.indices.add(scope.index);
        summary.total = summary.indices.size;
        summary.counts[node.status] = (summary.counts[node.status] ?? 0) + 1;
        summaries.set(scope.nodeId, summary);
      }
    }

    return structuredClone(
      [...summaries.values()].slice(0, 200).map((summary) => ({
        nodeId: summary.nodeId,
        parentScope: summary.parentScope,
        total: summary.total,
        totalKind: summary.totalKind,
        counts: summary.counts,
      })),
    );
  }
  async scopeItems(runId: string, query: ScopeItemsQuery) {
    const items = new Map<number, ScopeItem>();

    for (const node of this.nodes.get(runId)?.values() ?? []) {
      for (const [depth, scope] of node.key.scope.entries()) {
        if (
          scope.nodeId !== query.nodeId ||
          JSON.stringify(node.key.scope.slice(0, depth)) !== query.parentScope ||
          scope.index <= (query.after ?? -1)
        ) {
          continue;
        }

        const item = items.get(scope.index) ?? { index: scope.index, counts: {} };
        item.counts[node.status] = (item.counts[node.status] ?? 0) + 1;
        items.set(scope.index, item);
      }
    }

    const selected = [...items.values()]
      .filter((item) => query.status === undefined || (item.counts[query.status] ?? 0) > 0)
      .sort((a, b) => a.index - b.index);

    const page = selected.slice(0, Math.min(query.limit, 200));

    return {
      items: page,
      next: selected.length > query.limit ? (page.at(-1)?.index ?? null) : null,
    };
  }
  async execution(runId: string, key: string, after = 0) {
    const node = this.nodes.get(runId)?.get(key);

    if (!node) {
      return undefined;
    }

    const rows = [...(this.attempts.get(key)?.values() ?? [])]
      .filter((attempt) => attempt.attempt > after)
      .sort((a, b) => a.attempt - b.attempt);

    const truncatedAttempts: Record<string, number> = {};

    const attempts = rows.slice(0, 200).map((node) => {
      if (node.status !== "succeeded") {
        return node;
      }

      const bytes = new TextEncoder().encode(JSON.stringify(node.output)).byteLength;

      if (bytes <= 16_384) {
        return node;
      }

      truncatedAttempts[String(node.attempt)] = bytes;

      return { ...node, output: null };
    });

    return structuredClone({
      node,
      attempts,
      truncatedAttempts,
      attemptsNext: rows.length > 200 ? (attempts.at(-1)?.attempt ?? null) : null,
    });
  }
  async dashboardSnapshot(id: string): Promise<DashboardSnapshot | undefined> {
    const run = this.runs.get(id);

    if (!run) {
      return undefined;
    }

    const page = await this.nodePage(id, { scope: "[]", limit: 200 });
    const hooks = this.readHooks(id);

    return structuredClone({
      run,
      nodeRuns: page.items,
      nodeRunsNext: page.next,
      truncatedOutputs: page.truncatedOutputs,
      scopes: await this.scopeCounts(id),
      steps: [],
      logs: [],
      hooks: hooks.slice(0, 200),
      hooksTruncated: hooks.length > 200,
      cursor: this.sequence,
      epoch: this.storeEpoch,
    });
  }
}
