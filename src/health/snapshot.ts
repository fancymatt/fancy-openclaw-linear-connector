/**
 * INF-322 — Aggregate health snapshot endpoint.
 *
 * Provides GET /health/snapshot returning per-task health entries for all
 * tracked tasks (pickup/completion gates). Currently returns an empty task
 * array; the task-registration infrastructure will populate it as sibling
 * health contracts land (INF-318, INF-319).
 *
 * Liveness is surfaced at /health as healthSnapshot.active === true, proving
 * the route is wired at bootstrap without waiting for a health event.
 */

import { Router, Request, Response } from "express";

// ── Types ───────────────────────────────────────────────────────────────────

export type Gate = "pickup" | "completion";

export interface ExpectedSignal {
  type: string;
  deadline: string; // ISO timestamp
}

export interface ActualObserved {
  signal: string | null;
  at: string | null; // ISO timestamp
}

export type HealthStatus = "healthy" | "healthy-suppressed" | "unhealthy";

export interface Remediation {
  action: string | null;
  status: string | null;
}

export interface HealthSnapshotTask {
  gate: Gate;
  expectedSignal: ExpectedSignal;
  actualObserved: ActualObserved;
  health: HealthStatus;
  healthDetail?: string;
  failureClass: string | null;
  remediation: Remediation;
}

export interface HealthSnapshotResponse {
  tasks: HealthSnapshotTask[];
  generatedAt: string; // ISO timestamp
}

export interface HealthSnapshotLiveness {
  active: boolean;
}

// ── In-memory state ─────────────────────────────────────────────────────────

let active = false;

/** Mark the snapshot endpoint as wired (called at bootstrap). */
export function registerSnapshot(): void {
  active = true;
}

export function getSnapshotLiveness(): HealthSnapshotLiveness {
  return { active };
}

/** Reset for test isolation. */
export function resetSnapshotState(): void {
  active = false;
}

// ── Route factory ───────────────────────────────────────────────────────────

export function createHealthSnapshotRouter(): Router {
  const router = Router();

  /**
   * GET /health/snapshot
   *
   * Returns the aggregate health snapshot of all tracked tasks. Each entry
   * describes one gate (pickup or completion) with its expected signal,
   * actual observation, derived health status, failure classification, and
   * active remediation.
   *
   * When no tasks are tracked (healthy/empty state), returns an empty array.
   */
  router.get("/snapshot", (_req: Request, res: Response) => {
    const response: HealthSnapshotResponse = {
      tasks: [], // populated as INF-318/319 land
      generatedAt: new Date().toISOString(),
    };
    res.status(200).json(response);
  });

  return router;
}
