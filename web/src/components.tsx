import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { Severity } from "./types";

export function Chip({ tone, children }: { tone: Severity | "blue" | string; children: ReactNode }) {
  const cls = ["green", "yellow", "red", "gray", "blue"].includes(tone) ? tone : "gray";
  return <span className={`chip ${cls}`}>{children}</span>;
}

export function Card({ span = 12, title, children }: { span?: 4 | 6 | 8 | 12; title?: ReactNode; children: ReactNode }) {
  return (
    <section className={`card span-${span}`}>
      {title !== undefined && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-banner">API error: {message}</div>;
}

export function Diagnostics({ value, label = "Raw diagnostics" }: { value: unknown; label?: string }) {
  return (
    <details>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

const TABS: Array<[string, string]> = [
  ["/", "Overview"],
  ["/fleet", "Fleet"],
  ["/board", "Board"],
  ["/tasks", "Tasks"],
  ["/events", "Events"],
  ["/alerts", "Alerts"],
  ["/workflows", "Workflows"],
  ["/dead-letters", "Dead Letters"],
];

export function Tabs() {
  return (
    <nav className="tabs">
      {TABS.map(([to, label]) => (
        <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: "red" | "yellow" | "green" }) {
  return (
    <div className="stat">
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}
