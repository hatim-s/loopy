import type { GraphView } from "loopy/contract";

type Kind = GraphView["nodes"][number]["kind"] | "subgraph";

// 16 by 16 strokes, drawn to read at 14px beside a node title.
const PATHS = {
  code: "M5.5 3.5 2.5 8l3 4.5M10.5 3.5l3 4.5-3 4.5",
  command: "M2.5 4.5 6 8l-3.5 3.5M8 12h5.5",
  branch: "M2 8h4m0 0 3.5-4H14M6 8l3.5 4H14",
  switch: "M2 8h4m0 0 3.5-4.5H14M6 8h8M6 8l3.5 4.5H14",
  map: "M4.5 2.5h9v9M2.5 4.5h9v9h-9z",
  parallel: "M2 8h2.5m0-4v8m0-8H14m-9.5 4H14m-9.5 4H14",
  finally: "M3 3h10v6.5a5 5 0 0 1-10 0zM5.5 8l2 2 3-3.5",
  rescue:
    "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zm0 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.1 4.1l2.1 2.1m3.6 3.6 2.1 2.1m0-7.8-2.1 2.1M6.2 9.8l-2.1 2.1",
  wait: "M4 2.5h8M4 13.5h8M5 2.5c0 3 6 3 6 5.5s-6 2.5-6 5.5m6-11c0 3-6 3-6 5.5s6 2.5 6 5.5",
  sleep: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5",
  fail: "M5.5 2.5h5l3 3v5l-3 3h-5l-3-3v-5zM6 6l4 4m0-4-4 4",
  format: "M3 4.5h10M3 8h6.5M3 11.5h8",
  log: "M3.5 3.5v9h9M6 9.5l2-2 2 1.5 2.5-3",
  now: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 4.5V8h3",
  uuid: "M6 2.5 4.5 13.5M11.5 2.5 10 13.5M3 6h10.5M2.5 10H13",
  random: "M3 3h10v10H3zM6 6h.01M10 10h.01M10 6h.01M6 10h.01",
  join: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  subgraph: "M2.5 4.5v7h11v-7zM2.5 4.5l2-2h4l2 2",
} satisfies Record<Kind, string>;

export function KindGlyph({ kind, className = "" }: { kind: Kind; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`size-3.5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[kind]} />
    </svg>
  );
}
