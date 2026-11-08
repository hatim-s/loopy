import {
  emptyRunCounts,
  type OverviewQuery,
  type OverviewView,
  overviewBucketCount,
} from "@loopy/contract";

export const FEED_SCAN_LIMIT = 2000;

export function overviewBuckets(query: OverviewQuery): OverviewView {
  const count = overviewBucketCount(query);

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

export function scanPage<T>(options: {
  candidates: T[];
  limit: number;
  key: (row: T) => number;
  matches: (row: T) => boolean;
  oldest: number | null;
  newest: number | null;
}) {
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
