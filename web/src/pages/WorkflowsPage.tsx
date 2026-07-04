import { apiGet } from "../api";
import { usePoll } from "../hooks";
import { Card, Chip, Diagnostics, Empty, ErrorBanner } from "../components";
import type { WorkflowDef, WorkflowState, WorkflowTransition } from "../types";

function transitionsOf(state: WorkflowState): WorkflowTransition[] {
  if (Array.isArray(state.transitions)) return state.transitions;
  if (state.transitions && typeof state.transitions === "object") {
    return Object.entries(state.transitions).map(([verb, value]) => ({
      verb,
      ...(typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { to: String(value) }),
    }));
  }
  return [];
}

function WorkflowCard({ def }: { def: WorkflowDef }) {
  const states = def.states ?? [];
  return (
    <Card span={12} title={<span>{def.id} <span className="muted">v{String(def.version ?? "?")} · {states.length} states</span></span>}>
      <div className="wf-flow">
        {states.map((state, i) => (
          <span key={state.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <Chip tone="blue">{state.id}</Chip>
            {i < states.length - 1 && <span className="wf-arrow">→</span>}
          </span>
        ))}
      </div>
      {states.map((state) => {
        const transitions = transitionsOf(state);
        return (
          <div key={state.id} className="wf-state">
            <div>
              <span className="row-title">{state.id}</span>{" "}
              {state.role != null && <Chip tone="gray">role: {String(state.role)}</Chip>}{" "}
              {state.native_state != null && <Chip tone="gray">linear: {String(state.native_state)}</Chip>}{" "}
              {state.sla != null && <Chip tone="yellow">sla: {typeof state.sla === "object" ? JSON.stringify(state.sla) : String(state.sla)}</Chip>}
            </div>
            {transitions.length > 0 && (
              <div className="muted" style={{ marginTop: 6 }}>
                {transitions.map((t, i) => (
                  <span key={i} style={{ marginRight: 12 }}>
                    <span className="mono">{String(t.verb ?? t.generic ?? "→")}</span>
                    {t.to != null && <> → <span className="mono">{String(t.to)}</span></>}
                  </span>
                ))}
              </div>
            )}
            <Diagnostics value={state} label="full state definition" />
          </div>
        );
      })}
    </Card>
  );
}

export function WorkflowsPage() {
  const workflows = usePoll(() => apiGet<{ workflows: WorkflowDef[]; error: string | null }>("/admin/api/workflows"), 30000);

  return (
    <>
      <ErrorBanner message={workflows.error ?? workflows.data?.error ?? null} />
      <div className="grid">
        {workflows.data ? (
          workflows.data.workflows.length ? (
            workflows.data.workflows.map((def) => <WorkflowCard key={def.id} def={def} />)
          ) : (
            <Card span={12}><Empty>No workflow definitions loaded. Check WORKFLOW_DEFS_DIR.</Empty></Card>
          )
        ) : (
          <Card span={12}><Empty>Loading…</Empty></Card>
        )}
        <Card span={12} title="Editing">
          <div className="muted">
            Read-only for now. The visual editor — state-graph editing with live schema validation, versioned
            diffs, guidance editing, and a wake-brief dry-run simulator — is the next Phase 3 milestone.
          </div>
        </Card>
      </div>
    </>
  );
}
