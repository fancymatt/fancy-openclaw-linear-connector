/**
 * AI-2040 (P4-C5) — Review queue console UI: /admin/proposals
 *
 * These tests encode the AC of record captured at intake (AI-2021 comment
 * f8509c33), resolved against Laren's consolidated design brief (AI-2029,
 * 04:07:03 UTC — the consolidation governs where the 04:03 drafts conflict)
 * and Astrid's five UX decisions (AI-2028, 04:07 UTC).
 *
 * AC → test-group mapping (one group per AC; see `describe` titles):
 *   AC5.1  split-pane layout, fixed list width, stacks below 900px
 *          (nav entry + pending badge + route reachability → ProposalsNav.test.tsx)
 *   AC5.2  list cards: PENDING badge, workflow/state pill, title, diff stat,
 *          severity, relative age — and NO Approve from the list
 *   AC5.3  detail view: guidance plain-text diff, YAML structured diff, evidence
 *          cluster + impacted-ticket links, plain confidence number, sticky bar
 *   AC5.4  approve → confirm dialog → apply invoked; optimistic update + toast;
 *          apply-failed distinct state + retry; History distinguishes applied
 *          from apply-failed
 *   AC5.5  reject requires a reason (quick-picks + free text, no char minimum);
 *          archives to History with the reason visible
 *   AC5.6  revise requires feedback; in-place revision history, no replacement card
 *   AC5.7  Pending/History tabs; sort severity-desc, oldest-first within tier;
 *          filter by status and workflow; defer presets; deferred card returns "New"
 *   AC5.8  keyboard navigation (arrows/Enter/Escape) + focus trap in reject/revise
 *
 * COMPONENT CONTRACT (defined here, consumed by the implementer):
 *   <ProposalsPage
 *      proposals={Proposal[]}
 *      now={number}                              // epoch ms, for deterministic relative age
 *      onApprove={(id: string) => void}
 *      onReject={(id: string, reason: string) => void}
 *      onRevise={(id: string, feedback: string) => void}
 *      onDefer={(id: string, intervalMs: number) => void}
 *      onRetryApply={(id: string) => void}
 *   />
 *
 * ProposalsPage is a pure, prop-driven component — the same pattern as
 * StallsPage and WebhooksPage. Data fetching and the apply/retry API calls are
 * wired in App.tsx. The `Proposal` view model below is the frontend-owned shape;
 * App.tsx adapts C3's stored proposal record (AI-2038, Igor's contract comment
 * 05:04:29 UTC) into it. Status strings are C3's exact wire strings.
 *
 * Tests import from the implementation path and fail until ProposalsPage.tsx exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ProposalsPage, type Proposal } from "../pages/ProposalsPage";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Fixed clock so "5h ago" is deterministic. */
const NOW = Date.parse("2026-07-10T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const GUIDANCE_PATCH = [
  "--- a/workflows/dev-impl/write-tests.md",
  "+++ b/workflows/dev-impl/write-tests.md",
  "@@ -12,4 +12,6 @@",
  " Run the verb to hand off:",
  "-timeout: 4h",
  "+timeout: 8h",
  "+Wait 5s before retrying 429 responses from the Linear API.",
].join("\n");

