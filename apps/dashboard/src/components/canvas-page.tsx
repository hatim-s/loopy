import { type ReactNode, useId, useMemo, useState } from "react";

type Px = `${number}px`;

export function px(value: number): Px {
  return `${value}px`;
}

/**
 * Shell geometry in pixels. The shell sets these as CSS variables, so stylesheets and the
 * graph's fit padding read the same numbers.
 */
export const SHELL = { bar: 40, gap: 12, side: 352, inspector: 384, controls: 36 } as const;

export const SHELL_STYLE: Record<`--${string}`, Px> = {
  "--bar-h": px(SHELL.bar),
  "--gap": px(SHELL.gap),
  "--side-w": px(SHELL.side),
  "--inspector-w": px(SHELL.inspector),
};

/** Below this width the side panel opens collapsed, so the graph is visible first. */
const NARROW = "(max-width: 767px)";

export type CanvasFrame = {
  /** Fit padding that keeps the graph clear of the bar, the side panel and the controls. */
  padding: Record<"top" | "right" | "bottom" | "left", Px>;
};

function framePadding(sideOpen: boolean): CanvasFrame["padding"] {
  const clear = SHELL.gap * 2;
  const wide = sideOpen && !window.matchMedia(NARROW).matches;

  return {
    top: px(SHELL.bar + SHELL.gap + clear),
    left: px(wide ? SHELL.side + SHELL.gap + clear : clear),
    right: px(clear),
    bottom: px(SHELL.controls + SHELL.gap + clear),
  };
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/**
 * A full-bleed graph page. The canvas fills the viewport and the page's context floats over it
 * in a side panel that collapses to its header.
 */
export function CanvasPage(props: {
  label: string;
  header: ReactNode;
  body: ReactNode;
  children: (frame: CanvasFrame) => ReactNode;
}) {
  const { label, header, body, children } = props;
  const [open, setOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const bodyId = useId();
  // Stable per open state, so the memoized canvas skips the page's one-second clock.
  const frame = useMemo(() => ({ padding: framePadding(open) }), [open]);

  return (
    <div className="absolute inset-0">
      {children(frame)}
      <aside
        aria-label={label}
        className="float absolute top-[calc(var(--bar-h)+var(--gap)*2)] left-(--gap) z-10 flex max-h-[calc(100%-var(--bar-h)-var(--gap)*3)] w-[min(var(--side-w),calc(100%-var(--gap)*2))] flex-col overflow-hidden"
      >
        <div className="flex items-start gap-2 p-3 pb-2.5">
          <div className="min-w-0 flex-1">{header}</div>
          <button
            type="button"
            className="icon-button -mt-0.5 -mr-1"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={open ? "Collapse panel" : "Expand panel"}
            onClick={() => setOpen(!open)}
          >
            <ChevronIcon open={open} />
          </button>
        </div>
        <div
          id={bodyId}
          hidden={!open}
          className="min-h-0 flex-1 overflow-y-auto border-t border-line"
        >
          {body}
        </div>
      </aside>
    </div>
  );
}

/** A message centred on an empty canvas, for a graph that is loading or failed to load. */
export function CanvasMessage({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="float max-w-sm px-4 py-3 text-muted">{children}</div>
    </div>
  );
}
