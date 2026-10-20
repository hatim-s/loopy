import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { LoopyView } from "loopy/contract";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { useClock } from "../lib/clock.ts";
import { timestamp } from "../lib/format.ts";
import { loopiesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";
import { ErrorBanner } from "./error-banner.tsx";
import { StatusDot } from "./status-badge.tsx";
import { shortAge } from "./time-stamp.tsx";

function LoopyItem(props: { loopy: LoopyView; now: number; onPick: () => void }) {
  const { loopy, now, onPick } = props;
  const { lastRun } = loopy;

  return (
    <Link
      to="/loopies/$slug"
      params={{ slug: loopy.slug }}
      title={loopy.description ?? loopy.slug}
      onClick={onPick}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-muted hover:bg-raised hover:text-ink"
      activeProps={{ className: "bg-raised text-ink" }}
    >
      {lastRun ? (
        <StatusDot status={lastRun.status} />
      ) : (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full border border-line-strong"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{loopy.slug}</span>
      {lastRun && (
        <time
          dateTime={lastRun.createdAt}
          title={`Last run ${lastRun.status}, ${timestamp(lastRun.createdAt)}`}
          className="shrink-0 font-mono text-[11px] text-faint tabular-nums"
        >
          {shortAge(lastRun.createdAt, now)}
        </time>
      )}
      <span className="sr-only">{lastRun ? `, last run ${lastRun.status}` : ", never run"}</span>
    </Link>
  );
}

/** Press / anywhere outside a field to open the switcher with its filter focused. */
function useSlashOpen(popover: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;

      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

      const modified = event.metaKey || event.ctrlKey || event.altKey;

      if (event.key !== "/" || typing || modified || !popover.current) {
        return;
      }

      event.preventDefault();
      popover.current.showPopover();
      popover.current.querySelector("input")?.focus();
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [popover]);
}

/** Every saved loopy, one keystroke away from any page. Enter opens the first match. */
export function LoopySwitcher() {
  const loopies = useQuery(loopiesQuery(useBackend()));
  const [filter, setFilter] = useState("");
  const popover = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const now = useClock();
  const id = useId();
  const needle = filter.trim().toLowerCase();
  useSlashOpen(popover);

  const shown =
    loopies.data?.filter(
      (loopy) =>
        loopy.slug.toLowerCase().includes(needle) ||
        (loopy.description?.toLowerCase().includes(needle) ?? false),
    ) ?? [];

  const close = () => popover.current?.hidePopover();

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        className="tab"
        title="Switch loopy (/)"
        aria-haspopup="dialog"
      >
        Loopies
        {loopies.data && (
          <span className="font-mono text-xs text-faint tabular-nums">{loopies.data.length}</span>
        )}
        <kbd
          aria-hidden="true"
          className="rounded-sm border border-line px-1 font-mono text-[10px] text-faint max-sm:hidden"
        >
          /
        </kbd>
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Loopies"
        className="float fixed inset-auto top-[calc(var(--bar-h)+var(--gap)*1.5)] left-(--gap) m-0 w-[min(20rem,calc(100vw-var(--gap)*2))] p-2 text-ink"
      >
        {loopies.data && loopies.data.length > 0 && (
          <label className="mb-1.5 block">
            <span className="sr-only">Filter loopies</span>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                const first = shown[0];

                if (event.key === "Enter" && first) {
                  close();
                  void navigate({ to: "/loopies/$slug", params: { slug: first.slug } });
                }
              }}
              placeholder="Filter loopies"
              className="h-8 w-full rounded-md border border-line bg-sunken px-2 placeholder:text-faint focus-visible:border-ink focus-visible:outline-none"
            />
          </label>
        )}
        {loopies.error && <ErrorBanner error={loopies.error} />}
        {loopies.data?.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted">
            Save one with <code className="font-mono">loopy save &lt;file.ts&gt;</code>.
          </p>
        )}
        {needle && shown.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted">No loopy matches this filter.</p>
        )}
        <ul className="max-h-[60vh] space-y-px overflow-y-auto">
          {shown.map((loopy) => (
            <li key={loopy.slug}>
              <LoopyItem loopy={loopy} now={now} onPick={close} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
