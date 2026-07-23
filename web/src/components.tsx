import type { ReactNode } from "react";
import { Heading, Nav, Text } from "@fancyfleet/components";
import { NavLink } from "react-router-dom";
import type { Severity } from "./types";

export function Chip({ tone, children }: { tone: Severity | "blue" | string; children: ReactNode }) {
  const cls = ["green", "yellow", "red", "gray", "blue"].includes(tone) ? tone : "gray";
  return <span className={`chip ${cls}`}>{children}</span>;
}

export function Card({ span = 12, title, children }: { span?: 4 | 6 | 8 | 12; title?: ReactNode; children: ReactNode }) {
  return (
    <section className={`card span-${span}`}>
      {title !== undefined && <Heading as="h2" className="card-heading">{title}</Heading>}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Text className="empty">{children}</Text>;
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <Text className="error-banner">API error: {message}</Text>;
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
  ["/proposals", "Proposals"],
  ["/dead-letters", "Dead Letters"],
  ["/stalls", "Stalls"],
  ["/webhooks", "Webhooks"],
];

export function Tabs({ pendingProposals = 0 }: { pendingProposals?: number } = {}) {
  return (
    <Nav>
      {TABS.map(([to, label]) => (
        <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
          {label}
          {to === "/proposals" && pendingProposals > 0 && (
            <span className="nav-pending-badge" data-testid="nav-pending-badge">
              {pendingProposals}
            </span>
          )}
        </NavLink>
      ))}
    </Nav>
  );
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: "red" | "yellow" | "green" }) {
  const toneMap: Record<string, string> = {
    red: "var(--color-error)",
    yellow: "var(--color-warning)",
    green: "var(--color-success)",
  };
  return (
    <div className="stat">
      <Text className="value" style={tone ? { color: toneMap[tone] } : undefined}>{value}</Text>
      <Text className="label">{label}</Text>
    </div>
  );
}
