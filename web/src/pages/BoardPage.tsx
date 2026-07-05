/**
 * AI-1800 AC1 — Board page with YAML-driven columns.
 *
 * Columns are generated from the workflow YAML states list (left-to-right).
 * One lane group per workflow with live enrolled tickets. Done column at the
 * right edge. Muted (demoted/cancelled) tickets render in a sub-strip below.
 */
import type { BoardWorkflow, BoardTicket } from "../board-types";
import { BoardCard } from "../components/BoardCard";

interface BoardPageProps {
  workflows: BoardWorkflow[];
  tickets: BoardTicket[];
}

export function BoardPage({ workflows, tickets }: BoardPageProps) {
  // Only render workflows that have at least one enrolled ticket
  const activeWorkflows = workflows.filter((wf) =>
    tickets.some((t) => t.workflow === wf.id),
  );

  // Collect muted tickets for the sub-strip
  const mutedTickets = tickets.filter((t) => t.muted);

  return (
    <div className="board-page">
      {activeWorkflows.map((workflow) => {
        const wfTickets = tickets.filter((t) => t.workflow === workflow.id);
        const wfMuted = wfTickets.filter((t) => t.muted);
        const wfActive = wfTickets.filter((t) => !t.muted);

        return (
          <section
            key={workflow.id}
            data-testid="board-workflow"
            data-workflow-id={workflow.id}
            className="board-workflow"
          >
            <div className="board-columns">
              {workflow.states.map((stateId) => {
                const colTickets = wfActive.filter((t) => t.state === stateId);
                return (
                  <div
                    key={stateId}
                    data-testid="board-column"
                    data-column-state={stateId}
                    className={`board-column${stateId === "done" ? " board-column--done" : ""}`}
                  >
                    <div data-testid={`board-column-${stateId}`} className="board-column__inner">
                      <h3 className="board-column__title">{stateId}</h3>
                      <div className="board-column__cards">
                        {colTickets.map((ticket) => (
                          <BoardCard key={ticket.ticket_id} ticket={ticket} />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {wfMuted.length > 0 && (
              <div data-testid="muted-sub-strip" className="muted-sub-strip">
                <h4 className="muted-sub-strip__title">Demoted / Cancelled</h4>
                <div className="muted-sub-strip__cards">
                  {wfMuted.map((ticket) => (
                    <BoardCard key={ticket.ticket_id} ticket={ticket} />
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}

      {/* Global muted sub-strip for muted tickets not belonging to an active workflow */}
      {activeWorkflows.length === 0 && mutedTickets.length > 0 && (
        <div data-testid="muted-sub-strip" className="muted-sub-strip">
          <h4 className="muted-sub-strip__title">Demoted / Cancelled</h4>
          <div className="muted-sub-strip__cards">
            {mutedTickets.map((ticket) => (
              <BoardCard key={ticket.ticket_id} ticket={ticket} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
