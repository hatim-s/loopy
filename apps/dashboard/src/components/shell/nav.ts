import type { IconName } from "../ui/icon";

/** The sections, in sidebar order. The sidebar and the breadcrumbs both read this table. */
export const NAV = [
  { to: "/", label: "Overview", icon: "overview" },
  { to: "/loopies", label: "Loopies", icon: "loopies" },
  { to: "/runs", label: "Runs", icon: "runs" },
  { to: "/observability", label: "Logs and events", icon: "logs" },
  { to: "/schedules", label: "Schedules", icon: "schedules" },
] as const satisfies readonly { to: string; label: string; icon: IconName }[];

export type NavItem = (typeof NAV)[number];

export type NavPath = NavItem["to"];
