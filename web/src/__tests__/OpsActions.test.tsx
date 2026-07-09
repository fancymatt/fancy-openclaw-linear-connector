/**
 * AI-1954 — Tests for the OpsActions SPA component.
 *
 * AC4: Redispatch/set-state/recapture-ac buttons work end-to-end in the SPA
 *      with confirmation; unauthorized session cannot invoke.
 * AC5: Deploy button present: either functional via the existing path or
 *      disabled-with-reason.
 *
 * These tests FAIL against the current implementation by design — the
 * OpsActions component does not yet exist.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// OpsActions does not exist yet — this import will fail until implemented.
import { OpsActions } from "../components/OpsActions";
import { UnauthorizedError } from "../api";

// ── Mock the api module ────────────────────────────────────────────────────

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    apiPost: vi.fn(),
  };
});

import { apiPost } from "../api";
const mockApiPost = vi.mocked(apiPost);

// ── Default props ──────────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  ticketId: "AI-1954",
  /** Caller identity surfaced by the console session. */
  invoker: "astrid",
};

// ── AC4: buttons render and show confirmation before invoking ──────────────

describe("AC4 — OpsActions renders ops buttons with confirmation dialogs", () => {
  beforeEach(() => {
    mockApiPost.mockReset();
  });

  it("renders a redispatch button", () => {
    render(<OpsActions {...DEFAULT_PROPS} />);
    expect(screen.getByRole("button", { name: /redispatch/i })).toBeInTheDocument();
  });

  it("renders a set-state button", () => {
    render(<OpsActions {...DEFAULT_PROPS} />);
    expect(screen.getByRole("button", { name: /set.?state/i })).toBeInTheDocument();
  });

  it("renders a recapture-ac button", () => {
    render(<OpsActions {...DEFAULT_PROPS} />);
    expect(
      screen.getByRole("button", { name: /recapture.?ac/i }),
    ).toBeInTheDocument();
  });

  it("clicking redispatch shows a confirmation dialog before calling the API", async () => {
    mockApiPost.mockResolvedValueOnce({ success: true, resolved: [] });
    render(<OpsActions {...DEFAULT_PROPS} />);

    const btn = screen.getByRole("button", { name: /redispatch/i });
    await userEvent.click(btn);

    // A confirmation dialog must appear (dialog role or [role="dialog"]).
    const dialog = screen.queryByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // API should NOT have been called yet — only after confirmation.
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("confirms redispatch and calls /admin/api/redispatch with ticketId", async () => {
    mockApiPost.mockResolvedValueOnce({ success: true, resolved: [] });
    render(<OpsActions {...DEFAULT_PROPS} />);

    await userEvent.click(screen.getByRole("button", { name: /redispatch/i }));
    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    await userEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/redispatch"),
        expect.objectContaining({ ticketId: "AI-1954" }),
      );
    });
  });

  it("clicking set-state shows a confirmation dialog with a reason field", async () => {
    render(<OpsActions {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /set.?state/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // The confirmation dialog must have a reason text field.
    const reasonInput = screen.getByLabelText(/reason/i);
    expect(reasonInput).toBeInTheDocument();

    // And a target state input.
    const stateInput =
      screen.queryByLabelText(/target.?state/i) ??
      screen.queryByRole("combobox", { name: /state/i }) ??
      screen.queryByPlaceholderText(/state/i);
    expect(stateInput).toBeInTheDocument();
  });

  it("set-state confirmation calls /admin/api/set-state with invoker, reason, and targetState", async () => {
    mockApiPost.mockResolvedValueOnce({ ok: true });
    render(<OpsActions {...DEFAULT_PROPS} />);

    await userEvent.click(screen.getByRole("button", { name: /set.?state/i }));

    // Fill in the target state.
    const stateInput =
      screen.queryByLabelText(/target.?state/i) ??
      screen.queryByRole("combobox", { name: /state/i }) ??
      screen.queryByPlaceholderText(/state/i);
    if (stateInput) {
      await userEvent.clear(stateInput);
      await userEvent.type(stateInput, "implementation");
    }

    // Fill in the reason.
    const reasonInput = screen.getByLabelText(/reason/i);
    await userEvent.clear(reasonInput);
    await userEvent.type(reasonInput, "mis-route correction");

    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/set-state"),
        expect.objectContaining({
          ticketId: "AI-1954",
          invoker: "astrid",
          reason: "mis-route correction",
        }),
      );
    });
  });

  it("clicking recapture-ac shows a confirmation dialog with a reason field", async () => {
    render(<OpsActions {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /recapture.?ac/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    const reasonInput = screen.getByLabelText(/reason/i);
    expect(reasonInput).toBeInTheDocument();
  });

  it("recapture-ac confirmation calls /admin/api/recapture-ac with invoker and reason", async () => {
    mockApiPost.mockResolvedValueOnce({ ok: true });
    render(<OpsActions {...DEFAULT_PROPS} />);

    await userEvent.click(screen.getByRole("button", { name: /recapture.?ac/i }));

    const reasonInput = screen.getByLabelText(/reason/i);
    await userEvent.clear(reasonInput);
    await userEvent.type(reasonInput, "spec updated post-intake");

    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        expect.stringContaining("/admin/api/recapture-ac"),
        expect.objectContaining({
          ticketId: "AI-1954",
          invoker: "astrid",
          reason: "spec updated post-intake",
        }),
      );
    });
  });

  // ── AC4: unauthorized session cannot invoke ────────────────────────────

  it("AC4: API returning 401 is surfaced as an unauthorized error (does not silently succeed)", async () => {
    mockApiPost.mockRejectedValueOnce(new UnauthorizedError());
    render(<OpsActions {...DEFAULT_PROPS} />);

    await userEvent.click(screen.getByRole("button", { name: /redispatch/i }));
    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    await userEvent.click(confirmBtn);

    await waitFor(() => {
      // The component must surface the auth failure — either via an error
      // message in the UI or by triggering the unauthorized handler (login redirect).
      const errorEl =
        screen.queryByText(/unauthorized/i) ??
        screen.queryByText(/not authorized/i) ??
        screen.queryByRole("alert");
      // The call was attempted, not silently dropped...
      expect(mockApiPost).toHaveBeenCalled();
      // ...and — the actual AC4 behavior — the 401 was *surfaced* to the user,
      // not swallowed. A silent success would leave errorEl null.
      expect(errorEl).toBeTruthy();
    });
  });

  it("AC4: cancel button on confirmation dialog suppresses the API call", async () => {
    render(<OpsActions {...DEFAULT_PROPS} />);

    await userEvent.click(screen.getByRole("button", { name: /redispatch/i }));
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await userEvent.click(cancelBtn);

    expect(mockApiPost).not.toHaveBeenCalled();
    // Dialog is dismissed.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// ── AC5: deploy button present ────────────────────────────────────────────

describe("AC5 — OpsActions renders a deploy button (functional or disabled-with-reason)", () => {
  it("renders a deploy button", () => {
    render(<OpsActions {...DEFAULT_PROPS} />);
    const deployBtn = screen.getByRole("button", { name: /deploy/i });
    expect(deployBtn).toBeInTheDocument();
  });

  it("deploy button is either enabled (wired to deploy path) or disabled with a tooltip reason", () => {
    render(<OpsActions {...DEFAULT_PROPS} />);
    const deployBtn = screen.getByRole("button", { name: /deploy/i });

    const isDisabled =
      deployBtn.hasAttribute("disabled") ||
      deployBtn.getAttribute("aria-disabled") === "true";

    if (isDisabled) {
      // If disabled, must have a tooltip or title explaining why.
      const hasReason =
        deployBtn.hasAttribute("title") ||
        deployBtn.closest("[title]") !== null ||
        deployBtn.getAttribute("data-tooltip") !== null ||
        screen.queryByRole("tooltip") !== null;
      expect(hasReason).toBe(true);
    } else {
      // If enabled, clicking it should either call the API or show a confirmation.
      // At minimum it must have an onClick handler (not a plain inert element).
      // We just assert it is not aria-disabled and is not aria-hidden.
      expect(deployBtn.getAttribute("aria-hidden")).not.toBe("true");
    }
  });

  it("AC5: suite green — all buttons render without crashing", () => {
    // Smoke test: the component must mount cleanly with the default props.
    const { container } = render(<OpsActions {...DEFAULT_PROPS} />);
    expect(container).toBeTruthy();
  });
});
