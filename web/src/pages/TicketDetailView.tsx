/**
 * AI-1800 AC5 — TicketDetailView shows state transitions as headings with
 * wake cycles collapsed beneath; agent plane by default, connector expandable.
 */
import { useState } from "react";
import { usePoll } from "../hooks";
import { apiGet } from "../api";
import { ErrorBanner } from "../components";
import { OpsActions } from "../components/OpsActions";

/**
 * Invoker identity for admin-mutation attribution. The console authenticates
 * with a single shared ADMIN_SECRET (no per-user identity), so console-originated
 * admin ops are attributed to "console" — distinguishing them from the true
 * agent bodies, which was the AI-1909 attribution defect this ticket fixes.
 */
const CONSOLE_INVOKER = "console";

export interface WakeCycle {
  wake_id: string;
  plane: "agent" | "connector";
  summary: string;
}

export interface StateTransition {
  state: string;
  delegate: string | null;
  timestamp: string;
  event_kind: string;
  default_plane: "agent" | "connector";
  expandable_planes: string[];
  wake_cycles: WakeCycle[];
}

export interface TicketDetailResponse {
  ticket_id: string;
  workflow: string;
  state: string;
  delegate: string | null;
  state_transitions: StateTransition[];
}

interface TicketDetailViewProps {
  data?: TicketDetailResponse;
  ticketId?: string;
}

/** For test renders — accepts data prop. Can also fetch by ticketId. */
export function TicketDetailView({ data: propData, ticketId }: TicketDetailViewProps) {
  const live = ticketId
    ? usePoll(() => apiGet<TicketDetailResponse>(`/admin/api/board/ticket/${ticketId}`), 8000)
    : { data: null, error: null, loading: false, refresh: () => {} };
  const data = propData ?? live.data;

  if (!data) {
    return <div className="empty">No ticket data.</div>;
  }

  return (
    <>
      <ErrorBanner message={ticketId ? live.error : null} />
      <div className="ticket-detail-view">
        {/* Ticket metadata header. */}
        <div className="ticket-detail-meta">
          <h2>{data.ticket_id}</h2>
          <div className="meta-row">
            <span>Workflow: {data.workflow}</span>
            {data.delegate && <span>Delegate: {data.delegate}</span>}
          </div>
          {/* AI-1954 AC4/AC5: ops actions (redispatch / set-state / recapture-ac / deploy). */}
          <OpsActions ticketId={data.ticket_id} invoker={CONSOLE_INVOKER} />
        </div>

        {/* State transitions as headings with collapsed wake cycles. */}
        {data.state_transitions.map((transition) => (
          <TransitionBlock key={transition.state} transition={transition} />
        ))}
      </div>
    </>
  );
}

function TransitionBlock({ transition }: { transition: StateTransition }) {
  const [showConnector, setShowConnector] = useState(false);

  const agentCycles = transition.wake_cycles.filter((c) => c.plane === "agent");
  const connectorCycles = transition.wake_cycles.filter((c) => c.plane === "connector");

  return (
    <div data-testid="state-transition" className="state-transition">
      <h3>{transition.state}</h3>
      {transition.delegate && (
        <span className="transition-delegate">{transition.delegate}</span>
      )}
      <span className="transition-time">{transition.timestamp}</span>

      {/* Wake cycles collapsed in a <details>. */}
      <details open>
        <summary>Wake cycles</summary>
        {/* Agent plane cycles — shown by default. */}
        {agentCycles.map((cycle) => (
          <div
            key={`${cycle.wake_id}-agent`}
            data-testid="wake-cycle"
            data-plane="agent"
            className="wake-cycle"
          >
            {cycle.summary}
          </div>
        ))}

        {/* Connector plane — in DOM but hidden until toggled. */}
        {transition.expandable_planes.includes("connector") && connectorCycles.length > 0 && (
          <div className="connector-plane" style={{ display: showConnector ? "block" : "none" }}>
            <button
              data-testid="toggle-connector-plane"
              onClick={() => setShowConnector(!showConnector)}
              className="toggle-connector"
            >
              {showConnector ? "Hide" : "Show"} connector plane
            </button>
            {connectorCycles.map((cycle) => (
              <div
                key={`${cycle.wake_id}-connector`}
                data-testid="wake-cycle"
                data-plane="connector"
                className="wake-cycle connector"
              >
                {cycle.summary}
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
