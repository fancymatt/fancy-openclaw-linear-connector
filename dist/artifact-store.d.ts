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
/** A bound artifact record. */
export interface BoundArtifact {
    /** The vault path/ref to the sprint-plan doc (e.g. "ai-systems/projects/x/sprints/sprint-42.md"). */
    ref: string;
    /** ISO timestamp when the artifact was bound. */
    boundAt: string;
    /** The agent/body that bound the artifact. */
    boundBy: string;
}
/**
 * Bind an artifact to a ticket. Overwrites any existing binding.
 * Called at intake.accept when the artifact gate passes.
 */
export declare function bindArtifact(ticketId: string, artifact: BoundArtifact): void;
/**
 * Retrieve the bound artifact for a ticket.
 * Returns null if no artifact is bound (the §5.6 validating gate uses this).
 */
export declare function getBoundArtifact(ticketId: string): BoundArtifact | null;
/**
 * Check whether a ticket has a bound artifact.
 */
export declare function hasBoundArtifact(ticketId: string): boolean;
/**
 * Remove the artifact binding for a ticket (cleanup on escape/demote).
 * Returns true if an artifact was removed, false if none was bound.
 */
export declare function removeArtifact(ticketId: string): boolean;
/** Clear all artifact bindings. Used in tests. */
export declare function clearArtifactStore(): void;
//# sourceMappingURL=artifact-store.d.ts.map