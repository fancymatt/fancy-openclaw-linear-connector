/**
 * AI-1955 AC4 — Per-agent dispatch history.
 *
 * A filterable view over the existing dispatch-ack store (`/admin/api/dispatches`,
 * the same source DispatchCyclesView reads). Flattens dispatch cycles into a
 * per-dispatch row list, tagged with the owning agent, and offers two filters:
 *   - agent   (the AC's headline "per-agent" requirement)
 *   - outcome (ack_status)
 *
 * Read-only; no new backend. Reuses the ack-tone chip idiom from FleetPage.
 */
import { useMemo, useState } from "react";
import { apiGet } from "../api";
import { usePoll } from "../hooks";
import { Card, Chip, Empty, ErrorBanner } from "../components";
import type { DispatchesResponse } from "../pages/DispatchCyclesView";

/** Shared with FleetPage's ack styling so tones read consistently across the console. */
const ACK_TONE: Record<string, string> = {
  pending: "yellow",
  unconfirmed: "yellow",
  escalated: "red",
  deferred: "gray",
  acknowledged: "green",
};

const ALL = "__all__";

interface FlatDispatch {
  wakeId: string;
  agentId: string;
  ticketId: string;
  dispatchedAt: string;
  ackStatus: string;
  attemptCount: number;
}

function flatten(data: DispatchesResponse): FlatDispatch[] {
  const rows: FlatDispatch[] = [];
  for (const cycle of data.cycles) {
    for (const d of cycle.dispatches) {
      rows.push({
        wakeId: cycle.wake_id,
        agentId: cycle.agent_id || "(unattributed)",
        ticketId: d.ticket_id,
        dispatchedAt: d.dispatched_at,
        ackStatus: d.ack_status,
        attemptCount: d.attempt_count,
      });
    }
  }
  // Most-recent first — dispatchedAt is ISO, so lexical sort is chronological.
  return rows.sort((a, b) => (a.dispatchedAt < b.dispatchedAt ? 1 : -1));
}

interface FleetDispatchHistoryProps {
  /** For test renders — accepts dispatch data directly instead of fetching. */
  data?: DispatchesResponse;
}

export function FleetDispatchHistory({ data: propData }: FleetDispatchHistoryProps = {}) {
  const live = usePoll(() => apiGet<DispatchesResponse>("/admin/api/dispatches"), 8000);
  const data = propData ?? live.data ?? { label: "Dispatch cycles", cycles: [] };

  const [agent, setAgent] = useState<string>(ALL);
  const [outcome, setOutcome] = useState<string>(ALL);

  const rows = useMemo(() => flatten(data), [data]);

  const agents = useMemo(
    () => Array.from(new Set(rows.map((r) => r.agentId))).sort(),
    [rows],
  );
  const outcomes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.ackStatus))).sort(),
    [rows],
  );

  const filtered = rows.filter(
    (r) => (agent === ALL || r.agentId === agent) && (outcome === ALL || r.ackStatus === outcome),
  );

  return (
    <Card span={12} title="Dispatch history">
      <ErrorBanner message={propData ? null : live.error} />
      <div className="filters">
        <label>
          Agent{" "}
          <select
            aria-label="Filter dispatch history by agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value={ALL}>All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label>
          Outcome{" "}
          <select
            aria-label="Filter dispatch history by outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            <option value={ALL}>All outcomes</option>
            {outcomes.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
      </div>

      {filtered.length ? (
        <table>
          <thead>
            <tr><th>Agent</th><th>Ticket</th><th>Dispatched</th><th>Outcome</th><th>Wake</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={`${r.wakeId}-${r.ticketId}`} data-testid="dispatch-history-row">
                <td>{r.agentId}</td>
                <td className="mono">{r.ticketId}</td>
                <td className="muted">{r.dispatchedAt}</td>
                <td>
                  <Chip tone={ACK_TONE[r.ackStatus] ?? "gray"}>
                    {r.ackStatus}
                    {r.attemptCount > 1 && ` · ${r.attemptCount} attempts`}
                  </Chip>
                </td>
                <td className="muted mono">{r.wakeId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No dispatches match the current filters.</Empty>
      )}
    </Card>
  );
}
