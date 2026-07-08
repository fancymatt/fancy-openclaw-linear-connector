/**
 * AI-1953 — StallsPage tests
 *
 * AC1: /stalls lists every flagged ticket with state, delegate, age, and breached threshold.
 * AC2: Rows link to ticket detail; external Linear link present.
 * AC3: Empty state renders cleanly when nothing is stalled.
 *
 * Tests import from the implementation path and fail until StallsPage.tsx is created.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StallsPage } from "../pages/StallsPage";

export interface StallEntry {
  ticket: string;
  agent: string;
  state: string | null;
  delegate: string | null;
  age_seconds: number | null;
  threshold_ms: number | null;
  last_comment_at: string | null;
  classification: string;
  classificationName: string;
}

const sampleEntries: StallEntry[] = [
  {
    ticket: "AI-1001",
    agent: "tdd",
    state: "write-tests",
    delegate: "tdd",
    age_seconds: 7200,
    threshold_ms: 3600000,
    last_comment_at: "2026-07-08T04:00:00.000Z",
    classification: "C3",
    classificationName: "Silent completion",
  },
  {
    ticket: "AI-1002",
    agent: "igor",
    state: "implementation",
    delegate: "igor",
    age_seconds: 172800,
    threshold_ms: 86400000,
    last_comment_at: "2026-07-06T10:00:00.000Z",
    classification: "C1",
    classificationName: "Waiting on user",
  },
];

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("AI-1953 AC1: StallsPage — ticket list with state/delegate/age/threshold", () => {
  it("renders a row for each stalled ticket", () => {
    renderWithRouter(<StallsPage entries={sampleEntries} />);
    expect(screen.getByText("AI-1001")).toBeInTheDocument();
    expect(screen.getByText("AI-1002")).toBeInTheDocument();
  });

  it("displays the workflow state for each ticket", () => {
    renderWithRouter(<StallsPage entries={sampleEntries} />);
    expect(screen.getByText("write-tests")).toBeInTheDocument();
    expect(screen.getByText("implementation")).toBeInTheDocument();
  });

  it("displays the delegate for each ticket", () => {
    renderWithRouter(<StallsPage entries={sampleEntries} />);
    const delegateCells = screen.getAllByText("tdd");
    expect(delegateCells.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("igor")).toBeInTheDocument();
  });

  it("displays a human-readable age for each ticket", () => {
    renderWithRouter(<StallsPage entries={sampleEntries} />);
    // age_seconds=7200 → 2h; age_seconds=172800 → 2d
    expect(screen.getByText(/2h/)).toBeInTheDocument();
    expect(screen.getByText(/2d/)).toBeInTheDocument();
  });

  it("displays the breached SLA threshold for each ticket", () => {
    renderWithRouter(<StallsPage entries={sampleEntries} />);
    // threshold_ms=3600000 → 1h; threshold_ms=86400000 → 1d
    expect(screen.getByText(/1h/)).toBeInTheDocument();
    expect(screen.getByText(/1d/)).toBeInTheDocument();
  });

  it("renders column headers for all required fields", () => {
    renderWithRouter(<StallsPage entries={sampleEntries} />);
    expect(screen.getByText(/ticket/i)).toBeInTheDocument();
    expect(screen.getByText(/state/i)).toBeInTheDocument();
    expect(screen.getByText(/delegate/i)).toBeInTheDocument();
    expect(screen.getByText(/age/i)).toBeInTheDocument();
    expect(screen.getByText(/threshold/i)).toBeInTheDocument();
  });
});

describe("AI-1953 AC2: StallsPage — rows link to ticket detail and external Linear", () => {
  it("each row has an internal board detail link", () => {
    const { container } = renderWithRouter(<StallsPage entries={sampleEntries} />);
    const internalLinks = Array.from(container.querySelectorAll("a[href]")).filter(
      (a) => (a as HTMLAnchorElement).href.includes("/board") ||
              (a as HTMLAnchorElement).getAttribute("href")?.includes("/board"),
    );
    // At least one internal link per entry
    expect(internalLinks.length).toBeGreaterThanOrEqual(sampleEntries.length);
  });

  it("each row has an external Linear link", () => {
    const { container } = renderWithRouter(<StallsPage entries={sampleEntries} />);
    const externalLinks = Array.from(container.querySelectorAll("a[href]")).filter(
      (a) => {
        const href = (a as HTMLAnchorElement).href || (a as HTMLAnchorElement).getAttribute("href") || "";
        return href.includes("linear.app");
      },
    );
    expect(externalLinks.length).toBeGreaterThanOrEqual(sampleEntries.length);
  });

  it("external Linear link contains the ticket identifier", () => {
    const { container } = renderWithRouter(<StallsPage entries={[sampleEntries[0]]} />);
    const linearLink = Array.from(container.querySelectorAll("a[href]")).find(
      (a) => {
        const href = (a as HTMLAnchorElement).href || (a as HTMLAnchorElement).getAttribute("href") || "";
        return href.includes("linear.app");
      },
    ) as HTMLAnchorElement | undefined;
    expect(linearLink).toBeDefined();
    const href = linearLink!.href || linearLink!.getAttribute("href") || "";
    expect(href).toContain("AI-1001");
  });
});

describe("AI-1953 AC3: StallsPage — empty state", () => {
  it("renders a non-empty, clean empty-state element when no tickets are stalled", () => {
    renderWithRouter(<StallsPage entries={[]} />);
    const emptyMessage = screen.getByTestId("stalls-empty-state");
    expect(emptyMessage).toBeInTheDocument();
    expect(emptyMessage.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("does not render a table row when there are no stalled tickets", () => {
    const { container } = renderWithRouter(<StallsPage entries={[]} />);
    const rows = container.querySelectorAll("tr[data-testid='stall-row']");
    expect(rows.length).toBe(0);
  });
});
