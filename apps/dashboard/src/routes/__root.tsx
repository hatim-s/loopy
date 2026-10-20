import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { BrandMark } from "../components/brand-mark.tsx";
import { SHELL_STYLE } from "../components/canvas-page.tsx";
import { ConnectionStatus } from "../components/connection-status.tsx";
import { DaemonIndicator } from "../components/daemon-indicator.tsx";
import { RouteError } from "../components/error-banner.tsx";
import { InboxLink } from "../components/inbox/inbox-link.tsx";
import { LoopySwitcher } from "../components/loopy-switcher.tsx";
import { useSessionStream } from "../lib/connection.ts";
import type { RouterContext } from "../router-context.ts";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Shell,
  errorComponent: RouteError,
  notFoundComponent: () => <p className="page text-muted">Nothing lives at this address.</p>,
});

/**
 * Every page shares one floating bar. Graph pages fill the viewport underneath it; document
 * pages scroll beneath it on the same board.
 */
function Shell() {
  useSessionStream();

  return (
    <div className="relative h-full" style={SHELL_STYLE}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-panel focus:px-3 focus:py-1.5"
      >
        Skip to content
      </a>
      <header className="pointer-events-none absolute inset-x-(--gap) top-(--gap) z-30 flex h-(--bar-h) items-start justify-between gap-2">
        <nav
          aria-label="Primary"
          className="float pointer-events-auto flex h-full min-w-0 items-center gap-0.5 overflow-x-auto px-1"
        >
          <Link
            to="/"
            className="flex h-7 shrink-0 items-center gap-2 rounded-md pr-2.5 pl-1.5 font-semibold tracking-tight hover:bg-raised"
            aria-label="loopy overview"
          >
            <BrandMark className="size-5" />
            <span className="max-sm:sr-only">loopy</span>
          </Link>
          <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />
          <Link
            to="/"
            className="tab shrink-0"
            activeOptions={{ exact: true, includeSearch: false }}
            activeProps={{ className: "bg-raised text-ink" }}
          >
            Overview
          </Link>
          <LoopySwitcher />
          <InboxLink />
          <Link
            to="/schedules"
            className="tab shrink-0"
            activeProps={{ className: "bg-raised text-ink" }}
          >
            Schedules
          </Link>
        </nav>
        <div className="float pointer-events-auto flex h-full shrink-0 items-center gap-0.5 px-1">
          <ConnectionStatus />
          <DaemonIndicator />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="h-full overflow-y-auto focus:outline-none">
        <Outlet />
      </main>
    </div>
  );
}
