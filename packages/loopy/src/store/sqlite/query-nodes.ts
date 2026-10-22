import type { SQLQueryBindings } from "bun:sqlite";
import { executionKeySchema, nodeRunSchema } from "../../contract/index.js";
import {
  type NodePageQuery,
  type NodeRun,
  type NodeRunStatus,
  type ScopeCounts,
  type ScopeItem,
  type ScopeItemsQuery,
} from "../../core/index.js";
import { PREVIEW_BYTES } from "../query-utils.js";
import { publicHook } from "../wait.js";
import { waitRecordSchema } from "../wait-schema.js";
import {
  type PreviewRunRow,
  previewRun,
  RUN_PREVIEW_COLUMNS,
  SqliteQueryRuns,
} from "./query-runs.js";

export class SqliteQueryNodes extends SqliteQueryRuns {
  protected readNodePage(runId: string, query: NodePageQuery) {
    const clauses = ["run_id=?", "scope=?"];
    const values: SQLQueryBindings[] = [runId, query.scope];

    if (query.nodeId !== undefined) {
      clauses.push("node_id=?");
      values.push(query.nodeId);
    }

    if (query.status !== undefined) {
      clauses.push("status=?");
      values.push(query.status);
    }

    if (query.after !== undefined) {
      clauses.push("execution_key>?");
      values.push(query.after);
    }

    const rows = this.db
      .query<{ record: string; bytes: number; execution_key: string }, SQLQueryBindings[]>(
        `SELECT execution_key,CASE WHEN status='succeeded' AND length(CAST(output AS BLOB))>${PREVIEW_BYTES} THEN json_remove(json_set(record,'$.output',NULL),'$.inputView') ELSE json_remove(record,'$.inputView') END AS record,CASE WHEN status='succeeded' THEN length(CAST(output AS BLOB)) ELSE 0 END AS bytes FROM node_runs WHERE ${clauses.join(" AND ")} ORDER BY execution_key LIMIT ?`,
      )
      .all(...values, Math.min(query.limit, 200) + 1);

    const selected = rows.slice(0, query.limit);
    const truncatedOutputs: Record<string, number> = {};

    for (const row of selected) {
      if (row.bytes > PREVIEW_BYTES) {
        truncatedOutputs[row.execution_key] = row.bytes;
      }
    }

    return {
      items: selected.map((row) => nodeRunSchema.parse(JSON.parse(row.record))),
      next: rows.length > query.limit ? (selected.at(-1)?.execution_key ?? null) : null,
      truncatedOutputs,
    };
  }

  protected readScopeCounts(runId: string, parentScope = "[]"): ScopeCounts[] {
    const rows = this.db
      .query<
        { map_node: string; status: NodeRunStatus; count: number; total: number },
        [string, string]
      >(
        `WITH maps AS (SELECT map_node,count(DISTINCT item_index) AS total FROM node_scopes WHERE run_id=?1 AND parent_scope=?2 GROUP BY map_node ORDER BY map_node LIMIT 200) SELECT m.map_node,m.total,s.status,count(*) AS count FROM maps m JOIN node_scopes s ON s.run_id=?1 AND s.parent_scope=?2 AND s.map_node=m.map_node GROUP BY m.map_node,s.status`,
      )
      .all(runId, parentScope);

    const summaries = new Map<string, ScopeCounts>();

    for (const row of rows) {
      const summary = summaries.get(row.map_node) ?? {
        nodeId: row.map_node,
        parentScope: executionKeySchema.shape.scope.parse(JSON.parse(parentScope)),
        total: row.total,
        totalKind: "materialized" as const,
        counts: {},
      };

      summary.counts[row.status] = row.count;
      summaries.set(row.map_node, summary);
    }

    return [...summaries.values()];
  }

  async nodePage(runId: string, query: NodePageQuery) {
    return this.readNodePage(runId, query);
  }
  async scopeCounts(runId: string, parentScope = "[]") {
    return this.readScopeCounts(runId, parentScope);
  }

