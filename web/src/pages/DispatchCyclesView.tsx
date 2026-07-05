/**
 * AI-1800 AC4 — Dispatches sub-view, grouped by wake_id.
 *
 * Honest labeling: "dispatch cycles", not "tasks". Groups by wake_id with
 * connector-plane visibility. Replaces the old "Waiting for agent pickup" copy.
 */
import type { DispatchesResponse } from "../board-types";

interface DispatchCyclesViewProps {
  data: DispatchesResponse;
}

export function DispatchCyclesView({ data }: DispatchCyclesViewProps) {
  return (
    <div className="dispatch-cycles-view">
      <h2 className="dispatch-cycles-view__label">{data.label}</h2>

      {data.cycles.length === 0 && (
        <p className="dispatch-cycles-view__empty">No active dispatch cycles.</p>
      )}

      <div className="dispatch-cycles-view__groups">
        {data.cycles.map((cycle) => (
          <div
            key={cycle.wake_id}
            data-testid="dispatch-cycle-group"
            className="dispatch-cycle-group"
          >
            <div className="dispatch-cycle-group__header">
              <span className="dispatch-cycle-group__wake-id">
                {cycle.wake_id}
              </span>
              <span className="dispatch-cycle-group__agent">
                {cycle.agent_id}
              </span>
            </div>

            <div className="dispatch-cycle-group__entries">
              {cycle.dispatches.map((entry, idx) => (
                <div
                  key={`${entry.ticket_id}-${idx}`}
                  data-testid="dispatch-entry"
                  className="dispatch-entry"
                >
                  <span className="dispatch-entry__ticket">
                    {entry.ticket_id}
                  </span>
                  <span className="dispatch-entry__status">
                    {entry.ack_status}
                  </span>
                  {entry.attempt_count > 1 && (
                    <span className="dispatch-entry__attempts">
                      attempt {entry.attempt_count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
