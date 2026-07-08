import { useState } from "react";
import { apiGet } from "../api";
import { usePoll, ageLabel } from "../hooks";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { Card, Chip, Diagnostics, Empty, ErrorBanner } from "../components";
import type { AlertRow } from "../types";

const SEVERITIES = ["all", "critical", "warning", "info"] as const;

export function AlertsPage() {
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("all");
  const query = new URLSearchParams({ limit: "100" });
  if (severity !== "all") query.set("severity", severity);

  const alerts = usePoll(() => apiGet<{ alerts: AlertRow[] }>(`/admin/api/alerts?${query.toString()}`), 10000);
  useLiveRefresh({ onAlerts: alerts.refresh });

  return (
    <>
      <ErrorBanner message={alerts.error} />
      <div className="grid">
        <Card span={12} title="Alert history (alerts.db)">
          <div className="filters">
            {SEVERITIES.map((s) => (
              <button key={s} className={severity === s ? "primary" : ""} onClick={() => setSeverity(s)}>
                {s}
              </button>
            ))}
            <span className="muted">{alerts.data?.alerts.length ?? 0} row(s) · bursts fold into one row with ×count</span>
          </div>
          {alerts.data?.alerts.length ? (
            <table>
              <thead>
                <tr><th>Severity</th><th>Alert</th><th>Scope</th><th>Last seen</th><th>Delivery</th></tr>
              </thead>
              <tbody>
                {alerts.data.alerts.map((a) => (
                  <tr key={a.id}>
                    <td><Chip tone={a.severity === "critical" ? "red" : a.severity === "warning" ? "yellow" : "gray"}>{a.severity}</Chip></td>
                    <td>
                      <div className="row-title">{a.title}{a.count > 1 ? ` ×${a.count}` : ""}</div>
                      <div className="muted">[{a.source}]</div>
                      {a.detail != null && <Diagnostics value={a.detail} label="detail" />}
                    </td>
                    <td className="muted">
                      {a.agent && <div>agent: {a.agent}</div>}
                      {a.ticket && <div className="mono">{a.ticket}</div>}
                      {!a.agent && !a.ticket && "—"}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {ageLabel(a.lastAt)}
                      {a.count > 1 && <div>first {ageLabel(a.firstAt)}</div>}
                    </td>
                    <td className="muted">
                      {a.pushedAt ? <Chip tone="green">pushed</Chip> : <Chip tone="gray">stored</Chip>}
                      {a.pushedVia && <div>{a.pushedVia}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No alerts at this severity.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
