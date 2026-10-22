import type { LogRecord, NodeRunView, RunStatus, RunView } from "loopy/contract";
import type { ReactNode } from "react";

/**
 * Every state a pill can name. Runs, node executions and schedules share one vocabulary, so a
 * failed run and a failed node read the same everywhere. `awaiting` is a suspended run held on
 * a hook; `sleeping` is one held on a clock.
 */
export type Status =
  | Exclude<RunStatus, "suspended">
  | NodeRunView["status"]
  | "awaiting"
  | "suspended"
  | "active"
  | "paused";

type Tone = "ok" | "bad" | "warn" | "blue" | "neutral";

type Glyph =
  | "succeeded"
  | "failed"
  | "running"
  | "ring"
  | "cancelled"
  | "hourglass"
  | "retrying"
  | "paused"
  | "active";

const STATUS = {
  succeeded: { tone: "ok", glyph: "succeeded", word: "Succeeded" },
  failed: { tone: "bad", glyph: "failed", word: "Failed" },
  running: { tone: "blue", glyph: "running", word: "Running" },
  queued: { tone: "neutral", glyph: "ring", word: "Queued" },
  cancelled: { tone: "neutral", glyph: "cancelled", word: "Cancelled" },
  skipped: { tone: "neutral", glyph: "cancelled", word: "Skipped" },
  awaiting: { tone: "warn", glyph: "hourglass", word: "Awaiting" },
  waiting: { tone: "warn", glyph: "hourglass", word: "Waiting" },
  sleeping: { tone: "warn", glyph: "hourglass", word: "Sleeping" },
  suspended: { tone: "neutral", glyph: "paused", word: "Suspended" },
  rate_limited: { tone: "warn", glyph: "hourglass", word: "Rate limited" },
  retrying: { tone: "warn", glyph: "retrying", word: "Retrying" },
  active: { tone: "ok", glyph: "active", word: "Active" },
  paused: { tone: "neutral", glyph: "paused", word: "Paused" },
} as const satisfies Record<Status, { tone: Tone; glyph: Glyph; word: string }>;

/**
 * A suspended run is awaiting a person when it holds a hook, sleeping when a clock will wake it,
 * and plainly suspended when neither holds it.
 */
export function runStatus(run: RunView): Status {
  if (run.status === "suspended") {
    if (run.waitingOn !== null) {
      return "awaiting";
    }

    return run.wakeAt === null ? "suspended" : "sleeping";
  }

  return run.status;
}

export function statusWord(status: Status): string {
  return STATUS[status].word;
}

export function statusTone(status: Status): Tone {
  return STATUS[status].tone;
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Ring() {
  return <circle cx="6" cy="6" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.3" />;
}

const GLYPHS = {
  succeeded: (
    <>
      <Ring />
      <path d="M3.7 6.2 5.3 7.7 8.4 4.5" {...STROKE} />
    </>
  ),
  failed: (
    <>
      <Ring />
      <path d="M4.3 4.3 7.7 7.7M7.7 4.3 4.3 7.7" {...STROKE} />
    </>
  ),
  running: (
    <>
      <Ring />
      <circle cx="6" cy="6" r="2.7" fill="currentColor" />
    </>
  ),
  ring: <Ring />,
  cancelled: (
    <>
      <Ring />
      <path d="M3.8 6h4.4" {...STROKE} />
    </>
  ),
  hourglass: (
    <path
      d="M3 1.2h6M3 10.8h6M3.8 1.2c0 2.9 4.4 2.6 4.4 4.8S3.8 7.9 3.8 10.8M8.2 1.2c0 2.9-4.4 2.6-4.4 4.8s4.4 1.9 4.4 4.8"
      {...STROKE}
      strokeWidth={1.2}
    />
  ),
  retrying: (
    <>
      <path d="M9.6 4.2A4.2 4.2 0 1 0 10 7" {...STROKE} />
      <path d="M10 1.8v2.6H7.4" {...STROKE} />
    </>
  ),
  paused: (
    <>
      <Ring />
      <path d="M4.8 4v4M7.2 4v4" {...STROKE} />
    </>
  ),
  active: (
    <>
      <Ring />
      <circle cx="6" cy="6" r="2.2" fill="currentColor" />
    </>
  ),
} satisfies Record<Glyph, ReactNode>;

export function StatusGlyph({ status, size = 12 }: { status: Status; size?: number }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      aria-hidden="true"
      className={`shrink-0 ${STATUS[status].tone === "neutral" ? "text-neutral" : ""}`}
    >
      {GLYPHS[STATUS[status].glyph]}
    </svg>
  );
}

/** A tinted pill: glyph plus word. `word` overrides the default, as in "Awaiting approval". */
export function StatusPill({
  status,
  word,
  small = false,
}: {
  status: Status;
  word?: string;
  small?: boolean;
}) {
  return (
    <span className={`pill tone-${STATUS[status].tone} ${small ? "pill-sm" : ""}`}>
      <StatusGlyph status={status} />
      {word ?? STATUS[status].word}
    </span>
  );
}

export function RunPill({ run, small }: { run: RunView; small?: boolean }) {
  return <StatusPill status={runStatus(run)} small={small} />;
}

const LEVEL = {
  info: { tone: "neutral", word: "Info" },
  warn: { tone: "warn", word: "Warn" },
  error: { tone: "bad", word: "Error" },
} as const satisfies Record<LogRecord["level"], { tone: Tone; word: string }>;

export function LevelPill({ level }: { level: LogRecord["level"] }) {
  return (
    <span className={`pill pill-sm pill-plain tone-${LEVEL[level].tone}`}>{LEVEL[level].word}</span>
  );
}

/** The text colour of a status, for marks that are not pills: chart keys, gutter rails. */
export const TONE_TEXT = {
  ok: "text-success",
  bad: "text-danger",
  warn: "text-attention",
  blue: "text-active",
  neutral: "text-neutral",
} as const satisfies Record<Tone, string>;
