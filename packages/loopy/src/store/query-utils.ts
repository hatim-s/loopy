import {
  emptyRunCounts,
  executionKeyString,
  type FeedPage,
  type NodePage,
  type NodeRun,
  type Overview,
  type OverviewQuery,
  type RunFilter,
  type RunRecord,
} from "../core/index.js";

export const FEED_SCAN_LIMIT = 2000;

export const PREVIEW_BYTES = 16_384;

export function matchesRun(run: RunRecord, filter: RunFilter): boolean {
  return (
    (filter.slug === undefined || run.slug === filter.slug) &&
    (filter.workspace === undefined || run.workspace === filter.workspace) &&
    (filter.status === undefined || run.status === filter.status) &&
    (filter.from === undefined || run.createdAt >= filter.from) &&
    (filter.to === undefined || run.createdAt < filter.to)
  );
}

export function overviewBuckets(query: OverviewQuery): Overview {
  const count = Math.ceil(
    (Date.parse(query.to) - Date.parse(query.from)) / (query.bucketSeconds * 1000),
  );

  if (count < 1 || count > 744) {
    throw new Error("Overview window must contain between 1 and 744 buckets.");
  }

  return {
    from: query.from,
    to: query.to,
    bucketSeconds: query.bucketSeconds,
    counts: emptyRunCounts(),
    buckets: Array.from(Array(count).keys(), (index) => ({
      at: new Date(Date.parse(query.from) + index * query.bucketSeconds * 1000).toISOString(),
      counts: emptyRunCounts(),
    })),
  };
}

export function nodePage(items: NodeRun[], limit: number, more: boolean): NodePage {
  const truncatedOutputs: Record<string, number> = {};

  const selected = items.slice(0, limit).map((node) => {
    const preview = { ...node };
    delete preview.inputView;

    if (node.status !== "succeeded") {
      return preview;
    }

    const bytes = new TextEncoder().encode(JSON.stringify(node.output)).byteLength;

    if (bytes <= PREVIEW_BYTES) {
      return preview;
    }

    truncatedOutputs[executionKeyString(node.key)] = bytes;

    return { ...preview, output: null };
  });

  const last = selected.at(-1);

  return {
    items: selected,
    next: more && last ? executionKeyString(last.key) : null,
    truncatedOutputs,
  };
}

export function scanPage<T>(options: {
  candidates: T[];
  limit: number;
  key: (row: T) => number;
  matches: (row: T) => boolean;
  oldest: number | null;
  newest: number | null;
}): FeedPage<T> {
  const items: T[] = [];
  let scanned = 0;
  let last: number | null = null;

  for (const row of options.candidates.slice(0, FEED_SCAN_LIMIT)) {
    scanned++;
    last = options.key(row);

    if (options.matches(row)) {
      items.push(row);
    }

    if (items.length >= options.limit) {
      break;
    }
  }

  const hasMore = options.candidates.length > scanned;

  return {
    items,
    next: hasMore ? last : null,
    scanned,
    hasMore,
    oldest: options.oldest,
    newest: options.newest,
  };
}
