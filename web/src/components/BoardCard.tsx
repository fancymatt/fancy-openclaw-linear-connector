/**
 * AI-1800 AC2 — Board card with SLA coloring, delegate, and event prose.
 *
 * SLA thresholds: neutral <50% of SLA, amber at ≥80%, red past breach.
 * Terminal tickets show completion duration. Muted tickets get data-muted.
 */
import type { BoardTicket } from "../board-types";

/** Format milliseconds as a human-readable duration (e.g. "3h 40m", "12m"). */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/** Determine SLA tone from time-in-state ratio. */
function slaTone(
  timeInStateMs: number,
  slaMs: number | null,
): "neutral" | "amber" | "red" | null {
  if (slaMs === null || slaMs <= 0) return null;
  const ratio = timeInStateMs / slaMs;
  if (ratio >= 1.0) return "red";
  if (ratio >= 0.8) return "amber";
  return "neutral";
}

interface BoardCardProps {
  ticket: BoardTicket;
}

export function BoardCard({ ticket }: BoardCardProps) {
  const tone = slaTone(ticket.time_in_state_ms, ticket.sla_ms);
  const mutedAttr = ticket.muted ? "true" : undefined;

  return (
    <article
      data-testid="board-card"
      data-muted={mutedAttr}
      className={`board-card${ticket.muted ? " board-card--muted" : ""}`}
    >
      <div className="board-card__header">
        <span className="board-card__id">{ticket.ticket_id}</span>
        {ticket.delegate && (
          <span className="board-card__delegate">{ticket.delegate}</span>
        )}
      </div>

      {ticket.last_event_prose && (
        <p className="board-card__event">{ticket.last_event_prose}</p>
      )}

      {tone && (
        <span
          data-testid="sla-indicator"
          data-sla-tone={tone}
          className={`sla-indicator sla-indicator--${tone}`}
        >
          {tone === "red" ? "SLA breached" : tone === "amber" ? "SLA warning" : "on track"}
        </span>
      )}

      {ticket.terminal === 1 && ticket.terminal_duration_ms != null && (
        <span data-testid="completion-duration" className="completion-duration">
          done {formatDuration(ticket.terminal_duration_ms)} ago
        </span>
      )}
    </article>
  );
}
