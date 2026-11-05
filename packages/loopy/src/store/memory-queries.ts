import {
  executionKeyString,
  type NodePageQuery,
  type ScopeCounts,
  type ScopeItem,
  type ScopeItemsQuery,
} from "../core/index.js";
import { MemoryQueryRuns } from "./memory-query-runs.js";
import { storageOperation } from "./operation.js";
import { nodePage } from "./query-utils.js";

export class MemoryQueries extends MemoryQueryRuns {
  nodePage(runId: string, query: NodePageQuery) {
    return storageOperation("nodePage", () => this.readNodePage(runId, query));
  }
  protected readNodePage(runId: string, query: NodePageQuery) {
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
  scopeCounts(runId: string, parentScope = "[]") {
    return storageOperation("scopeCounts", () => this.readScopeCounts(runId, parentScope));
  }
  protected readScopeCounts(runId: string, parentScope = "[]") {
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
  scopeItems(runId: string, query: ScopeItemsQuery) {
    return storageOperation("scopeItems", () => {
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
    });
  }
  execution(runId: string, key: string, after = 0) {
    return storageOperation("execution", () => {
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
    });
  }
  dashboardSnapshot(id: string) {
    return storageOperation("dashboardSnapshot", () => {
      const run = this.runs.get(id);

      if (!run) {
        return undefined;
      }

      const page = this.readNodePage(id, { scope: "[]", limit: 200 });
      const hooks = this.readHooks(id);

      return structuredClone({
        run,
        nodeRuns: page.items,
        nodeRunsNext: page.next,
        truncatedOutputs: page.truncatedOutputs,
        scopes: this.readScopeCounts(id),
        steps: [],
        logs: [],
        hooks: hooks.slice(0, 200),
        hooksTruncated: hooks.length > 200,
        cursor: this.sequence,
        epoch: this.storeEpoch,
      });
    });
  }
}
