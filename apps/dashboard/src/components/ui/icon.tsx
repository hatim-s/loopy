const PATHS = {
  overview: "M2.5 13.5h11M4 11V8M7 11V4.5M10 11V6.5M13 11V3",
  loopies:
    "M8 8c-1.6-2.4-2.9-3.5-4.2-3.5C2.6 4.5 1.7 5.6 1.7 7v2c0 1.4.9 2.5 2.1 2.5C5.1 11.5 6.4 10.4 8 8Zm0 0c1.6 2.4 2.9 3.5 4.2 3.5 1.2 0 2.1-1.1 2.1-2.5V7c0-1.4-.9-2.5-2.1-2.5C10.9 4.5 9.6 5.6 8 8Z",
  runs: "M2.5 4h2M2.5 8h2M2.5 12h2M7 4h6.5M7 8h6.5M7 12h6.5",
  logs: "M3 2.5h7l3 3v8H3zM5.5 7.5h5M5.5 10h5M10 2.5v3h3",
  schedules: "M8 2.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2ZM8 4.8V8l2.2 1.4",
  left: "m10 3.5-4.5 4.5 4.5 4.5",
  right: "m6 3.5 4.5 4.5L6 12.5",
  sort: "m5 6 3-3 3 3M5 10l3 3 3-3",
  up: "m4.5 9.5 3.5-3.5 3.5 3.5",
  down: "m4.5 6.5 3.5 3.5 3.5-3.5",
  close: "m4 4 8 8M12 4l-8 8",
  chevron: "m4.5 6 3.5 3.5L11.5 6",
  code: "m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5",
  graph: "M2.5 8h3M10.5 8h3M5.5 5.5h5v5h-5z",
  split: "M2.5 3h11v10h-11zM8 3v10",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
