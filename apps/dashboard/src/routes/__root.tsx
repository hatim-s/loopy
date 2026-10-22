import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { RouteError } from "../components/error-banner.tsx";
import { Crumbs } from "../components/shell/crumbs.tsx";
import { DaemonPill } from "../components/shell/daemon-pill.tsx";
import { Sidebar } from "../components/shell/sidebar.tsx";
import { Icon } from "../components/ui/icon.tsx";
import { useSessionStream } from "../lib/connection.ts";
import type { RouterContext } from "../router-context.ts";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Shell,
  errorComponent: RouteError,
  notFoundComponent: () => <p className="content text-muted">Nothing lives at this address.</p>,
});

function Shell() {
  useSessionStream();
  const [drawer, setDrawer] = useState(false);

  return (
    <div className="flex min-h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-panel focus:px-3 focus:py-1.5"
      >
        Skip to content
      </a>
      <Sidebar open={drawer} onClose={() => setDrawer(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-(--head-h) shrink-0 items-center gap-4 border-b border-line bg-page/90 px-8 backdrop-blur-sm max-md:px-4">
          <button
            type="button"
            className="icon-btn md:hidden"
            aria-label="Open navigation"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Icon name="menu" />
          </button>
          <Crumbs />
          <div className="ml-auto">
            <DaemonPill />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col focus:outline-none">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
