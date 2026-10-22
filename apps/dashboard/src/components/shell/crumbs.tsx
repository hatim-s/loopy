import { Link, useRouterState } from "@tanstack/react-router";
import { shortId } from "../../lib/format.ts";

type Crumb = { label: string; to?: "/loopies" | "/runs" };

const SECTION = {
  loopies: { label: "Loopies", to: "/loopies" },
  runs: { label: "Runs", to: "/runs" },
  observability: { label: "Logs and events" },
  schedules: { label: "Schedules" },
} as const satisfies Record<string, Crumb>;

function isSection(name: string): name is keyof typeof SECTION {
  return Object.hasOwn(SECTION, name);
}

/** The top bar's trail, read from the path: section, then the loopy or run. */
function crumbs(pathname: string): Crumb[] {
  const [section = "", id] = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (!isSection(section)) {
    return [{ label: "Overview" }];
  }

  const head = SECTION[section];

  if (id === undefined) {
    return [{ label: head.label }];
  }

  return [head, { label: section === "runs" ? `Run ${shortId(id)}` : id }];
}

export function Crumbs() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const trail = crumbs(pathname);

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
