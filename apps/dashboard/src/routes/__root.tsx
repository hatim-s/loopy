import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { BrandMark } from "../components/brand-mark.tsx";
import { ConnectionStatus } from "../components/connection-status.tsx";
import { RouteError } from "../components/error-banner.tsx";
import { LoopyRail } from "../components/loopy-rail.tsx";
import type { RouterContext } from "../router-context.ts";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Shell,
  errorComponent: RouteError,
  notFoundComponent: () => <p className="p-6 text-muted">Nothing lives at this address.</p>,
});

function Shell() {
  return (
    <div className="grid h-full grid-rows-[2.75rem_minmax(0,1fr)]">
      <header className="flex items-center justify-between border-b border-line px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <BrandMark className="size-5 text-active" />
          loopy
        </Link>
        <ConnectionStatus />
      </header>
      <div className="grid min-h-0 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden overflow-y-auto border-r border-line md:block">
          <LoopyRail />
        </aside>
        <main className="overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
