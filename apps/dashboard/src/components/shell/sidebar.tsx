import { Link } from "@tanstack/react-router";
import { useLoopyRows, useRunPages, useScheduleOverview } from "../../lib/ui-data.ts";
import { BrandMark } from "../brand-mark.tsx";
import { Icon, type IconName } from "../ui/icon.tsx";

// The awaiting count reads one page; past it the sidebar says "20+" rather than guess.
const AWAITING_PAGE = 20;

function Count({ value, warn = false }: { value: string | null; warn?: boolean }) {
  return value === null ? null : (
    <span
      className={`ml-auto text-xs font-medium tabular-nums max-xl:hidden ${warn ? "text-attention" : "text-muted"}`}
    >
      {value}
    </span>
  );
}

function NavItem(props: {
  to: "/" | "/loopies" | "/runs" | "/observability" | "/schedules";
  icon: IconName;
  label: string;
  count?: string | null;
  warn?: boolean;
  onNavigate: () => void;
}) {
  const { to, icon, label, count = null, warn, onNavigate } = props;

  return (
    <Link
      to={to}
      onClick={onNavigate}
      activeOptions={{ exact: to === "/", includeSearch: false }}
      className="flex h-8 items-center gap-2.5 rounded-control px-2.5 font-medium text-muted hover:bg-hover hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:text-ink max-xl:justify-center max-xl:px-0 max-md:justify-start max-md:px-2.5"
      title={label}
    >
      <Icon name={icon} />
      <span className="max-xl:sr-only max-md:not-sr-only">{label}</span>
      <Count value={count} warn={warn} />
    </Link>
  );
}

/**
 * Navigation with live counts. Below 1280px it narrows to an icon rail; below 768px it hides
 * behind the top bar's menu button and opens as a drawer.
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const loopies = useLoopyRows();
  const schedules = useScheduleOverview();
  const awaiting = useRunPages({ status: "suspended", waiting: true }, AWAITING_PAGE);

  const awaitingCount =
    awaiting.state === "ready" && awaiting.data.rows.length > 0
      ? `${awaiting.data.rows.length}${awaiting.data.hasNext ? "+" : ""}`
      : null;

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-page/60 md:hidden"
        />
      )}
      <aside
        className={`sticky top-0 z-40 flex h-screen w-(--side-w) shrink-0 flex-col border-r border-line bg-page max-xl:w-16 max-md:fixed max-md:w-[240px] max-md:transition-transform ${open ? "" : "max-md:-translate-x-full"}`}
      >
        <Link
          to="/"
          onClick={onClose}
          className="flex h-(--head-h) shrink-0 items-center gap-2 px-[18px] text-[15px] font-semibold tracking-[-0.01em] text-ink hover:text-ink max-xl:justify-center max-xl:px-0 max-md:justify-start max-md:px-[18px]"
        >
          <BrandMark className="size-[18px] text-lamp" />
          <span className="max-xl:sr-only max-md:not-sr-only">loopy</span>
        </Link>
        <nav aria-label="Primary" className="grid gap-0.5 px-2.5 py-1">
          <NavItem to="/" icon="overview" label="Overview" onNavigate={onClose} />
          <NavItem
            to="/loopies"
            icon="loopies"
            label="Loopies"
            count={loopies.state === "ready" ? String(loopies.data.length) : null}
            onNavigate={onClose}
          />
          <NavItem
            to="/runs"
            icon="runs"
            label="Runs"
            count={awaitingCount}
            warn
            onNavigate={onClose}
          />
          <NavItem to="/observability" icon="logs" label="Logs and events" onNavigate={onClose} />
          <NavItem
            to="/schedules"
            icon="schedules"
            label="Schedules"
            count={schedules.state === "ready" ? String(schedules.data.active) : null}
            onNavigate={onClose}
          />
        </nav>
        {awaitingCount !== null && (
          <p className="mt-auto border-t border-line px-[18px] py-3 text-xs text-muted max-xl:hidden max-md:block">
            <Link to="/runs" search={{ status: "awaiting" }} onClick={onClose}>
              {awaitingCount} {awaitingCount === "1" ? "run awaits" : "runs await"} you
            </Link>
          </p>
        )}
      </aside>
    </>
  );
}