const YAML_PATCH = [
  "--- a/workflows/dev-impl.yaml",
  "+++ b/workflows/dev-impl.yaml",
  "@@ -1,3 +1,3 @@",
  " id: dev-impl",
  "-version: 7",
  "+version: 8",
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
    createdAt: hoursAgo(5),
    diffStat: { added: 3, removed: 1 },
    diffs: [{ kind: "guidance", path: "workflows/dev-impl/write-tests.md", patch: GUIDANCE_PATCH }],
    evidence: [
      {
        failureType: "Transition rejection",
        occurrences: 14,
        timeRange: "Last 7 days",
        ticketIds: ["AI-1990", "AI-1991", "AI-1992"],
      },
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

/** Four pending proposals spanning severity tiers and ages, for sort/filter tests. */
const highOld = makeProposal({ id: "p-high-old", title: "High severity, oldest", severity: "HIGH", createdAt: hoursAgo(5) });
const highNew = makeProposal({ id: "p-high-new", title: "High severity, newest", severity: "HIGH", createdAt: hoursAgo(1), stateId: "implementation" });
const medium = makeProposal({ id: "p-med", title: "Medium severity", severity: "MEDIUM", createdAt: hoursAgo(2), workflowId: "dev-sprint", stateId: "arms" });
const low = makeProposal({ id: "p-low", title: "Low severity", severity: "LOW", createdAt: hoursAgo(8), stateId: "review" });

const applied = makeProposal({ id: "p-applied", title: "Applied cleanly", status: "applied", severity: "MEDIUM" });
const applyFailed = makeProposal({
  id: "p-apply-failed",
  title: "Approved but apply blew up",
  status: "apply-failed",
  applyError: "TOCTOU mismatch: guidance file changed since generation",
});
const rejected = makeProposal({
  id: "p-rejected",
  title: "Rejected proposal",
  status: "rejected",
  rejectionReason: "Too aggressive — 8h exceeds the ticket SLA",
});

function renderPage(over: Partial<React.ComponentProps<typeof ProposalsPage>> = {}) {
  const props = {
    proposals: [highOld, highNew, medium, low],
    now: NOW,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onRevise: vi.fn(),
    onDefer: vi.fn(),
    onRetryApply: vi.fn(),
    ...over,
  } as React.ComponentProps<typeof ProposalsPage>;
  const utils = render(
    <MemoryRouter>
      <ProposalsPage {...props} />
    </MemoryRouter>,
  );
  return { ...utils, props, user: userEvent.setup() };
}

const listPane = () => screen.getByTestId("proposal-list-pane");
const detailPane = () => screen.getByTestId("proposal-detail-pane");

/** Select a proposal card by title — the precondition for every detail-pane action. */
async function selectCard(user: ReturnType<typeof userEvent.setup>, title: string | RegExp) {
  await user.click(within(listPane()).getByRole("option", { name: new RegExp(title, "i") }));
}

/**
 * The page reads `window.matchMedia("(max-width: …)")` to decide split vs stacked.
 * jsdom has no implementation, so each test installs one. `matches` is returned for
 * any query, so the exact breakpoint string is not baked into the test — only the
 * behavior that a matching narrow-viewport query produces the stacked layout.
 */
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── AC5.1 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.1: persistent split-pane layout", () => {
  it("renders a list pane and a detail pane side by side", () => {
    renderPage();
    expect(screen.getByTestId("proposals-layout")).toHaveAttribute("data-layout", "split");
    expect(listPane()).toBeInTheDocument();
    expect(detailPane()).toBeInTheDocument();
  });

  it("fixes the list pane width between 300 and 360px", () => {
    renderPage();
    const width = screen.getByTestId("proposals-layout").style.getPropertyValue("--proposal-list-width");
    expect(width).toMatch(/^\d+px$/);
    const px = Number.parseInt(width, 10);
    expect(px).toBeGreaterThanOrEqual(300);
    expect(px).toBeLessThanOrEqual(360);
  });

  it("stacks the panes when the narrow-viewport media query matches", () => {
    mockMatchMedia(true);
    renderPage();
    expect(screen.getByTestId("proposals-layout")).toHaveAttribute("data-layout", "stacked");
  });
});

