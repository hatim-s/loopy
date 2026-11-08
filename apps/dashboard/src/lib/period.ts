export const PERIODS = ["1h", "24h", "7d", "30d"] as const;

export type Period = (typeof PERIODS)[number];

export const DEFAULT_PERIOD = "24h" satisfies Period;

/** Each window's length, the overview's bucket size, and how both read on the page. */
export const PERIOD = {
  "1h": { ms: 3_600_000, bucketSeconds: 300, label: "Last hour", bucket: "5 minutes" },
  "24h": { ms: 86_400_000, bucketSeconds: 3600, label: "Last 24 hours", bucket: "hour" },
  "7d": { ms: 604_800_000, bucketSeconds: 86_400, label: "Last 7 days", bucket: "day" },
  "30d": { ms: 2_592_000_000, bucketSeconds: 86_400, label: "Last 30 days", bucket: "day" },
} as const satisfies Record<
  Period,
  { ms: number; bucketSeconds: number; label: string; bucket: string }
>;

export const PERIOD_OPTIONS = PERIODS.map((value) => ({ value, label: value }));

/** The start of a window ending at `now`, as the API's `from` filter. */
export function periodStart(period: Period, now: number): string {
  return new Date(now - PERIOD[period].ms).toISOString();
}
