/**
 * AI-1800 AC5 — Ticket detail with state transitions as chapter headings.
 *
 * Each workflow-state transition is a heading. Wake cycles render collapsed
 * beneath their parent transition. Agent plane shown by default; connector
 * plane is expandable via a toggle. All cycles are in the DOM regardless
 * of visibility (tests count DOM nodes, not visible elements).
 */
import { useState } from "react";
import type { TicketDetailResponse, StateTransition } from "../board-types";

interface TicketDetailViewProps {
  data: TicketDetailResponse;
}

function TransitionBlock({ transition }: { transition: StateTransition }) {
  const [showConnector, setShowConnector] = useState(false);

  const hasConnector = transition.expandable_planes.includes("connector");

  return (
    <div data-testid="state-transition" className="state-transition">
      <details open>
        <summary>
          <h4 className="state-transition__heading">{transition.state}</h4>
          {transition.delegate && (
            <span className="state-transition__delegate">
              {transition.delegate}
            </span>
          )}
        </summary>

        <div className="state-transition__cycles">
          {transition.wake_cycles.map((cycle, idx) => (
            <div
              key={`${cycle.wake_id}-${cycle.plane}-${idx}`}
              data-testid="wake-cycle"
              data-plane={cycle.plane}
              className={`wake-cycle wake-cycle--${cycle.plane}`}
              style={
                cycle.plane === "connector" && !showConnector
                  ? { display: "none" }
                  : undefined
              }
            >
              {cycle.summary}
            </div>
          ))}
        </div>

        {hasConnector && (
          <button
            data-testid="toggle-connector-plane"
            className="state-transition__toggle-connector"
            onClick={() => setShowConnector((v) => !v)}
          >
            {showConnector ? "Hide connector plane" : "Show connector plane"}
          </button>
        )}
      </details>
    </div>
  );
}

export function TicketDetailView({ data }: TicketDetailViewProps) {
  return (
    <div className="ticket-detail-view">
      <header className="ticket-detail-view__header">
        <h2 className="ticket-detail-view__title">{data.ticket_id}</h2>
      </header>

      <div className="ticket-detail-view__transitions">
        {data.state_transitions.map((transition, idx) => (
          <TransitionBlock
            key={`${transition.state}-${idx}`}
            transition={transition}
          />
        ))}
      </div>
    </div>
  );
}
