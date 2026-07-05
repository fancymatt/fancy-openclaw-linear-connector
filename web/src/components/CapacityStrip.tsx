import { usePoll } from "../hooks";
import { apiGet } from "../api";
import { Card, Empty, ErrorBanner, Chip } from "../components";
import type { CapacityResponse } from "../types";

/**
 * CapacityStrip — per-agent capacity overview widget.
 * Shows slots used / cap and parked count per agent.
 * Over-capacity (slotsUsed > cap) is visually distinguished with a red chip.
 */
export function CapacityStrip() {
  const capacity = usePoll(() => apiGet<CapacityResponse>("/admin/api/capacity"), 8000);
  const agents = capacity.data?.agents ?? [];

  return (
    <Card span={12} title={`Capacity (${agents.length} active)`}>
      <ErrorBanner message={capacity.error} />
      {agents.length === 0 && !capacity.loading ? (
        <Empty>No agents with live sessions or parked tickets.</Empty>
      ) : agents.length === 0 ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="capacity-strip">
          {agents
            .sort((a, b) => a.agentId.localeCompare(b.agentId))
            .map((agent) => {
              const overCap = agent.slotsUsed > agent.cap;
              return (
                <div key={agent.agentId} className={`capacity-agent${overCap ? " over-cap" : ""}`}>
                  <div className="capacity-name">{agent.agentId}</div>
                  <div className="capacity-meters">
                    <div className="capacity-slots">
                      <span className={overCap ? "over" : ""}>
                        {agent.slotsUsed}
                      </span>
                      <span className="muted">/{agent.cap}</span>
                    </div>
                    <div className="capacity-parked">
                      <span className="muted">+</span> {agent.parkedCount} <span className="muted">parked</span>
                    </div>
                  </div>
                  {overCap && <Chip tone="red">over</Chip>}
                </div>
              );
            })}
        </div>
      )}
    </Card>
  );
}
