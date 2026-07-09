import { Link } from "react-router-dom";
import { apiGet } from "../api";
import { usePoll, ageLabel } from "../hooks";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { Card, Chip, Diagnostics, Empty, ErrorBanner } from "../components";
import { CapacityStrip } from "../components/CapacityStrip";
import { OpsActions } from "../components/OpsActions";
import type { FleetResponse } from "../types";

/** Console-session invoker identity for admin-mutation attribution (see TicketDetailView). */
const CONSOLE_INVOKER = "console";

const ACK_TONE: Record<string, string> = {
  pending: "yellow",
  unconfirmed: "yellow",
  escalated: "red",
  deferred: "gray",
  acknowledged: "green",
};

interface FleetPageProps {
  /** For test renders — accepts fleet data directly instead of fetching. */
  data?: FleetResponse;
}

export function FleetPage({ data: propData }: FleetPageProps = {}) {
  const fleet = usePoll(() => apiGet<FleetResponse>("/admin/api/fleet"), 8000);
  useLiveRefresh({ onFleet: fleet.refresh });
  const f = propData ?? fleet.data;

  const openDispatches = f?.dispatches.filter((d) => d.ackStatus !== "acknowledged") ?? [];

  return (
    <>
      <ErrorBanner message={fleet.error} />
      <CapacityStrip />
      <div className="grid">
        <Card span={12} title={`Fleet liveness (${f?.agents.length ?? "…"} agents)`}>
          {f ? (
            <table>
              <thead>
                <tr><th>Agent</th><th>State</th><th>Activity</th><th>Pending / queued</th><th>Last success</th><th>Last error</th></tr>
              </thead>
              <tbody>
                {f.agents.map((agent) => (
                  <tr key={agent.name}>
                    <td>
                      <div className="row-title">{agent.name}</div>
                      <div className="muted mono">{agent.openclawAgent} · {agent.linearUserId} · {agent.host}</div>
                    </td>
                    <td>
                      <Chip tone={agent.severity}>{agent.credentialState}</Chip>
                    </td>
                    <td>
                      {agent.activity}
                      {agent.activeSessionKey && <div className="muted mono">{agent.activeSessionKey}</div>}
                    </td>
                    <td>{agent.pendingCount} / {agent.queueDepth}</td>
                    <td className="muted">{agent.lastSuccess}</td>
                    <td className="muted">{agent.lastError}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Loading…</Empty>
          )}
        </Card>

        <Card span={8} title={`Open dispatches (${openDispatches.length})`}>
          {openDispatches.length ? (
            <table>
              <thead>
                <tr><th>Agent</th><th>Ticket</th><th>Status</th><th>Attempts</th><th>Dispatched</th><th>Last signal</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {openDispatches.map((d) => (
                  <tr key={d.id}>
                    <td>{d.agentId}</td>
                    <td className="mono"><Link to={`/ticket/${d.ticketId}`}>{d.ticketId}</Link></td>
                    <td><Chip tone={ACK_TONE[d.ackStatus] ?? "gray"}>{d.ackStatus}</Chip></td>
                    <td>{d.attemptCount}</td>
                    <td className="muted">{ageLabel(d.dispatchedAt)}</td>
                    <td className="muted">{ageLabel(d.lastSignalAt)}</td>
                    {/* AI-1954 AC4: redispatch on the fleet page (redispatch-only variant). */}
                    <td><OpsActions variant="redispatch" ticketId={d.ticketId} invoker={CONSOLE_INVOKER} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No unacknowledged dispatches — every wake has been picked up.</Empty>
          )}
        </Card>

        <Card span={4} title="Registry ⇄ policy">
          {f ? (
            <>
              {f.registryPolicy.violations.length ? (
                f.registryPolicy.violations.map((v, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <Chip tone="red">drift</Chip> <span className="muted">{v}</span>
                  </div>
                ))
              ) : (
                <div><Chip tone="green">clean</Chip> <span className="muted">checked {ageLabel(f.registryPolicy.lastCheck)}</span></div>
              )}
              {f.registryPolicy.notes.length > 0 && (
                <details>
                  <summary>{f.registryPolicy.notes.length} note(s)</summary>
                  {f.registryPolicy.notes.map((n, i) => (
                    <div key={i} className="muted">{n}</div>
                  ))}
                </details>
              )}
              <Diagnostics value={f.configHealth} label="Config health" />
            </>
          ) : (
            <Empty>Loading…</Empty>
          )}
        </Card>

        <Card span={12} title="Recently acknowledged">
          {f && f.dispatches.some((d) => d.ackStatus === "acknowledged") ? (
            <table>
              <thead>
                <tr><th>Agent</th><th>Ticket</th><th>Attempts</th><th>Last signal</th></tr>
              </thead>
              <tbody>
                {f.dispatches.filter((d) => d.ackStatus === "acknowledged").slice(0, 20).map((d) => (
                  <tr key={d.id}>
                    <td>{d.agentId}</td>
                    <td className="mono">{d.ticketId}</td>
                    <td>{d.attemptCount}</td>
                    <td className="muted">{ageLabel(d.lastSignalAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nothing acknowledged in the current window.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
