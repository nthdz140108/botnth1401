import React from "react";
import { DASHBOARD_VIEWS } from "./navigation.js";

function NavButton({ active, label, onClick, badge }) {
  return (
    <button className={active ? "nav-item active" : "nav-item"} aria-current={active ? "page" : undefined} onClick={onClick}>
      <span className="nav-dot" />
      {label}
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
}

export function DashboardShell({ view, title, subtitle, status, updatedAt, user, onRefresh, onNavigate, onLogout, children }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <span>
            <strong>Bot Control</strong>
            <small>OPERATIONS CONSOLE</small>
          </span>
        </div>
        <div className="sidebar-label">Workspace</div>
        <nav className="side-nav">
          {DASHBOARD_VIEWS.map(({ id, label }) => (
            <NavButton
              key={id}
              active={view === id}
              label={label}
              badge={id === "logs" ? "LIVE" : undefined}
              onClick={() => onNavigate(id)}
            />
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="live-dot" />
          Realtime connected
        </div>
      </aside>
      <div className="content-shell">
        <header className="topbar">
          <div>
            <span className="eyebrow">CONTROL CENTER / {String(view).toUpperCase()}</span>
            <h1>{title}</h1>
            <p className="topbar-subtitle">{subtitle}</p>
          </div>
          <div className="topbar-meta">
            {user ? <span className="user-chip">{user}</span> : null}
            <span className="status-chip">
              <span className="live-dot" />
              {status}
            </span>
            <span className="muted">{updatedAt || "Syncing"}</span>
            <button className="secondary" title="Refresh data" aria-label="Refresh data" onClick={onRefresh}>
              Refresh
            </button>
            {onLogout ? <button className="secondary" onClick={onLogout}>Logout</button> : null}
          </div>
        </header>
        <main id="main-content">{children}</main>
      </div>
    </div>
  );
}