// ── AC5.2 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.2: list cards", () => {
  it("renders an amber PENDING badge with an accessible full-state label", () => {
    renderPage({ proposals: [highOld] });
    const card = within(listPane()).getByTestId("proposal-card-p-high-old");
    const badge = within(card).getByTestId("status-badge");
    expect(badge).toHaveTextContent(/pending/i);
    expect(badge).toHaveAttribute("data-tone", "amber");
    expect(badge).toHaveAccessibleName(/awaiting review|pending/i);
  });

  it("renders the workflow/state pill, title, diff stat, severity and relative age", () => {
    renderPage({ proposals: [highOld] });
    const card = within(listPane()).getByTestId("proposal-card-p-high-old");
    expect(within(card).getByTestId("workflow-state-pill")).toHaveTextContent("dev-impl / write-tests");
    expect(within(card).getByText("High severity, oldest")).toBeInTheDocument();
    expect(within(card).getByTestId("diff-stat")).toHaveTextContent("+3");
    expect(within(card).getByTestId("diff-stat")).toHaveTextContent("-1");
    expect(within(card).getByTestId("severity-badge")).toHaveTextContent(/high/i);
    expect(within(card).getByTestId("relative-age")).toHaveTextContent(/5h ago/i);
  });

  it("exposes NO Approve control anywhere in the list pane (core failure-mode guard)", () => {
    renderPage();
    expect(within(listPane()).queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("exposes no Reject or Revise control in the list pane either", () => {
    renderPage();
    expect(within(listPane()).queryByRole("button", { name: /reject/i })).toBeNull();
    expect(within(listPane()).queryByRole("button", { name: /revise/i })).toBeNull();
  });

  it("only offers Approve once a proposal is selected and its diff is rendered", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();

    await selectCard(user, "High severity, oldest");

    expect(within(detailPane()).getByTestId("diff-block-guidance")).toBeInTheDocument();
    expect(within(detailPane()).getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
  });
});

// ── AC5.3 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.3: detail view", () => {
  it("renders a guidance change as a labeled plain-text diff with +/- gutters", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");

    const block = within(detailPane()).getByTestId("diff-block-guidance");
    expect(within(block).getByText(/guidance file/i)).toBeInTheDocument();
    expect(block).toHaveTextContent("workflows/dev-impl/write-tests.md");
    // Not colour alone: +/- must be present as text in the gutter.
    expect(within(block).getAllByTestId("diff-line-added").length).toBeGreaterThan(0);
    expect(within(block).getAllByTestId("diff-line-removed").length).toBeGreaterThan(0);
    expect(within(block).getAllByTestId("diff-line-added")[0]).toHaveTextContent(/^\+/);
    expect(within(block).getAllByTestId("diff-line-removed")[0]).toHaveTextContent(/^-/);
  });

  it("renders a YAML change as a structured diff, distinct from the guidance renderer", async () => {
    const yamlOnly = makeProposal({
      id: "p-yaml",
      title: "Bump workflow version",
      diffs: [{ kind: "yaml", path: "workflows/dev-impl.yaml", patch: YAML_PATCH }],
    });
    const { user } = renderPage({ proposals: [yamlOnly] });
    await selectCard(user, "Bump workflow version");

    const block = within(detailPane()).getByTestId("diff-block-yaml");
    expect(within(block).getByText(/schema yaml/i)).toBeInTheDocument();
    // Structured: keys are addressable, not just raw text lines.
    expect(within(block).getByTestId("yaml-key-version")).toHaveTextContent(/7/);
    expect(within(block).getByTestId("yaml-key-version")).toHaveTextContent(/8/);
    expect(within(detailPane()).queryByTestId("diff-block-guidance")).toBeNull();
  });

  it("stacks both diff blocks when a proposal touches guidance and YAML", async () => {
    const both = makeProposal({
      id: "p-both",
      title: "Touches both surfaces",
      diffs: [
        { kind: "guidance", path: "workflows/dev-impl/write-tests.md", patch: GUIDANCE_PATCH },
        { kind: "yaml", path: "workflows/dev-impl.yaml", patch: YAML_PATCH },
      ],
    });
    const { user } = renderPage({ proposals: [both] });
    await selectCard(user, "Touches both surfaces");

    expect(within(detailPane()).getByTestId("diff-block-guidance")).toBeInTheDocument();
    expect(within(detailPane()).getByTestId("diff-block-yaml")).toBeInTheDocument();
  });

  it("breaks down the evidence cluster with failure type, count, range and ticket links", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");

    const cluster = within(detailPane()).getByTestId("evidence-cluster");
    expect(cluster).toHaveTextContent(/transition rejection/i);
    expect(cluster).toHaveTextContent(/14/);
    expect(cluster).toHaveTextContent(/last 7 days/i);
    for (const id of ["AI-1990", "AI-1991", "AI-1992"]) {
      expect(within(cluster).getByRole("link", { name: id })).toHaveAttribute("href", expect.stringContaining(id));
    }
  });

  it("shows confidence as a plain labeled number and never as a gauge or bar", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");

    const confidence = within(detailPane()).getByTestId("confidence");
    expect(confidence).toHaveTextContent(/confidence/i);
    expect(confidence).toHaveTextContent("87 / 100");
    expect(within(detailPane()).queryByRole("progressbar")).toBeNull();
    expect(within(detailPane()).queryByRole("meter")).toBeNull();
    expect(detailPane().querySelector("meter, progress")).toBeNull();
  });

  it("pins the action bar to the bottom of the detail pane", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");

    const bar = within(detailPane()).getByTestId("action-bar");
    expect(bar).toHaveAttribute("data-sticky", "true");
    for (const name of [/^approve$/i, /^reject$/i, /^revise$/i, /^defer$/i]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("renders an empty state in the detail pane when nothing is selected", () => {
    renderPage({ proposals: [] });
    expect(within(detailPane()).getByText(/no proposals pending review/i)).toBeInTheDocument();
  });
});

