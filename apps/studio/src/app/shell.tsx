import {
  CaretDoubleLeft,
  CaretDoubleRight,
  GearSix,
  GitBranch,
  Graph,
  HardDrives,
  ListDashes,
  PlayCircle,
  PlugsConnected,
  Pulse,
  TerminalWindow,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type PropsWithChildren, type ReactNode, useId, useState } from "react";
import { BrandMark } from "../components/primitives/brand-mark";
import { IconButton } from "../components/primitives/icon-button";
import { ProjectSwitcher } from "../features/builder/project-switcher";
import type { ApiClient } from "./api";

type NavItem = { to: string; label: string; icon: ReactNode; section: string };
const navItems: NavItem[] = [
  { to: "/sessions", label: "Sessions", icon: <TerminalWindow />, section: "Inspect" },
  { to: "/runs", label: "Runs", icon: <PlayCircle />, section: "Inspect" },
  { to: "/extractions", label: "Extractions", icon: <Graph />, section: "Inspect" },
  { to: "/workflows", label: "Graphs", icon: <GitBranch />, section: "Build" },
  { to: "/providers", label: "Providers", icon: <PlugsConnected />, section: "Build" },
  { to: "/settings", label: "Settings", icon: <GearSix />, section: "System" },
];

export function StudioShell({ children, api }: PropsWithChildren<{ api?: ApiClient }>) {
  const [collapsed, setCollapsed] = useState(false);
  const mainId = `main-${useId().replaceAll(":", "")}`;
  const sections = [...new Set(navItems.map((item) => item.section))];
  return (
    <div className={`studio-shell${collapsed ? " studio-shell--collapsed" : ""}`}>
      <a className="skip-link" href={`#${mainId}`}>
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Studio navigation">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <BrandMark />
          </div>
          <div className="brand-copy">
            <span className="brand-name">Loopy</span>
            <span className="brand-product">Graph Harness</span>
          </div>
        </div>
        <nav aria-label="Studio navigation" className="primary-nav">
          {sections.map((section) => (
            <div className="nav-group" key={section}>
              <div className="nav-group__label">{section}</div>
              {navItems
                .filter((item) => item.section === section)
                .map((item) => (
                  <Link
                    activeProps={{ className: "nav-link nav-link--active" }}
                    aria-label={item.label}
                    className="nav-link"
                    title={item.label}
                    key={item.to}
                    to={item.to}
                  >
                    <span className="nav-link__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="nav-link__label">{item.label}</span>
                  </Link>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="workspace-chip">
            <span className="workspace-chip__avatar">L</span>
            <span className="workspace-chip__copy">
              <strong>Local workspace</strong>
              <small>Project storage</small>
            </span>
          </div>
          <IconButton
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="sidebar-toggle"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <CaretDoubleRight /> : <CaretDoubleLeft />}
          </IconButton>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          {api ? (
            <ProjectSwitcher api={api} />
          ) : (
            <div className="topbar__context">
              <span className="topbar__path">workspace</span>
              <span className="topbar__slash">/</span>
              <span className="topbar__current">local graph harness</span>
            </div>
          )}
          <div className="topbar__actions">
            <span className="topbar__local">
              <span className="status-dot status-dot--ok" /> Local workspace
            </span>
          </div>
        </header>
        <main className="main-content" id={mainId}>
          {children}
        </main>
        <output className="status-strip" aria-label="Runtime status">
          <span className="status-strip__item">
            <Pulse weight="bold" aria-hidden="true" /> Bun runtime
          </span>
          <span className="status-strip__divider" aria-hidden="true" />
          <span className="status-strip__item">
            <HardDrives aria-hidden="true" /> Local only
          </span>
          <span className="status-strip__spacer" />
          <span className="status-strip__item status-strip__item--muted">
            <ListDashes aria-hidden="true" /> Persistent run history
          </span>
        </output>
      </div>
    </div>
  );
}
