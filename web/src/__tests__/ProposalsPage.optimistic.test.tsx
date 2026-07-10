/**
 * AI-2040 (P4-C5) — regression coverage for the optimistic-status overlay.
 *
 * Authored by the implementer (Sage), not by tdd. tdd's two files are unchanged.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * tdd's AC5.4 group covers the optimistic update (approve → badge flips with no
 * new props) and the apply-failed state (mount a proposal that is *already*
 * apply-failed → distinct badge + retry). Both pass independently.
 *
 * Neither exercises the sequence a real operator actually walks:
 *
 *     approve  →  overlay says "approved"  →  server confirms failure
 *              →  fresh props arrive with status "apply-failed"
 *
 * That is the ONLY path by which a human reaches apply-failed in the live app —
 * nobody mounts the page onto a pre-failed proposal they just approved. The
 * overlay must yield to the server once the server has spoken, or the operator
 * who approved is the one operator who can never see the failure or retry it.
 *
 * These tests pin that handoff.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ProposalsPage, type Proposal } from "../pages/ProposalsPage";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

const PATCH = [
  "--- a/workflows/dev-impl/write-tests.md",
  "+++ b/workflows/dev-impl/write-tests.md",
  "@@ -12,4 +12,6 @@",
  "-timeout: 4h",
  "+timeout: 8h",
].join("\n");

function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "p-1",
    title: "Add retry guidance for Linear API timeout errors",
    workflowId: "dev-impl",
    stateId: "write-tests",
    status: "pending",
    severity: "HIGH",
    confidenceScore: 0.87,
    createdAt: new Date(NOW - 5 * 3_600_000).toISOString(),
    diffStat: { added: 3, removed: 1 },
    diffs: [{ kind: "guidance", path: "workflows/dev-impl/write-tests.md", patch: PATCH }],
    evidence: [
      { failureType: "Transition rejection", occurrences: 14, timeRange: "Last 7 days", ticketIds: ["AI-1990"] },
    ],
    failureCount: 14,
    version: 7,
    revisions: [],
    rejectionReason: null,
    applyError: null,
    deferredUntil: null,
    ...over,
  };
}

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => mockMatchMedia(false));

const listPane = () => screen.getByTestId("proposal-list-pane");
const detailPane = () => screen.getByTestId("proposal-detail-pane");

function renderPage(proposals: Proposal[]) {
  const props = {
    proposals,
    now: NOW,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onRevise: vi.fn(),
    onDefer: vi.fn(),
    onRetryApply: vi.fn(),
  } as React.ComponentProps<typeof ProposalsPage>;

  const utils = render(
    <MemoryRouter>
      <ProposalsPage {...props} />
    </MemoryRouter>,
  );

  const rerenderWith = (next: Proposal[]) =>
    utils.rerender(
      <MemoryRouter>
        <ProposalsPage {...props} proposals={next} />
      </MemoryRouter>,
    );

  return { ...utils, props, rerenderWith, user: userEvent.setup() };
}

/** approve the single rendered proposal, through the confirmation dialog */
async function approve(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(within(listPane()).getByRole("option", { name: new RegExp(title, "i") }));
  await user.click(within(detailPane()).getByRole("button", { name: /^approve$/i }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /confirm|approve/i }));
}

describe("AI-2040 AC5.4: the optimistic overlay must yield to server-confirmed status", () => {
  it("surfaces apply-failed (with retry) after approving, once the server reports the failure", async () => {
    const pending = makeProposal();
    const { user, props, rerenderWith } = renderPage([pending]);

    await approve(user, pending.title);
    // Optimistic: no new props yet, so the operator sees their own action.
    expect(within(listPane()).getByTestId("proposal-card-p-1")).toHaveTextContent(/approved/i);

    // The apply pipeline fails; the next poll delivers the real status.
    rerenderWith([{ ...pending, status: "apply-failed", applyError: "TOCTOU mismatch: guidance file changed" }]);

    // The card now lives in History. Go find it there.
    await user.click(screen.getByRole("tab", { name: /history/i }));
    await user.click(within(listPane()).getByRole("option", { name: new RegExp(pending.title, "i") }));

    const badge = within(listPane()).getByTestId("proposal-card-p-1").querySelector("[data-testid='status-badge']");
    expect(badge).toHaveTextContent(/apply\s*failed/i);
    expect(badge).not.toHaveTextContent(/^approved$/i);

    // The whole point of AC5.4: the operator can retry the thing they approved.
    const retry = within(detailPane()).getByRole("button", { name: /retry/i });
    await user.click(retry);
    expect(props.onRetryApply).toHaveBeenCalledWith("p-1");
  });

  it("settles an approved proposal into 'applied' once the server confirms success", async () => {
    const pending = makeProposal();
    const { user, rerenderWith } = renderPage([pending]);

    await approve(user, pending.title);
    rerenderWith([{ ...pending, status: "applied" }]);

    await user.click(screen.getByRole("tab", { name: /history/i }));
    const badge = within(listPane()).getByTestId("proposal-card-p-1").querySelector("[data-testid='status-badge']");
    expect(badge).toHaveTextContent(/applied/i);
  });

  it("keeps showing the optimistic status while the server still reports the old one", async () => {
    const pending = makeProposal();
    const { user, rerenderWith } = renderPage([pending]);

    await approve(user, pending.title);
    // An unrelated poll arrives; this proposal has not moved server-side yet.
    rerenderWith([{ ...pending, failureCount: 15 }]);

    expect(within(listPane()).getByTestId("proposal-card-p-1")).toHaveTextContent(/approved/i);
  });
});
