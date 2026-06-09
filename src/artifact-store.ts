/**
 * Phase 6 / C-2 — Artifact-binding store (AI-1472).
 *
 * Connector-side source of truth for bound sprint-plan artifacts.
 * Per §4.2, the connector records the artifact reference at intake.accept
 * and the §5.6 validating gate reads it back.
 *
 * Storage is in-memory with optional JSON file persistence. The store is
 * keyed by ticket identifier (e.g. "AI-1472") and stores the artifact ref
 * (a vault path like "ai-systems/projects/_/sprints/sprint-42.md").
 *
 * Design: design.md §5.7 item 1, §14b.
 */

import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "artifact-store");

/** A bound artifact record. */
export interface BoundArtifact {
  /** The vault path/ref to the sprint-plan doc (e.g. "ai-systems/projects/x/sprints/sprint-42.md"). */
  ref: string;
  /** ISO timestamp when the artifact was bound. */
  boundAt: string;
  /** The agent/body that bound the artifact. */
  boundBy: string;
}

/** In-memory store: ticket identifier → BoundArtifact. */
const _store = new Map<string, BoundArtifact>();

/**
 * Bind an artifact to a ticket. Overwrites any existing binding.
 * Called at intake.accept when the artifact gate passes.
 */
export function bindArtifact(ticketId: string, artifact: BoundArtifact): void {
  _store.set(ticketId, artifact);
  log.info(`artifact-store: bound '${artifact.ref}' to ${ticketId} (by ${artifact.boundBy})`);
}

/**
 * Retrieve the bound artifact for a ticket.
 * Returns null if no artifact is bound (the §5.6 validating gate uses this).
 */
export function getBoundArtifact(ticketId: string): BoundArtifact | null {
  return _store.get(ticketId) ?? null;
}

/**
 * Check whether a ticket has a bound artifact.
 */
export function hasBoundArtifact(ticketId: string): boolean {
  return _store.has(ticketId);
}

/**
 * Remove the artifact binding for a ticket (cleanup on escape/demote).
 * Returns true if an artifact was removed, false if none was bound.
 */
export function removeArtifact(ticketId: string): boolean {
  const had = _store.delete(ticketId);
  if (had) {
    log.info(`artifact-store: removed binding for ${ticketId}`);
  }
  return had;
}

/** Clear all artifact bindings. Used in tests. */
export function clearArtifactStore(): void {
  _store.clear();
}
