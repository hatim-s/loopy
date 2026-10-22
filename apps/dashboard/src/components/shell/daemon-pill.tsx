import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { BackendError } from "../../backend/backend.ts";
import { useClock } from "../../lib/clock.ts";
import { type ConnectionState, useConnectionState } from "../../lib/connection.ts";
import { shortId, span, timestamp } from "../../lib/format.ts";
import { useDaemon } from "../../lib/ui-data.ts";
import type { DaemonDetail } from "../../lib/view-models.ts";

const STREAM = {
  idle: { word: "Starting", dot: "bg-neutral", note: "The event stream has not opened yet." },
  connecting: { word: "Connecting", dot: "bg-neutral", note: "Opening the event stream." },
  live: { word: "Live", dot: "bg-success", note: "Changes appear as the daemon records them." },
  reconnecting: {
    word: "Reconnecting",
    dot: "bg-attention",
    note: "The event stream dropped. Retrying, then catching up from the last event.",
  },
  stale: {
    word: "Stale",
    dot: "bg-danger",
    note: "The event stream stopped. What you see may be out of date. Reload to reconnect.",
  },
} as const satisfies Record<ConnectionState, { word: string; dot: string; note: string }>;

function isUnreachable(error: Error): boolean {
  return error instanceof BackendError && error.code === "unreachable";
}

/** One bar per worker slot, filled while a run holds it. Wide pools show only the numbers. */
function SlotBars({ running, concurrency }: { running: number; concurrency: number }) {
  if (concurrency > 8) {
    return null;
  }

  return (
    <span aria-hidden="true" className="flex gap-[2px]">
      {[...Array(concurrency).keys()].map((slot) => (
        <i
          key={slot}
          className={`h-2.5 w-1 rounded-[1px] ${slot < running ? "bg-lamp" : "bg-line-strong"}`}
        />
      ))}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 tabular-nums">{children}</dd>
    </>
  );
}

function DaemonFacts({ daemon, now }: { daemon: DaemonDetail; now: number }) {
  return (
    <>
      <section className="border-b border-line px-4 py-3">
        <p className="mb-2 flex justify-between text-xs text-muted">
          Worker slots
          <b className="font-medium text-ink tabular-nums">
            {daemon.running} of {daemon.concurrency} busy
          </b>
        </p>
        {daemon.slots === null ? (
          <p className="text-xs text-faint">
            This daemon reports how many slots are busy, not which run holds each one.
          </p>
        ) : (
          <ol className="grid gap-1">
            {daemon.slots.map((slot) => (
              <li
                key={slot.runId}
                className="flex h-[26px] items-center gap-2 rounded-control bg-sunken px-2 text-xs"
              >
                <Link
                  to="/runs/$runId"
                  params={{ runId: slot.runId }}
                  className="min-w-0 flex-1 truncate text-ink hover:text-active"
                >
                  {slot.slug} <span className="font-mono text-muted">{shortId(slot.runId)}</span>
                </Link>
                <span className="text-muted tabular-nums">
                  {span(now - Date.parse(slot.since))}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <dl className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 text-xs">
        <Row label="Process">
          <span className="font-mono">pid {daemon.pid}</span>
        </Row>
        <Row label="Up for">
          <span title={timestamp(daemon.startedAt)}>
            {span(now - Date.parse(daemon.startedAt))}
          </span>
        </Row>
        <Row label="Next wake">
          {daemon.nextWakeAt === null ? (
            <span className="text-muted">No run waits on a timer</span>
          ) : (
            <span title={timestamp(daemon.nextWakeAt)}>
              {Date.parse(daemon.nextWakeAt) > now
                ? `in ${span(Date.parse(daemon.nextWakeAt) - now)}`
                : "due now"}
            </span>
          )}
        </Row>
      </dl>
    </>
  );
}

/**
 * The top bar's daemon pill: stream state, slot use and running count at a glance. It opens a
 * dialog with the daemon's facts. Escape or a click outside closes it and focus returns here.
 */
export function DaemonPill() {
  const daemon = useDaemon();
  const stream = STREAM[useConnectionState()];
  const now = useClock();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };

    const onPointer = (event: PointerEvent) => {
      const target = event.target;

      if (
        target instanceof Node &&
        !panel.current?.contains(target) &&
        !button.current?.contains(target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const offline = daemon.state === "error" && isUnreachable(daemon.error);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="inline-flex h-7 cursor-pointer items-center gap-[7px] rounded-full border border-line-strong bg-panel pr-2.5 pl-[9px] text-xs font-medium whitespace-nowrap hover:bg-raised aria-expanded:bg-raised"
      >
        <span
          aria-hidden="true"
          className={`size-[7px] rounded-full ${offline ? "bg-danger" : stream.dot}`}
        />
        {offline ? "Daemon offline" : stream.word}
        {daemon.state === "ready" && (
          <>
            <span aria-hidden="true" className="h-3 w-px bg-line-strong" />
            <SlotBars running={daemon.data.running} concurrency={daemon.data.concurrency} />
            <span className="font-normal text-muted tabular-nums">
              {daemon.data.running}/{daemon.data.concurrency}
              <span className="sr-only"> worker slots busy</span>
            </span>
          </>
        )}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label="Daemon"
          className="popover top-[calc(100%+8px)] right-0 w-[360px] max-w-[calc(100vw-24px)]"
        >
          <header className="flex items-center gap-2.5 border-b border-line px-4 pt-3.5 pb-3">
            <span
              aria-hidden="true"
              className={`size-[7px] rounded-full ${offline ? "bg-danger" : stream.dot}`}
            />
            <h2>{offline ? "Daemon not reachable" : `Daemon ${stream.word.toLowerCase()}`}</h2>
          </header>
          {daemon.state === "ready" && <DaemonFacts daemon={daemon.data} now={now} />}
          {daemon.state === "loading" && (
            <p className="px-4 py-3 text-xs text-muted">Asking the daemon.</p>
          )}
          {daemon.state === "error" && (
            <p className="border-b border-line px-4 py-3 text-xs text-danger">
              {offline ? (
                <>
                  Start it with <code className="text-ink">loopy daemon run</code>, then reload.
                </>
              ) : (
                daemon.error.message
              )}
            </p>
          )}
          <p className="border-b border-line px-4 py-3 text-xs text-muted">{stream.note}</p>
          <footer className="flex gap-2 px-4 py-3">
            <Link
              to="/runs"
              search={{ status: "running" }}
              className="btn btn-sm"
              onClick={() => setOpen(false)}
            >
              Running runs
            </Link>
            <Link to="/observability" className="btn btn-sm" onClick={() => setOpen(false)}>
              Logs and events
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}
