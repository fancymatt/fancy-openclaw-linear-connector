/**
 * AI-1800 AC4 — DispatchCyclesView renders dispatches grouped by wake_id,
 * labeled as dispatch cycles (not tasks).
 */
import { usePoll } from "../hooks";
import { apiGet } from "../api";
import { ErrorBanner } from "../components";

export interface DispatchCycle {
  wake_id: string;
  agent_id: string;
  dispatches: Array<{
    ticket_id: string;
    dispatched_at: string;
    ack_status: string;
    attempt_count: number;
  }>;
}

export interface DispatchesResponse {
  label: string;
  cycles: DispatchCycle[];
}

interface DispatchCyclesViewProps {
  data?: DispatchesResponse;
}

/** For test renders — accepts props directly. */
export function DispatchCyclesView({ data: propData }: DispatchCyclesViewProps) {
  const live = usePoll(() => apiGet<DispatchesResponse>("/admin/api/dispatches"), 8000);
  const data = propData ?? live.data ?? { label: "Dispatch cycles", cycles: [] };

  return (
    <>
      <ErrorBanner message={live.error} />
      <div className="dispatch-cycles-view">
        <h2>Dispatch cycles</h2>
        {!data.cycles.length && (
          <div className="empty">No active dispatch cycles.</div>
        )}
        {data.cycles.map((cycle) => (
          <div
            key={cycle.wake_id}
            data-testid="dispatch-cycle-group"
            className="dispatch-cycle-group"
          >
            <div className="cycle-header">
              <span className="wake-id">{cycle.wake_id}</span>
              <span className="agent-id">{cycle.agent_id}</span>
            </div>
            <div className="cycle-dispatches">
              {cycle.dispatches.map((d) => (
                <div
                  key={`${cycle.wake_id}-${d.ticket_id}`}
                  data-testid="dispatch-entry"
                  className="dispatch-entry"
                >
                  <span className="ticket-id">{d.ticket_id}</span>
                  <span className="dispatch-time">{d.dispatched_at}</span>
                  <span className={`ack-status ack-${d.ack_status}`}>
                    {d.ack_status}
                    {d.attempt_count > 1 && ` (${d.attempt_count} attempts)`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
