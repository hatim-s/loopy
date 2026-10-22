import {
  type EventPageQuery,
  type EventSummary,
  type LogPageQuery,
  type LogSummary,
} from "../core/index.js";
import { MemoryQueries } from "./memory-queries.js";
import { scanPage } from "./query-utils.js";

export class MemoryQueryFeeds extends MemoryQueries {
  private feedMatch(
    runId: string | null,
    at: string,
    nodeId: string | null,
    query: LogPageQuery | EventPageQuery,
  ) {
    const run = runId === null ? undefined : this.runs.get(runId);

    return (
      (query.runId === undefined || query.runId === runId) &&
      (query.slug === undefined || query.slug === run?.slug) &&
      (query.workspace === undefined || query.workspace === run?.workspace) &&
      (query.status === undefined || query.status === run?.status) &&
      (query.nodeId === undefined || query.nodeId === nodeId) &&
      (query.from === undefined || at >= query.from) &&
      (query.to === undefined || at < query.to)
    );
  }
  async logPage(query: LogPageQuery) {
    const ascending = query.after !== undefined;
    const all = [...this.logIds.entries()].sort((a, b) => a[0] - b[0]);

    const candidates = all
      .filter(([id]) =>
        ascending ? id > (query.after ?? 0) : id < (query.before ?? Number.MAX_SAFE_INTEGER),
      )
      .sort((a, b) => (ascending ? a[0] - b[0] : b[0] - a[0]))
      .slice(0, 2001)
      .map(([id, log]) => {
        return {
          id,
          runId: log.runId,
          slug: this.runs.get(log.runId)?.slug ?? "",
          seq: log.seq,
          at: log.at,
          nodeId: this.logNodeIds.get(id) ?? "",
          executionKey: log.position.kind === "node" ? log.position.executionKey : "",
          attempt: log.position.kind === "node" ? log.position.attempt : 1,
          level: log.level,
          message: log.message,
          dataBytes:
            log.data === undefined
              ? 0
              : new TextEncoder().encode(JSON.stringify(log.data)).byteLength,
        } satisfies LogSummary;
      });

    const page = scanPage({
      candidates,
      limit: query.limit,
      key: (row) => row.id,
      matches: (row) =>
        this.feedMatch(row.runId, row.at, row.nodeId, query) &&
        (query.level === undefined || query.level === row.level) &&
        (query.executionKey === undefined || query.executionKey === row.executionKey) &&
        (query.text === undefined || row.message.toLowerCase().includes(query.text.toLowerCase())),
      oldest: all[0]?.[0] ?? null,
      newest: all.at(-1)?.[0] ?? null,
    });

    return {
      ...page,
      oldestAt: all[0]?.[1].at ?? null,
      newestAt: all.at(-1)?.[1].at ?? null,
      scannedToAt: candidates[page.scanned - 1]?.at ?? null,
      items: page.items.map((row) => ({ ...row, message: row.message.slice(0, 1024) })),
    };
  }
  async logDetail(id: number) {
    const log = this.logIds.get(id);

    return log ? structuredClone({ id, log }) : undefined;
  }
  async eventPage(query: EventPageQuery) {
    const ascending = query.after !== undefined;

    const candidates = this.eventLog
      .filter(
        (event) =>
          (ascending
            ? event.sequence > (query.after ?? 0)
            : event.sequence < (query.before ?? Number.MAX_SAFE_INTEGER)) &&
          (query.runId === undefined || event.runId === query.runId),
      )
      .sort((a, b) => (ascending ? a.sequence - b.sequence : b.sequence - a.sequence))
      .slice(0, 2001)
      .map(
        (event) =>
          ({
            sequence: event.sequence,
            at: event.at,
            txn: event.txn,
            runId: event.runId,
            slug:
              event.runId === null
                ? event.entity === "schedule"
                  ? event.record.slug
                  : null
                : (this.runs.get(event.runId)?.slug ?? null),
            nodeId: event.entity === "node" ? event.record.key.nodeId : null,
            entity: event.entity,
            kind: event.kind,
          }) satisfies EventSummary,
      );

    const page = scanPage({
      candidates,
      limit: query.limit,
      key: (row) => row.sequence,
      matches: (row) =>
        this.feedMatch(row.runId, row.at, row.nodeId, query) &&
        (query.entity === undefined || query.entity === row.entity) &&
        (query.kind === undefined || query.kind === row.kind) &&
        (query.txn === undefined || query.txn === row.txn),
      oldest: this.eventLog[0]?.sequence ?? null,
      newest: this.eventLog.at(-1)?.sequence ?? null,
    });

    return {
      ...page,
      oldestAt: this.eventLog[0]?.at ?? null,
      newestAt: this.eventLog.at(-1)?.at ?? null,
      scannedToAt: candidates[page.scanned - 1]?.at ?? null,
    };
  }
  async eventDetail(sequence: number) {
    return structuredClone(this.eventLog.find((event) => event.sequence === sequence));
  }
}
