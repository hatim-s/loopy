import { Link, useMatches } from "@tanstack/react-router";
import { shortId } from "../../lib/format";
import { NAV, type NavPath } from "./nav";

type Crumb = { label: string; to?: NavPath };

function section(routeId: string): Crumb {
  const item = NAV.find(({ to }) => routeId === to || routeId === `${to}/`) ?? NAV[0];

  return { label: item.label, to: item.to };
}

function useTrail(): Crumb[] {
  const match = useMatches({ select: (matches) => matches.at(-1) });

  if (match?.routeId === "/runs/$runId") {
    return [section("/runs"), { label: `Run ${shortId(match.params.runId)}` }];
  }

  if (match?.routeId === "/loopies/$slug") {
    return [section("/loopies"), { label: match.params.slug }];
  }

  return [{ label: section(match?.routeId ?? "/").label }];
}

export function Crumbs() {
  const trail = useTrail();

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 whitespace-nowrap text-muted">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;

          return (
            <li key={crumb.label} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden="true" className="text-faint">
                  /
                </span>
              )}
              {crumb.to && !last ? (
                <Link to={crumb.to} className="text-muted hover:text-ink">
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className="truncate text-ink">
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