// ── AC5.4 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.4: approve → confirm → apply, optimistic update, apply-failed + retry", () => {
  it("opens a confirmation dialog and does not invoke apply until confirmed", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^approve$/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/dev-impl/i);
    expect(props.onApprove).not.toHaveBeenCalled();
  });

  it("cancelling the confirmation leaves the proposal pending and apply uninvoked", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^approve$/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /cancel/i }));

    expect(props.onApprove).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    const card = within(listPane()).getByTestId("proposal-card-p-high-old");
    expect(within(card).getByTestId("status-badge")).toHaveTextContent(/pending/i);
  });

  it("confirming invokes the apply pipeline with the proposal id", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^approve$/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /confirm|approve/i }));

    expect(props.onApprove).toHaveBeenCalledTimes(1);
    expect(props.onApprove).toHaveBeenCalledWith("p-high-old");
  });

  it("optimistically updates the card and announces a toast without new props", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^approve$/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /confirm|approve/i }));

    // Same props — the page must reflect the approval itself.
    expect(await screen.findByRole("status")).toHaveTextContent(/approved/i);
    expect(within(listPane()).getByTestId("proposal-card-p-high-old")).toHaveTextContent(/approved/i);
  });

  it("renders apply-failed as a distinct state, not as approved or applied", async () => {
    const { user } = renderPage({ proposals: [applyFailed] });
    await user.click(screen.getByRole("tab", { name: /history/i }));
    await selectCard(user, "Approved but apply blew up");

    const badge = within(listPane()).getByTestId("proposal-card-p-apply-failed").querySelector("[data-testid='status-badge']");
    expect(badge).toHaveTextContent(/apply.?failed/i);
    expect(within(detailPane()).getByText(/TOCTOU mismatch/i)).toBeInTheDocument();
  });

  it("offers a retry affordance on apply-failed that invokes onRetryApply", async () => {
    const { user, props } = renderPage({ proposals: [applyFailed] });
    await user.click(screen.getByRole("tab", { name: /history/i }));
    await selectCard(user, "Approved but apply blew up");
    await user.click(within(detailPane()).getByRole("button", { name: /retry/i }));

    expect(props.onRetryApply).toHaveBeenCalledWith("p-apply-failed");
  });

  it("History distinguishes 'approved, applied' from 'approved, apply failed'", async () => {
    const { user } = renderPage({ proposals: [applied, applyFailed] });
    await user.click(screen.getByRole("tab", { name: /history/i }));

    expect(within(listPane()).getByTestId("proposal-card-p-applied")).toHaveTextContent(/approved,\s*applied/i);
    expect(within(listPane()).getByTestId("proposal-card-p-apply-failed")).toHaveTextContent(/approved,\s*apply failed/i);
  });
});