  async scopeItems(runId: string, query: ScopeItemsQuery) {
    const values: SQLQueryBindings[] = [runId, query.nodeId, query.parentScope, query.after ?? -1];
    const status = query.status === undefined ? "" : " AND status=?";

    if (query.status !== undefined) {
      values.push(query.status);
    }

    values.push(Math.min(query.limit, 200) + 1);

    const indices = this.db
      .query<{ item_index: number }, SQLQueryBindings[]>(
        `SELECT DISTINCT item_index FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index>?${status} ORDER BY item_index LIMIT ?`,
      )
      .all(...values);

    const selected = indices.slice(0, query.limit);

    if (selected.length === 0) {
      return { items: [], next: null };
    }

    const rows = this.db
      .query<{ item_index: number; status: NodeRunStatus; count: number }, SQLQueryBindings[]>(
        `SELECT item_index,status,count(*) AS count FROM node_scopes WHERE run_id=? AND map_node=? AND parent_scope=? AND item_index IN (${selected.map(() => "?").join(",")}) GROUP BY item_index,status ORDER BY item_index`,
      )
      .all(runId, query.nodeId, query.parentScope, ...selected.map((row) => row.item_index));

    const items = new Map<number, ScopeItem>();

    for (const row of rows) {
      const item = items.get(row.item_index) ?? { index: row.item_index, counts: {} };
      item.counts[row.status] = row.count;
      items.set(row.item_index, item);
    }

    return {
      items: [...items.values()],
      next: indices.length > query.limit ? (selected.at(-1)?.item_index ?? null) : null,
    };
  }

  async dashboardSnapshot(id: string) {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<PreviewRunRow, [string]>(`SELECT ${RUN_PREVIEW_COLUMNS} FROM runs r WHERE r.id=?`)
          .get(id);

        if (!row) {
          return undefined;
        }

        const nodes = this.readNodePage(id, { scope: "[]", limit: 200 });

        const hooks = this.db
          .query<{ record: string }, [string]>(
            "SELECT record FROM waits WHERE run_id=? ORDER BY rowid LIMIT 201",
          )
          .all(id);

        return {
          run: previewRun(row),
          nodeRuns: nodes.items,
          nodeRunsNext: nodes.next,
          truncatedOutputs: nodes.truncatedOutputs,
          scopes: this.readScopeCounts(id),
          steps: [],
          logs: [],
          hooks: hooks
            .slice(0, 200)
            .map((row) => publicHook(waitRecordSchema.parse(JSON.parse(row.record)))),
          hooksTruncated: hooks.length > 200,
          ...this.readEventCursor(),
        };
      })
      .deferred();
  }

  async execution(
    runId: string,
    key: string,
    after = 0,
  ): Promise<
    | {
        node: NodeRun;
        attempts: NodeRun[];
        attemptsNext: number | null;
        truncatedAttempts: Record<string, number>;
      }
    | undefined
  > {
    const node = this.readNode(runId, key);

    if (!node) {
      return undefined;
    }

    const rows = this.db
      .query<{ record: string; attempt: number; bytes: number | null }, [string, string, number]>(
        "SELECT attempt,length(CAST(record->'$.output' AS BLOB)) AS bytes,CASE WHEN json_type(record,'$.output') IS NOT NULL AND length(CAST(record->'$.output' AS BLOB))>16384 THEN json_set(record,'$.output',NULL) ELSE record END AS record FROM node_attempts WHERE run_id=? AND execution_key=? AND attempt>? ORDER BY attempt LIMIT 201",
      )
      .all(runId, key, after);

    const attempts = rows.slice(0, 200).map((row) => nodeRunSchema.parse(JSON.parse(row.record)));
    const truncatedAttempts: Record<string, number> = {};

    for (const row of rows.slice(0, 200)) {
      if (row.bytes !== null && row.bytes > PREVIEW_BYTES) {
        truncatedAttempts[String(row.attempt)] = row.bytes;
      }
    }

    return {
      node,
      attempts,
      truncatedAttempts,
      attemptsNext: rows.length > 200 ? (attempts.at(-1)?.attempt ?? null) : null,
    };
  }
}
