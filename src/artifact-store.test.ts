/**
 * Unit tests for the artifact-binding store (AI-1472 Phase 6 / C-2).
 *
 * Tests the in-memory store for bound sprint-plan artifacts:
 *   - bindArtifact stores a binding
 *   - getBoundArtifact retrieves it
 *   - hasBoundArtifact checks existence
 *   - removeArtifact cleans up
 *   - clearArtifactStore resets for tests
 */

import {
  bindArtifact,
  getBoundArtifact,
  hasBoundArtifact,
  removeArtifact,
  clearArtifactStore,
  type BoundArtifact,
} from "./artifact-store.js";

describe("artifact-store", () => {
  afterEach(() => {
    clearArtifactStore();
  });

  it("binds and retrieves an artifact", () => {
    const artifact: BoundArtifact = {
      ref: "ai-systems/projects/fleet/sprints/sprint-42.md",
      boundAt: "2026-06-09T16:00:00.000Z",
      boundBy: "astrid",
    };
    bindArtifact("AI-1472", artifact);

    const retrieved = getBoundArtifact("AI-1472");
    expect(retrieved).toEqual(artifact);
  });

  it("returns null for unbound ticket", () => {
    expect(getBoundArtifact("AI-9999")).toBeNull();
  });

  it("reports hasBoundArtifact correctly", () => {
    expect(hasBoundArtifact("AI-1472")).toBe(false);

    bindArtifact("AI-1472", {
      ref: "sprints/plan.md",
      boundAt: new Date().toISOString(),
      boundBy: "astrid",
    });

    expect(hasBoundArtifact("AI-1472")).toBe(true);
  });

  it("overwrites existing binding", () => {
    bindArtifact("AI-1472", {
      ref: "sprints/old.md",
      boundAt: "2026-06-09T10:00:00.000Z",
      boundBy: "astrid",
    });

    bindArtifact("AI-1472", {
      ref: "sprints/new.md",
      boundAt: "2026-06-09T16:00:00.000Z",
      boundBy: "astrid",
    });

    const retrieved = getBoundArtifact("AI-1472");
    expect(retrieved?.ref).toBe("sprints/new.md");
  });

  it("removes artifact binding", () => {
    bindArtifact("AI-1472", {
      ref: "sprints/plan.md",
      boundAt: new Date().toISOString(),
      boundBy: "astrid",
    });

    expect(removeArtifact("AI-1472")).toBe(true);
    expect(getBoundArtifact("AI-1472")).toBeNull();
    expect(hasBoundArtifact("AI-1472")).toBe(false);
  });

  it("removeArtifact returns false when no binding exists", () => {
    expect(removeArtifact("AI-9999")).toBe(false);
  });

  it("clearArtifactStore removes all bindings", () => {
    bindArtifact("AI-1", { ref: "a.md", boundAt: "", boundBy: "x" });
    bindArtifact("AI-2", { ref: "b.md", boundAt: "", boundBy: "y" });

    clearArtifactStore();

    expect(getBoundArtifact("AI-1")).toBeNull();
    expect(getBoundArtifact("AI-2")).toBeNull();
  });
});