// ── AC5.5 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.5: reject requires a reason", () => {
  it("blocks submission with an empty reason and does not invoke onReject", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^reject$/i }));

    const form = screen.getByRole("dialog", { name: /reject/i });
    await user.click(within(form).getByRole("button", { name: /reject proposal|submit/i }));

    expect(props.onReject).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /reject/i })).toBeInTheDocument();
  });

  it("offers quick-pick reasons that populate the reason field", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^reject$/i }));

    const form = screen.getByRole("dialog", { name: /reject/i });
    const quickPicks = within(form).getAllByTestId("reject-quick-pick");
    expect(quickPicks.length).toBeGreaterThanOrEqual(2);

    const picked = quickPicks[0].textContent ?? "";
    await user.click(quickPicks[0]);
    expect(within(form).getByRole("textbox", { name: /reason/i })).toHaveValue(picked);

    await user.click(within(form).getByRole("button", { name: /reject proposal|submit/i }));
    expect(props.onReject).toHaveBeenCalledWith("p-high-old", picked);
  });

  it("accepts free text with no character minimum (a single character submits)", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^reject$/i }));

    const form = screen.getByRole("dialog", { name: /reject/i });
    await user.type(within(form).getByRole("textbox", { name: /reason/i }), "x");
    await user.click(within(form).getByRole("button", { name: /reject proposal|submit/i }));

    expect(props.onReject).toHaveBeenCalledWith("p-high-old", "x");
  });

  it("archives a rejected proposal to History with its reason visible", async () => {
    const { user } = renderPage({ proposals: [rejected] });
    // Rejected proposals leave the Pending queue entirely.
    expect(within(listPane()).queryByTestId("proposal-card-p-rejected")).toBeNull();

    await user.click(screen.getByRole("tab", { name: /history/i }));
    const card = within(listPane()).getByTestId("proposal-card-p-rejected");
    expect(card).toHaveTextContent(/rejected/i);
    expect(card).toHaveTextContent(/too aggressive/i);
  });
});

// ── AC5.6 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.6: revise requires feedback and revises in place", () => {
  it("blocks submission with empty feedback and does not invoke onRevise", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^revise$/i }));

    const form = screen.getByRole("dialog", { name: /revise/i });
    await user.click(within(form).getByRole("button", { name: /send|submit/i }));

    expect(props.onRevise).not.toHaveBeenCalled();
  });

  it("submits feedback text with the proposal id", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^revise$/i }));

    const form = screen.getByRole("dialog", { name: /revise/i });
    await user.type(within(form).getByRole("textbox", { name: /feedback|what should/i }), "8h is too long — try 6h.");
    await user.click(within(form).getByRole("button", { name: /send|submit/i }));

    expect(props.onRevise).toHaveBeenCalledWith("p-high-old", "8h is too long — try 6h.");
  });

  it("shows in-place revision history on the proposal — one card, no replacement", async () => {
    const revising = makeProposal({
      id: "p-revising",
      title: "Under revision",
      status: "in-revision",
      version: 2,
      revisions: [
        { version: 1, feedback: "8h is too long — try 6h.", createdAt: hoursAgo(3) },
        { version: 2, feedback: "Cite the SLA doc.", createdAt: hoursAgo(1) },
      ],
    });
    const { user } = renderPage({ proposals: [revising] });

    // In-revision stays in the Pending queue as exactly one card.
    expect(within(listPane()).getAllByTestId(/^proposal-card-/)).toHaveLength(1);

    await selectCard(user, "Under revision");
    const history = within(detailPane()).getByTestId("revision-history");
    expect(within(history).getByText(/8h is too long/i)).toBeInTheDocument();
    expect(within(history).getByText(/cite the SLA doc/i)).toBeInTheDocument();
    expect(within(history).getAllByTestId("revision-entry")).toHaveLength(2);
  });
});

