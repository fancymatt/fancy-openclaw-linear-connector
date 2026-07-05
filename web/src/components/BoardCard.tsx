/**
 * AI-1800 AC2 — BoardCard renders delegate, ticket ID, time-in-state with SLA coloring,
 * and last event as prose.
 *
 * SLA thresholds (per spec):
 *   neutral: time_in_state < 50% of SLA
 *   amber:   time_in_state >= 80% of SLA
 *   red:     time_in_state > SLA (breach)
 */
import type { BoardTicket } from "../board-types";

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) {
    const minutes = Math.floor(ms / 60000);
    return `${minutes}m`;
  }
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function computeSlaTone(timeInStateMs: number, slaMs: number): "neutral" | "amber" | "red" {
  if (timeInStateMs > slaMs) return "red";
  if (timeInStateMs >= slaMs * 0.8) return "amber";
  return "neutral";
}

interface BoardCardProps {
  ticket: BoardTicket;
}

export function BoardCard({ ticket }: BoardCardProps) {
  const slaTone = ticket.sla_ms ? computeSlaTone(ticket.time_in_state_ms, ticket.sla_ms) : undefined;

  return (
    <div
      data-testid="board-card"
      data-muted={ticket.muted ? "true" : undefined}
      className={`board-card${ticket.muted ? " muted" : ""}`}
    >
      <div className="board-card-id">{ticket.ticket_id}</div>
      <div className="board-card-delegate">{ticket.delegate}</div>
      {ticket.last_event_prose && (
        <div className="board-card-event">{ticket.last_event_prose}</div>
      )}
      {slaTone && (
        <div
          data-testid="sla-indicator"
          data-sla-tone={slaTone}
          className={`sla-indicator sla-${slaTone}`}
        >
          {formatDuration(ticket.time_in_state_ms)} / {formatDuration(ticket.sla_ms)}
        </div>
      )}
      {/* AC3: Completion duration for terminal tickets. */}
      {ticket.terminal === 1 && ticket.terminal_duration_ms != null && (
        <div data-testid="completion-duration" className="completion-duration">
          done {formatDuration(ticket.terminal_duration_ms)} ago
        </div>
      )}
    </div>
  );
}
