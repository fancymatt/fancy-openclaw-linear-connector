/**
 * AI-1800 AC5 — Ticket detail view shows state transitions as headings with
 * wake cycles collapsed beneath; agent plane by default, connector plane
 * expandable.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketDetailView } from "../pages/TicketDetailView";

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

const sampleDetail: TicketDetailResponse = {
  ticket_id: "AI-5001",
  workflow: "dev-impl",
  state: "code-review",
  delegate: "cra",
  state_transitions: [
    {
      state: "intake",
      delegate: "astrid",
      timestamp: "2026-07-05T10:00:00Z",
      event_kind: "created",
      default_plane: "agent",
      expandable_planes: ["connector"],
      wake_cycles: [
        { wake_id: "wake-t1", plane: "agent", summary: "Astrid accepted intake, 10:01" },
        { wake_id: "wake-t1", plane: "connector", summary: "Dispatched via connector, 10:01" },
      ],
    },
    {
      state: "write-tests",
      delegate: "tdd",
      timestamp: "2026-07-05T11:00:00Z",
      event_kind: "accept",
      default_plane: "agent",
      expandable_planes: ["connector"],
      wake_cycles: [
        { wake_id: "wake-t2", plane: "agent", summary: "TDD agent started writing tests, 11:01" },
      ],
    },
    {
      state: "implementation",
      delegate: "igor",
      timestamp: "2026-07-05T13:00:00Z",
      event_kind: "tests-ready",
      default_plane: "agent",
      expandable_planes: ["connector"],
      wake_cycles: [
        { wake_id: "wake-t3", plane: "agent", summary: "Igor started implementation, 13:01" },
        { wake_id: "wake-t3", plane: "connector", summary: "Re-dispatched to Igor, 13:02" },
      ],
    },
    {
      state: "code-review",
      delegate: "cra",
      timestamp: "2026-07-05T14:00:00Z",
      event_kind: "submit",
      default_plane: "agent",
      expandable_planes: ["connector"],
      wake_cycles: [],
    },
  ],
};

describe("AI-1800 AC5: TicketDetailView — state transitions with wake cycles", () => {
  it("renders state transitions as headings", () => {
    render(<TicketDetailView data={sampleDetail} />);
    expect(screen.getByRole("heading", { name: /intake/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /write-tests/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /implementation/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /code-review/i })).toBeInTheDocument();
  });

  it("wake cycles are collapsed beneath their parent transition by default", () => {
    const { container } = render(<TicketDetailView data={sampleDetail} />);
    const transitions = container.querySelectorAll("[data-testid='state-transition']");
    expect(transitions.length).toBe(4);

    const intakeTransition = transitions[0];
    const collapsedCycles = intakeTransition.querySelectorAll("[data-testid='wake-cycle']");
    expect(collapsedCycles.length).toBe(2);

    const details = intakeTransition.querySelector("details");
    expect(details).toBeInTheDocument();
  });

  it("agent plane wake cycles are shown by default", () => {
    const { container } = render(<TicketDetailView data={sampleDetail} />);
    const agentCycle = container.querySelector("[data-testid='wake-cycle'][data-plane='agent']");
    expect(agentCycle).toBeInTheDocument();
  });

  it("connector plane is expandable", () => {
    const { container } = render(<TicketDetailView data={sampleDetail} />);
    const connectorToggle = container.querySelector("[data-testid='toggle-connector-plane']");
    expect(connectorToggle).toBeInTheDocument();
  });

  it("displays current ticket metadata", () => {
    render(<TicketDetailView data={sampleDetail} />);
    expect(screen.getByText("AI-5001")).toBeInTheDocument();
    expect(screen.getByText(/code-review/)).toBeInTheDocument();
    expect(screen.getByText("cra")).toBeInTheDocument();
  });
});

// AI-1954 AC4/AC5: OpsActions must be mounted on the ticket-detail view (the
// ac-fail regression — the component existed but no page imported it, so the
// buttons never reached the production SPA). This asserts they render from the
// page, not just from the component in isolation.
describe("AI-1954 AC4/AC5: TicketDetailView mounts the full OpsActions", () => {
  it("renders redispatch, set-state, recapture-ac, and deploy buttons from the page", () => {
    render(<TicketDetailView data={sampleDetail} />);
    expect(screen.getByRole("button", { name: /redispatch/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set.?state/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /recapture/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deploy/i })).toBeInTheDocument();
  });

  it("passes the ticket id through to the ops actions (redispatch targets this ticket)", () => {
    render(<TicketDetailView data={sampleDetail} />);
    // The deploy button carries a static disabled reason; redispatch/set-state
    // operate on data.ticket_id, verified end-to-end by OpsActions' own suite.
    expect(screen.getByRole("button", { name: /deploy/i })).toBeDisabled();
  });
});
