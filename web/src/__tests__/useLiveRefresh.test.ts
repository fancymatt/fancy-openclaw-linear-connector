/**
 * AI-1952: useLiveRefresh hook — failing tests (write-tests phase).
 *
 * AC3: With the SPA open, a board/fleet/alert change reflects in the UI without
 *      manual reload (evidence: test at hook level).
 * AC4: SSE unavailable → automatic polling fallback, no console errors,
 *      indicator shows degraded mode.
 *
 * The hook lives at web/src/hooks/useLiveRefresh.ts — that file does not exist
 * yet, so all imports below will fail at compile time → tests are RED.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";

// This import will fail until Igor creates web/src/hooks/useLiveRefresh.ts.
import { useLiveRefresh, type LiveRefreshMode } from "../hooks/useLiveRefresh";

// ── MockEventSource ────────────────────────────────────────────────────────
// jsdom does not implement EventSource; we mock it so hook tests control the
// SSE lifecycle without hitting a real server.

interface MockEventSourceInstance {
  url: string;
  onopen: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: Mock;
  close: Mock;
  /** Test helper: fire a named SSE event. */
  triggerEvent(name: string): void;
  /** Test helper: simulate a connection error (triggers SSE fallback). */
  triggerError(): void;
}

let lastMockInstance: MockEventSourceInstance | null = null;

class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Map<string, Array<(e: Event) => void>> = new Map();
  addEventListener = vi.fn((type: string, handler: (e: Event) => void) => {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, handler]);
  });
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    lastMockInstance = this;
    // Simulate async open
    setTimeout(() => this.onopen?.(), 0);
  }

  triggerEvent(name: string): void {
    const handlers = this.listeners.get(name) ?? [];
    const event = new Event(name);
    handlers.forEach((h) => h(event));
  }

  triggerError(): void {
    const event = new Event("error");
    this.onerror?.(event);
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  lastMockInstance = null;
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).EventSource;
  vi.restoreAllMocks();
});

// ── AC3: Live SSE topic routing ────────────────────────────────────────────

describe("AI-1952 AC3: useLiveRefresh — topic-driven invalidation", () => {
  it("connects to /admin/api/stream on mount", () => {
    renderHook(() => useLiveRefresh({}));
    expect(lastMockInstance).not.toBeNull();
    expect(lastMockInstance!.url).toContain("/admin/api/stream");
  });

  it("subscribes to board, fleet, alerts, events, and dead-letters topics", () => {
    renderHook(() => useLiveRefresh({}));
    expect(lastMockInstance).not.toBeNull();
    const subscribedTopics = lastMockInstance!.addEventListener.mock.calls.map(
      (args) => args[0] as string,
    );
    expect(subscribedTopics).toContain("board");
    expect(subscribedTopics).toContain("fleet");
    expect(subscribedTopics).toContain("alerts");
    expect(subscribedTopics).toContain("events");
    expect(subscribedTopics).toContain("dead-letters");
  });

  it("calls onBoard callback when a board topic event arrives", async () => {
    const onBoard = vi.fn();
    renderHook(() => useLiveRefresh({ onBoard }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerEvent("board"));
    expect(onBoard).toHaveBeenCalledTimes(1);
  });

  it("calls onFleet callback when a fleet topic event arrives", async () => {
    const onFleet = vi.fn();
    renderHook(() => useLiveRefresh({ onFleet }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerEvent("fleet"));
    expect(onFleet).toHaveBeenCalledTimes(1);
  });

  it("calls onAlerts callback when an alerts topic event arrives", async () => {
    const onAlerts = vi.fn();
    renderHook(() => useLiveRefresh({ onAlerts }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerEvent("alerts"));
    expect(onAlerts).toHaveBeenCalledTimes(1);
  });

  it("calls onEvents callback when an events topic event arrives", async () => {
    const onEvents = vi.fn();
    renderHook(() => useLiveRefresh({ onEvents }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerEvent("events"));
    expect(onEvents).toHaveBeenCalledTimes(1);
  });

  it("calls onDeadLetters callback when a dead-letters topic event arrives", async () => {
    const onDeadLetters = vi.fn();
    renderHook(() => useLiveRefresh({ onDeadLetters }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerEvent("dead-letters"));
    expect(onDeadLetters).toHaveBeenCalledTimes(1);
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() => useLiveRefresh({}));
    expect(lastMockInstance).not.toBeNull();
    unmount();
    expect(lastMockInstance!.close).toHaveBeenCalled();
  });

  it("exposes mode='live' when SSE is connected", async () => {
    const { result } = renderHook(() => useLiveRefresh({}));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.mode).toBe<LiveRefreshMode>("live");
  });
});

// ── AC4: Polling fallback ──────────────────────────────────────────────────

describe("AI-1952 AC4: useLiveRefresh — polling fallback on SSE failure", () => {
  it("switches to polling mode when SSE connection errors", async () => {
    const { result } = renderHook(() => useLiveRefresh({}));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerError());

    expect(result.current.mode).toBe<LiveRefreshMode>("polling");
  });

  it("fires topic callbacks on a ~30s polling interval in fallback mode", async () => {
    const onBoard = vi.fn();
    const { result } = renderHook(() => useLiveRefresh({ onBoard }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerError());
    expect(result.current.mode).toBe<LiveRefreshMode>("polling");

    // Advance 30s — polling should fire at least once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(onBoard).toHaveBeenCalled();
  });

  it("does not fire console.error during SSE fallback", async () => {
    const consoleSpy = vi.spyOn(console, "error");
    renderHook(() => useLiveRefresh({}));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerError());

    // Allow the fallback tick to run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("closes the EventSource before entering polling mode", async () => {
    renderHook(() => useLiveRefresh({}));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const instance = lastMockInstance!;
    act(() => instance.triggerError());

    expect(instance.close).toHaveBeenCalled();
  });

  it("stops the polling interval on unmount", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useLiveRefresh({}));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => lastMockInstance!.triggerError());
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
