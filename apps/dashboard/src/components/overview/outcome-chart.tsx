import { useId, useState } from "react";
import type { OverviewBucket, StatusCounts } from "../../lib/view-models.ts";

/** What the chart stacks. In-flight folds queued, running and suspended into one series. */
export const SERIES = [
  { key: "succeeded", label: "Succeeded", fill: "var(--chart-ok)" },
  { key: "failed", label: "Failed", fill: "var(--chart-bad)" },
  { key: "cancelled", label: "Cancelled", fill: "var(--chart-cancel)" },
  { key: "inFlight", label: "In flight", fill: "var(--chart-live)" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

export type ChartMetric = "runs" | "failed";

function values(counts: StatusCounts): Record<SeriesKey, number> {
  return {
    succeeded: counts.succeeded,
    failed: counts.failed,
    cancelled: counts.cancelled,
    inFlight: counts.queued + counts.running + counts.suspended,
  };
}

const HEIGHT = 200;

const AXIS_W = 36;

const LABEL_H = 22;

const GAP = 2;

/** Round the axis top to a step a person can count in: 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 4) {
    return 4;
  }

  const power = 10 ** Math.floor(Math.log10(value));

  return [1, 2, 5, 10].map((step) => step * power).find((step) => step >= value) ?? value;
}

const HOUR = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function bucketLabel(start: string, bucketSeconds: number): string {
  return bucketSeconds >= 86_400 ? DAY.format(new Date(start)) : HOUR.format(new Date(start));
}

/**
 * Runs per bucket as stacked columns, or failed runs alone. Each column has a hover read-out,
 * and a table carries the same numbers for screen readers.
 */
export function OutcomeChart(props: {
  buckets: OverviewBucket[];
  bucketSeconds: number;
  metric: ChartMetric;
}) {
  const { buckets, bucketSeconds, metric } = props;
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const shown = metric === "runs" ? SERIES : SERIES.filter((series) => series.key === "failed");
  const rows = buckets.map((bucket) => values(bucket.counts));
  const totals = rows.map((row) => shown.reduce((sum, series) => sum + row[series.key], 0));
  const top = niceMax(Math.max(0, ...totals));
  const ticks = [0, top / 4, top / 2, (top * 3) / 4, top];
  const labelEvery = Math.ceil(buckets.length / 8);
  const active = hover === null ? null : { bucket: buckets[hover], row: rows[hover] };

  return (
    <figure className="m-0">
      <figcaption id={titleId} className="sr-only">
        {metric === "runs" ? "Runs by outcome" : "Failed runs"} per{" "}
        {bucketSeconds >= 86_400
          ? "day"
          : bucketSeconds >= 3600
            ? "hour"
            : `${bucketSeconds / 60} minutes`}
      </figcaption>
      <div className="relative" style={{ height: HEIGHT + LABEL_H }} aria-hidden="true">
        {ticks.map((tick) => (
          <div
            key={tick}
            className="absolute right-0 flex items-center"
            style={{ left: 0, top: HEIGHT - (tick / top) * HEIGHT }}
          >
            <span className="w-[30px] -translate-y-1/2 text-right text-[11px] text-faint tabular-nums">
              {Math.round(tick)}
            </span>
            <span
              className={`ml-1.5 h-px flex-1 ${tick === 0 ? "bg-line-strong" : "bg-[var(--grid)] opacity-60"}`}
            />
          </div>
        ))}
        <div
          className="absolute top-0 right-0 flex items-end"
          style={{
            left: AXIS_W,
            height: HEIGHT,
            gap: `${Math.max(1, Math.min(6, 240 / buckets.length))}px`,
          }}
          onPointerLeave={() => setHover(null)}
        >
          {rows.map((row, index) => (
            <div
              key={buckets[index]?.start}
              className={`flex h-full min-w-0 flex-1 flex-col-reverse ${hover === index ? "bg-hover" : ""}`}
              onPointerEnter={() => setHover(index)}
            >
              {shown.map((series) =>
                row[series.key] === 0 ? null : (
                  <span
                    key={series.key}
                    className="block w-full first:rounded-b-[1px] last:rounded-t-[3px]"
                    style={{
                      height: `${(row[series.key] / top) * 100}%`,
                      background: series.fill,
                      marginTop: GAP,
                    }}
                  />
                ),
              )}
            </div>
          ))}
          {active?.bucket && active.row && hover !== null && (
            <div
              className="popover pointer-events-none top-2 w-44 px-3 py-2 text-xs"
              style={{
                left: `${((hover + 0.5) / buckets.length) * 100}%`,
                transform: `translateX(${hover > buckets.length / 2 ? "calc(-100% - 12px)" : "12px"})`,
              }}
            >
              <p className="mb-1 font-medium">{bucketLabel(active.bucket.start, bucketSeconds)}</p>
              {shown.map((series) => (
                <p key={series.key} className="flex items-center gap-2 text-muted">
                  <i className="size-2 rounded-[2px]" style={{ background: series.fill }} />
                  {series.label}
                  <span className="ml-auto text-ink tabular-nums">{active.row?.[series.key]}</span>
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="absolute right-0 bottom-0 flex" style={{ left: AXIS_W, height: LABEL_H }}>
          {buckets.map((bucket, index) => (
            <span key={bucket.start} className="relative flex-1 overflow-visible">
              {index % labelEvery === 0 && (
                <span className="absolute top-1.5 left-0 text-[11px] whitespace-nowrap text-faint">
                  {bucketLabel(bucket.start, bucketSeconds)}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only" aria-labelledby={titleId}>
        <thead>
          <tr>
            <th scope="col">Bucket start</th>
            {shown.map((series) => (
              <th key={series.key} scope="col">
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket, index) => (
            <tr key={bucket.start}>
              <th scope="row">{bucketLabel(bucket.start, bucketSeconds)}</th>
              {shown.map((series) => (
                <td key={series.key}>{rows[index]?.[series.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function ChartLegend({ metric }: { metric: ChartMetric }) {
  const shown = metric === "runs" ? SERIES : SERIES.filter((series) => series.key === "failed");

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {shown.map((series) => (
        <li key={series.key} className="flex items-center gap-1.5">
          <i className="size-2 rounded-[2px]" style={{ background: series.fill }} />
          {series.label}
        </li>
      ))}
    </ul>
  );
}
