/**
 * AI-1800 — Board type definitions.
 *
 * Contract between the board API and the frontend components.
 * Shared by BoardPage, BoardCard, DispatchCyclesView, and TicketDetailView.
 */

export interface BoardWorkflow {
  /** Workflow ID matching the YAML def's `id` field. */
  id: string;
  /** Ordered list of state IDs from the YAML `states:` list. */
  states: string[];
}

export interface BoardTicket {
  ticket_id: string;
  workflow: string;
  state: string;
  delegate: string | null;
  /** Milliseconds since entered_state_at. */
  time_in_state_ms: number;
  /** SLA threshold in ms for the current state, or null if no SLA declared. */
  sla_ms: number | null;
  /** Rendered prose for the last event, e.g. "Igor accepted dispatch, 4m ago". */
  last_event_prose: string;
  /** 1 if ticket is in a terminal disposition. */
  terminal: number;
  /** True if demoted/cancelled — rendered in muted sub-strip. */
  muted: boolean;
  /** Milliseconds since terminal disposition (AC3). */
  terminal_duration_ms?: number;
}

/** Dispatch cycle types (AC4). */
export interface DispatchEntry {
  ticket_id: string;
  dispatched_at: string;
  ack_status: string;
  attempt_count: number;
}

export interface DispatchCycle {
  wake_id: string;
  agent_id: string;
  dispatches: DispatchEntry[];
}

export interface DispatchesResponse {
  label: string;
  cycles: DispatchCycle[];
}

/** Ticket detail types (AC5). */
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
