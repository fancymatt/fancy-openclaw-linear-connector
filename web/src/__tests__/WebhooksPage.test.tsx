/**
 * AI-1986 — WebhooksPage tests
 *
 * Presentational contract for the /admin/webhooks self-service page. Mirrors the
 * StallsPage pattern: the page is a pure component driven by props so it can be
 * tested without the network. Data fetching / auth wiring lives in App.tsx.
 *
 * Contract defined here:
 *   <WebhooksPage
 *      webhooks={WebhookRow[]}
 *      onAdd={(input: { url: string; secret: string; teamLabel: string }) => void}
 *      onDelete={(id: string) => void}
 *   />
 *   WebhookRow = { id, url, teamLabel, secretPreview, lastSeen } — matches the
 *   GET /admin/api/webhooks row shape from the backend contract.
 *
 * AC1: list renders url / team label / masked secret / last-seen per webhook.
 * AC2: add form has url + secret + (optional) team label; valid submit calls onAdd.
 * AC3: each row has a delete button behind a confirmation; confirm → onDelete(id).
 *
 * Tests import from the implementation path and fail until WebhooksPage.tsx exists.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WebhooksPage } from "../pages/WebhooksPage";

export interface WebhookRow {
  id: string;
  url: string;
  teamLabel: string;
  secretPreview: string;
  lastSeen: string | null;
}

const sampleWebhooks: WebhookRow[] = [
  {
    id: "wh_1",
    url: "https://linear-webhook.fancymatt.com/webhook",
    teamLabel: "Private Team A",
    secretPreview: "lin_wh_…Sjo",
    lastSeen: "2026-07-08T04:00:00.000Z",
  },
  {
    id: "wh_2",
    url: "https://other.fancymatt.com/hook",
    teamLabel: "Team B",
    secretPreview: "lin_wh_…9Qz",
    lastSeen: null,
  },
];

function renderPage(props: Partial<React.ComponentProps<typeof WebhooksPage>> = {}) {
  const merged = {
    webhooks: sampleWebhooks,
    onAdd: vi.fn(),
    onDelete: vi.fn(),
    ...props,
  } as React.ComponentProps<typeof WebhooksPage>;
  const utils = render(<MemoryRouter><WebhooksPage {...merged} /></MemoryRouter>);
  return { ...utils, props: merged };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI-1986 AC1: WebhooksPage — list of registered webhooks", () => {
  it("renders a row for each registered webhook (by URL)", () => {
    renderPage();
    expect(screen.getByText("https://linear-webhook.fancymatt.com/webhook")).toBeInTheDocument();
    expect(screen.getByText("https://other.fancymatt.com/hook")).toBeInTheDocument();
  });

  it("shows the team label for each webhook", () => {
    renderPage();
    expect(screen.getByText("Private Team A")).toBeInTheDocument();
    expect(screen.getByText("Team B")).toBeInTheDocument();
  });

  it("shows the masked secret preview, never a full secret", () => {
    renderPage();
    expect(screen.getByText("lin_wh_…Sjo")).toBeInTheDocument();
    expect(screen.getByText("lin_wh_…9Qz")).toBeInTheDocument();
  });

  it("renders an empty-state element when there are no webhooks", () => {
    renderPage({ webhooks: [] });
    const empty = screen.getByTestId("webhooks-empty-state");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe("AI-1986 AC2: WebhooksPage — add webhook form", () => {
  it("renders inputs for URL, signing secret, and team label", () => {
    renderPage();
    expect(screen.getByLabelText(/webhook url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/signing secret/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/team label/i)).toBeInTheDocument();
  });

  it("calls onAdd with { url, secret, teamLabel } on a valid submit", () => {
    const onAdd = vi.fn();
    renderPage({ onAdd });
    fireEvent.change(screen.getByLabelText(/webhook url/i), {
      target: { value: "https://new.fancymatt.com/hook" },
    });
    fireEvent.change(screen.getByLabelText(/signing secret/i), {
      target: { value: "lin_wh_new_secret_1234" },
    });
    fireEvent.change(screen.getByLabelText(/team label/i), {
      target: { value: "New Team" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add webhook/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({
      url: "https://new.fancymatt.com/hook",
      secret: "lin_wh_new_secret_1234",
      teamLabel: "New Team",
    });
  });

  it("does not call onAdd when the secret is empty (client-side guard)", () => {
    const onAdd = vi.fn();
    renderPage({ onAdd });
    fireEvent.change(screen.getByLabelText(/webhook url/i), {
      target: { value: "https://new.fancymatt.com/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add webhook/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("does not call onAdd when the URL is not HTTPS (client-side guard)", () => {
    const onAdd = vi.fn();
    renderPage({ onAdd });
    fireEvent.change(screen.getByLabelText(/webhook url/i), {
      target: { value: "http://insecure.example.com/hook" },
    });
    fireEvent.change(screen.getByLabelText(/signing secret/i), {
      target: { value: "lin_wh_new_secret_1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add webhook/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("AI-1986 AC3: WebhooksPage — remove webhook with confirmation", () => {
  it("renders a delete button for each webhook row", () => {
    renderPage();
    expect(screen.getByTestId("webhook-delete-wh_1")).toBeInTheDocument();
    expect(screen.getByTestId("webhook-delete-wh_2")).toBeInTheDocument();
  });

  it("calls onDelete with the webhook id when deletion is confirmed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDelete = vi.fn();
    renderPage({ onDelete });
    fireEvent.click(screen.getByTestId("webhook-delete-wh_1"));
    expect(onDelete).toHaveBeenCalledWith("wh_1");
  });

  it("does not call onDelete when the confirmation is dismissed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDelete = vi.fn();
    renderPage({ onDelete });
    fireEvent.click(screen.getByTestId("webhook-delete-wh_2"));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("targets the correct id when multiple rows are present", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDelete = vi.fn();
    renderPage({ onDelete });
    const secondRow = screen.getByTestId("webhook-delete-wh_2");
    fireEvent.click(within(secondRow.closest("[data-testid='webhook-row']") ?? secondRow).getByTestId("webhook-delete-wh_2"));
    expect(onDelete).toHaveBeenCalledWith("wh_2");
  });
});
