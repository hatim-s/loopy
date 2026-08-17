import {
  BracketsCurly,
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
import { IconButton } from "../components/primitives/icon-button";

type NavItem = { to: string; label: string; icon: ReactNode; section: string };
const navItems: NavItem[] = [
  { to: "/sessions", label: "Sessions", icon: <TerminalWindow />, section: "Inspect" },
  { to: "/runs", label: "Runs", icon: <PlayCircle />, section: "Inspect" },
  { to: "/extractions", label: "Extractions", icon: <Graph />, section: "Inspect" },
  { to: "/workflows", label: "Workflows", icon: <GitBranch />, section: "Build" },
  { to: "/providers", label: "Providers", icon: <PlugsConnected />, section: "Build" },
  { to: "/settings", label: "Settings", icon: <GearSix />, section: "System" },
];

export function StudioShell({ children }: PropsWithChildren) {
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
            <BracketsCurly weight="bold" />
          </div>
          <div className="brand-copy">
            <span className="brand-name">Loopy</span>
            <span className="brand-product">Studio</span>
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
                    className="nav-link"
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
              <small>Connected</small>
            </span>
            <span className="status-dot status-dot--ok" aria-hidden="true" />
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
          <div className="topbar__context">
            <span className="topbar__path">workspace</span>
            <span className="topbar__slash">/</span>
            <span className="topbar__current">local debugger</span>
          </div>
          <div className="topbar__actions">
            <span className="topbar__hint">⌘ K to search</span>
            <span className="topbar__version">v0.1.0</span>
          </div>
        </header>
        <main className="main-content" id={mainId}>
          {children}
        </main>
        <output className="status-strip" aria-label="Runtime status">
          <span className="status-strip__item">
            <Pulse weight="bold" aria-hidden="true" /> Runtime idle
          </span>
          <span className="status-strip__divider" aria-hidden="true" />
          <span className="status-strip__item">
            <HardDrives aria-hidden="true" /> Local only
          </span>
          <span className="status-strip__spacer" />
          <span className="status-strip__item status-strip__item--muted">
            <ListDashes aria-hidden="true" /> No active trace
          </span>
        </output>
      </div>
      <aside className="inspector-pane" aria-label="Trace inspector">
        <div className="inspector-pane__header">
          <span>Trace inspector</span>
          <span className="inspector-pane__count">0</span>
        </div>
        <div className="inspector-pane__empty">
          <Pulse size={18} aria-hidden="true" />
          <strong>No active trace</strong>
          <span>Start a session to inspect events, providers, and workflow state.</span>
        </div>
      </aside>
    </div>
  );
}
