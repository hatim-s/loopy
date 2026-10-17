import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LoopyView } from "loopy/contract";
import { loopiesQuery } from "../lib/queries.ts";
import { useBackend } from "../router-context.ts";
import { ErrorBanner } from "./error-banner.tsx";
import { StatusBadge } from "./status-badge.tsx";

function LoopyItem({ loopy }: { loopy: LoopyView }) {
  return (
    <Link
      to="/loopies/$slug"
      params={{ slug: loopy.slug }}
      className="flex flex-col gap-0.5 rounded-md px-2.5 py-2 hover:bg-raised"
      activeProps={{ className: "bg-raised" }}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">{loopy.slug}</span>
        {loopy.lastRun && <StatusBadge status={loopy.lastRun.status} />}
      </span>
      {loopy.description && (
        <span className="line-clamp-2 text-xs text-muted">{loopy.description}</span>
      )}
    </Link>
  );
}

export function LoopyRail() {
  const loopies = useQuery(loopiesQuery(useBackend()));

  return (
    <nav aria-labelledby="rail-heading" className="space-y-2 p-3">
      <h2 id="rail-heading" className="px-2.5 text-xs text-muted">
        Loopies
      </h2>
      {loopies.error && <ErrorBanner error={loopies.error} />}
      {loopies.data?.length === 0 && (
        <p className="px-2.5 text-xs text-muted">
          Save one with <code className="font-mono">loopy save &lt;file.ts&gt;</code>.
        </p>
      )}
      <ul className="space-y-0.5">
        {loopies.data?.map((loopy) => (
          <li key={loopy.slug}>
            <LoopyItem loopy={loopy} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
