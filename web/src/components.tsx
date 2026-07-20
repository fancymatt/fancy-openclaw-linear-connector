import type { ReactNode } from "react";
import { Heading, Nav as SharedNav, Text } from "@fancyfleet/components";
import { NavLink } from "react-router-dom";
import type { Severity } from "./types";

export function Chip({ tone, children }: { tone: Severity | "blue" | string; children: ReactNode }) {
  const cls = ["green", "yellow", "red", "gray", "blue"].includes(tone) ? tone : "gray";
  return <span className={`chip ${cls}`}>{children}</span>;
}

export function Card({ span = 12, title, children }: { span?: 4 | 6 | 8 | 12; title?: ReactNode; children: ReactNode }) {
  return (
    <section className={`card span-${span}`}>
      {title !== undefined && <Heading level={2} size="sm" className="card-heading">{title}</Heading>}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Text as="div" tone="muted" className="empty">{children}</Text>;
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <Text as="div" tone="danger" className="error-banner">API error: {message}</Text>;
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
  const items = TABS.map(([to, label]) => ({
    to,
    label,
    badge: to === "/proposals" && pendingProposals > 0 ? pendingProposals : undefined,
    badgeTestId: to === "/proposals" ? "nav-pending-badge" : undefined,
  }));

  return (
    <SharedNav
      ariaLabel="Connector console"
      className="tabs"
      items={items}
      renderLink={(item, className, children) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) => [className, isActive ? "active" : ""].filter(Boolean).join(" ")}
        >
          {children}
        </NavLink>
      )}
    />
  );
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: "red" | "yellow" | "green" }) {
  return (
    <div className="stat">
      <Text as="div" size="lg" className="value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</Text>
      <Text as="div" tone="muted" size="sm" className="label">{label}</Text>
    </div>
  );
}
