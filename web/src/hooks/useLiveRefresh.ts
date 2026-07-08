import { useEffect, useRef, useState } from "react";

export type LiveRefreshMode = "live" | "polling";

export interface LiveRefreshCallbacks {
  onBoard?: () => void;
  onFleet?: () => void;
  onAlerts?: () => void;
  onEvents?: () => void;
  onDeadLetters?: () => void;
}

export interface LiveRefreshState {
  mode: LiveRefreshMode;
}

const SSE_URL = "/admin/api/stream";
const POLL_INTERVAL_MS = 30_000;

export function useLiveRefresh(callbacks: LiveRefreshCallbacks): LiveRefreshState {
  const [mode, setMode] = useState<LiveRefreshMode>("live");
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setMode("polling");
      const interval = setInterval(() => {
        callbacksRef.current.onBoard?.();
        callbacksRef.current.onFleet?.();
        callbacksRef.current.onAlerts?.();
        callbacksRef.current.onEvents?.();
        callbacksRef.current.onDeadLetters?.();
      }, POLL_INTERVAL_MS);
      return () => clearInterval(interval);
    }

    const es = new EventSource(SSE_URL);
    let pollingInterval: ReturnType<typeof setInterval> | null = null;

    es.onopen = () => {
      setMode("live");
    };

    es.addEventListener("board", () => callbacksRef.current.onBoard?.());
    es.addEventListener("fleet", () => callbacksRef.current.onFleet?.());
    es.addEventListener("alerts", () => callbacksRef.current.onAlerts?.());
    es.addEventListener("events", () => callbacksRef.current.onEvents?.());
    es.addEventListener("dead-letters", () => callbacksRef.current.onDeadLetters?.());

    es.onerror = () => {
      es.close();
      setMode("polling");
      pollingInterval = setInterval(() => {
        callbacksRef.current.onBoard?.();
        callbacksRef.current.onFleet?.();
        callbacksRef.current.onAlerts?.();
        callbacksRef.current.onEvents?.();
        callbacksRef.current.onDeadLetters?.();
      }, POLL_INTERVAL_MS);
    };

    return () => {
      es.close();
      if (pollingInterval !== null) clearInterval(pollingInterval);
    };
  }, []);

  return { mode };
}
