/**
 * AI-1800 AC1 — BoardPage renders workflow columns from YAML-driven state ordering.
 * AC3 — Done column with muted sub-strip for demoted tickets.
 */
import { usePoll } from "../hooks";
import { apiGet } from "../api";
import { BoardCard } from "../components/BoardCard";
import { ErrorBanner } from "../components";
import type { BoardWorkflow, BoardTicket } from "../board-types";

interface BoardResponse {
  workflows: BoardWorkflow[];
  tickets: BoardTicket[];
}

interface BoardPageProps {
  workflows?: BoardWorkflow[];
  tickets?: BoardTicket[];
}

/** For test renders — accepts props directly instead of fetching from API. */
export function BoardPage({ workflows: propWorkflows, tickets: propTickets }: BoardPageProps) {
  const live = usePoll(() => apiGet<BoardResponse>("/admin/api/board"), 8000);
  const workflows = propWorkflows ?? live.data?.workflows ?? [];
  const tickets = propTickets ?? live.data?.tickets ?? [];

  // Group tickets by workflow.
  const ticketsByWorkflow = new Map<string, BoardTicket[]>();
  for (const t of tickets) {
    const list = ticketsByWorkflow.get(t.workflow) ?? [];
    list.push(t);
    ticketsByWorkflow.set(t.workflow, list);
  }

  // Only render workflows that have enrolled tickets (AC1).
  const activeWorkflows = workflows.filter((wf) => (ticketsByWorkflow.get(wf.id)?.length ?? 0) > 0);

  // Group muted (demoted) tickets separately.
  const mutedTickets = tickets.filter((t) => t.muted);

  return (
    <>
      <ErrorBanner message={live.error} />
      <div className="board-page">
        {activeWorkflows.map((wf) => {
          const wfTickets = ticketsByWorkflow.get(wf.id) ?? [];
          return (
            <div key={wf.id} className="board-workflow">
              <h2>{wf.id}</h2>
              <div className="board-columns">
                {wf.states.map((state) => {
                  const columnTickets = wfTickets.filter((t) => t.state === state);
                  return (
                    <div
                      key={state}
                      data-testid="board-column"
                      data-column-state={state}
                      className="board-column"
                    >
                      <div data-testid={`board-column-${state}`} className="board-column-inner">
                        <div className="board-column-header">{state}</div>
                        <div className="board-column-cards">
                          {columnTickets.filter((t) => !t.muted).map((ticket) => (
                            <BoardCard key={ticket.ticket_id} ticket={ticket} />
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {/* AC3: Muted sub-strip for demoted/cancelled tickets. */}
        {mutedTickets.length > 0 && (
          <div data-testid="muted-sub-strip" className="muted-sub-strip">
            <div className="board-column-header muted">Cancelled / demoted</div>
            {mutedTickets.map((ticket) => (
              <BoardCard key={ticket.ticket_id} ticket={ticket} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
