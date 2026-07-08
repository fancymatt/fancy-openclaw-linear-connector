import { apiGet } from "../api";
import { usePoll, ageLabel } from "../hooks";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { Card, Chip, Empty, ErrorBanner, Stat } from "../components";
import type { DashboardResponse, StructureResponse, AlertRow } from "../types";

export function OverviewPage() {
  const dashboard = usePoll(() => apiGet<DashboardResponse>("/admin/api/dashboard"), 8000);
  const structure = usePoll(() => apiGet<StructureResponse>("/admin/api/structure"), 30000);
  const alerts = usePoll(() => apiGet<{ alerts: AlertRow[] }>("/admin/api/alerts?limit=8"), 15000);
  useLiveRefresh({ onFleet: dashboard.refresh, onAlerts: alerts.refresh, onBoard: dashboard.refresh });

  const d = dashboard.data;
  const s = structure.data;

  return (
    <>
      <ErrorBanner message={dashboard.error} />
      <div className="grid">
        <Card span={12} title="Attention Needed">
          {d ? (
            d.attention.length ? (
              d.attention.map((item, i) => (
                <div key={i} style={{ margin: "8px 0" }}>
                  <Chip tone={item.severity}>{item.severity === "red" ? "Action required" : "Needs attention"}</Chip>{" "}
                  <span className="row-title">{item.title}</span>
                  <div className="muted">{item.message}</div>
                </div>
              ))
            ) : (
              <Empty>No attention needed. Connector is running and no tasks are blocked.</Empty>
            )
          ) : (
            <Empty>Loading…</Empty>
          )}
        </Card>

        <Card span={12} title="System Status">
          {d ? (
            <div className="stat-row">
              <Stat value={<Chip tone={d.status.severity}>{d.status.severity === "green" ? "Healthy" : d.status.severity === "yellow" ? "Degraded" : "Action required"}</Chip>} label={d.deployment} />
              <Stat value={d.status.agentsConfigured} label="agents configured" />
              <Stat value={d.status.activeSessions} label="active sessions" tone={d.status.activeSessions ? "yellow" : undefined} />
              <Stat value={d.status.pendingBagSize} label="pending bag" tone={d.status.pendingBagSize ? "yellow" : "green"} />
              <Stat value={d.status.eventsReceived} label="events received" />
              <Stat value={d.status.signalsSent} label="signals sent" />
            </div>
          ) : (
            <Empty>Loading…</Empty>
          )}
        </Card>

        <Card span={6} title="Structure & Config Health">
          {structure.error && <ErrorBanner message={structure.error} />}
          {s ? (
            <>
              <div className="strip" style={{ marginBottom: 10 }}>
                {s.workflows.map((wf) => (
                  <Chip key={wf.id} tone="blue">
                    {wf.id} v{String(wf.version ?? "?")} · {wf.states} states
                  </Chip>
                ))}
                {s.workflowError && <Chip tone="red">defs error</Chip>}
              </div>
              <div style={{ marginBottom: 8 }}>
                <span className="muted">Registry⇄policy: </span>
                {s.registryPolicy.violations.length ? (
                  <Chip tone="red">{s.registryPolicy.violations.length} violation(s)</Chip>
                ) : (
                  <Chip tone="green">clean</Chip>
                )}{" "}
                <span className="muted">checked {ageLabel(s.registryPolicy.lastCheck)}</span>
              </div>
              {s.registryPolicy.violations.map((v, i) => (
                <div key={i} className="muted">⚠ {v}</div>
              ))}
              {s.registryPolicy.notes.length > 0 && (
                <details>
                  <summary>{s.registryPolicy.notes.length} note(s)</summary>
                  {s.registryPolicy.notes.map((n, i) => (
                    <div key={i} className="muted">{n}</div>
                  ))}
                </details>
              )}
              <details>
                <summary>Config health detail</summary>
                <pre>{JSON.stringify(s.configHealth, null, 2)}</pre>
              </details>
            </>
          ) : (
            <Empty>Loading…</Empty>
          )}
        </Card>

        <Card span={6} title="Recent Alerts">
          {alerts.data?.alerts.length ? (
            <table>
              <tbody>
                {alerts.data.alerts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Chip tone={a.severity === "critical" ? "red" : a.severity === "warning" ? "yellow" : "gray"}>{a.severity}</Chip>
                    </td>
                    <td>
                      <div className="row-title">{a.title}{a.count > 1 ? ` ×${a.count}` : ""}</div>
                      <div className="muted">[{a.source}] {ageLabel(a.lastAt)}{a.pushedAt ? " · pushed" : " · stored only"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No alerts recorded.</Empty>
          )}
        </Card>

        <Card span={12} title="Work in Motion">
          {d?.tasks.length ? (
            <table>
              <thead>
                <tr><th>Task</th><th>Owner</th><th>State</th><th>Age</th></tr>
              </thead>
              <tbody>
                {d.tasks.slice(0, 12).map((task, i) => (
                  <tr key={`${task.sessionKey}-${i}`}>
                    <td>
                      <div className="row-title">{task.relatedUrl ? <a href={task.relatedUrl}>{task.related}</a> : task.related}</div>
                      <div className="muted mono">{task.eventType} · {task.sessionKey}</div>
                    </td>
                    <td>{task.owner}</td>
                    <td><Chip tone={task.severity}>{task.state}</Chip></td>
                    <td className="muted">{task.age}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No pending or queued work. All quiet.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