// ── AC5.7 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.7: tabs, sort, filter, defer", () => {
  it("renders Pending and History tabs, defaulting to Pending", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: /pending/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /history/i })).toHaveAttribute("aria-selected", "false");
  });

  it("sorts severity-descending, oldest-first within a tier", () => {
    renderPage();
    const titles = within(listPane())
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-proposal-id"));
    expect(titles).toEqual(["p-high-old", "p-high-new", "p-med", "p-low"]);
  });

  it("filters by workflow", async () => {
    const { user } = renderPage();
    await user.selectOptions(screen.getByRole("combobox", { name: /workflow/i }), "dev-sprint");

    expect(within(listPane()).getAllByRole("option")).toHaveLength(1);
    expect(within(listPane()).getByTestId("proposal-card-p-med")).toBeInTheDocument();
  });

  it("filters by status within History", async () => {
    const { user } = renderPage({ proposals: [applied, rejected, applyFailed] });
    await user.click(screen.getByRole("tab", { name: /history/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: /status/i }), "rejected");

    expect(within(listPane()).getAllByRole("option")).toHaveLength(1);
    expect(within(listPane()).getByTestId("proposal-card-p-rejected")).toBeInTheDocument();
  });

  it("offers preset defer intervals and reports the chosen interval in ms", async () => {
    const { user, props } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^defer$/i }));

    const presets = screen.getByTestId("defer-presets");
    expect(within(presets).getByRole("button", { name: /1 day/i })).toBeInTheDocument();
    expect(within(presets).getByRole("button", { name: /3 days/i })).toBeInTheDocument();
    expect(within(presets).getByRole("button", { name: /1 week/i })).toBeInTheDocument();

    await user.click(within(presets).getByRole("button", { name: /3 days/i }));
    expect(props.onDefer).toHaveBeenCalledWith("p-high-old", 3 * 86_400_000);
  });

  it("hides a proposal deferred into the future from the Pending queue", () => {
    const deferred = makeProposal({ id: "p-deferred", title: "Deferred away", deferredUntil: new Date(NOW + 86_400_000).toISOString() });
    renderPage({ proposals: [deferred] });
    expect(within(listPane()).queryByTestId("proposal-card-p-deferred")).toBeNull();
  });

  it("returns an elapsed deferral to the queue marked as New", () => {
    const returned = makeProposal({ id: "p-returned", title: "Back from deferral", deferredUntil: new Date(NOW - 1_000).toISOString() });
    renderPage({ proposals: [returned] });
    const card = within(listPane()).getByTestId("proposal-card-p-returned");
    expect(card).toHaveTextContent(/new/i);
    expect(card).toHaveAttribute("data-new", "true");
  });
});

// ── AC5.8 ───────────────────────────────────────────────────────────────────

describe("AI-2040 AC5.8: keyboard navigation and focus management", () => {
  it("exposes the card list as a listbox of options", () => {
    renderPage();
    expect(within(listPane()).getByRole("listbox")).toBeInTheDocument();
    expect(within(listPane()).getAllByRole("option")).toHaveLength(4);
  });

  it("moves focus between cards with ArrowDown / ArrowUp", async () => {
    const { user } = renderPage();
    const options = within(listPane()).getAllByRole("option");

    options[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(options[1]);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(options[0]);
  });

  it("selects the focused card with Enter", async () => {
    const { user } = renderPage();
    const options = within(listPane()).getAllByRole("option");

    options[0].focus();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(detailPane()).toHaveTextContent("High severity, newest");
  });

  it("closes an open reject form with Escape and restores focus to the Reject button", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    const rejectButton = within(detailPane()).getByRole("button", { name: /^reject$/i });
    await user.click(rejectButton);

    expect(screen.getByRole("dialog", { name: /reject/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: /reject/i })).toBeNull();
    expect(document.activeElement).toBe(rejectButton);
  });

  it("traps focus inside the reject form while it is open", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^reject$/i }));

    const form = screen.getByRole("dialog", { name: /reject/i });
    // Cycle well past the number of focusables; focus must never escape the dialog.
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(form.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(form.contains(document.activeElement)).toBe(true);
  });

  it("traps focus inside the revise form while it is open", async () => {
    const { user } = renderPage({ proposals: [highOld] });
    await selectCard(user, "High severity, oldest");
    await user.click(within(detailPane()).getByRole("button", { name: /^revise$/i }));

    const form = screen.getByRole("dialog", { name: /revise/i });
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(form.contains(document.activeElement)).toBe(true);
    }
  });

  it("ships no access-control UI (single-operator console, UX decision #5)", () => {
    renderPage();
    // Anchor on the rendered page first: a bare absence assertion would pass against
    // a component that renders nothing at all.
    expect(screen.getByTestId("proposals-layout")).toBeInTheDocument();
    expect(screen.queryByText(/access control|permissions|manage users|invite/i)).toBeNull();
  });
});
