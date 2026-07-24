/**
 * Tests for T2 background-hum model routing — AI-2628.
 *
 * Acceptance Criteria covered:
 *   AC1 — All T2 agent lanes (heartbeat, cron, ingestion) route through
 *          GB10 gemma4:31b as default, with cloud fallback.
 *
 * These tests read the live openclaw.json config from the canonical path
 * (~/.openclaw/openclaw.json) and validate that T2 lanes default to the
 * local model after the AI-2628 config change.
 *
 * BEFORE implementation (current state):
 *   - heartbeat.model = "zai/glm-5-turbo"     → Test 1 FAILS
 *   - cron model config does not exist          → Test 2 FAILS (missing)
 *   - ingestion model config does not exist     → Test 3 FAILS (missing)
 *   - model.fallbacks includes cloud models     → Test 4 PASSES
 *
 * AFTER implementation:
 *   - heartbeat.model = "ollama/gemma4:31b"    → Test 1 PASSES
 *   - cron model = "ollama/gemma4:31b"          → Test 2 PASSES
 *   - ingestion model = "ollama/gemma4:31b"     → Test 3 PASSES
 *   - fallbacks still include cloud endpoints   → Test 4 PASSES
 */

import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import path from "path";

/** Canonical path to the OpenClaw gateway config. */
const CONFIG_PATH = path.join(
  process.env.HOME ?? "/home/node",
  ".openclaw",
  "openclaw.json",
);

/**
 * Load and parse the gateway config. Fails the test suite early if the
 * file is missing or unparseable — every test depends on it.
 */
function loadConfig(): Record<string, unknown> {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Narrow type helper to safely descend into nested config objects. */
function getConfigSection(
  config: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | undefined {
  let current: unknown = config;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : undefined;
}

/** Match either the full model ID or the gemma-local alias. */
const LOCAL_MODEL_RE = /^(ollama\/gemma4:31b|gemma-local)$/;

/** The parsed agents.defaults section, shared across all tests. */
const config = loadConfig();
const agentsDefaults = getConfigSection(config, "agents", "defaults");

// ─────────────────────────────────────────────────────────────
// AC1 — T2 heartbeat lane defaults to local gemma4:31b
// ─────────────────────────────────────────────────────────────

describe("AC1 — T2 heartbeat lane defaults to local gemma4:31b", () => {
  it("agents.defaults.heartbeat.model is set to ollama/gemma4:31b or gemma-local alias", () => {
    expect(agentsDefaults).toBeDefined();

    const heartbeat = getConfigSection(agentsDefaults!, "heartbeat");
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.model).toBeDefined();

    const model = heartbeat!.model as string;
    expect(model).toMatch(LOCAL_MODEL_RE);
  });
});

// ─────────────────────────────────────────────────────────────
// AC1 — T2 cron lane defaults to local gemma4:31b
// ─────────────────────────────────────────────────────────────

describe("AC1 — T2 cron lane defaults to local gemma4:31b", () => {
  it("agents.defaults.cron.model is set to ollama/gemma4:31b or gemma-local alias", () => {
    expect(agentsDefaults).toBeDefined();

    const cron = getConfigSection(agentsDefaults!, "cron");
    expect(cron).toBeDefined();
    expect(cron!.model).toBeDefined();

    const model = cron!.model as string;
    expect(model).toMatch(LOCAL_MODEL_RE);
  });
});

// ─────────────────────────────────────────────────────────────
// AC1 — T2 ingestion lane defaults to local gemma4:31b
// ─────────────────────────────────────────────────────────────

describe("AC1 — T2 ingestion lane defaults to local gemma4:31b", () => {
  it("agents.defaults.ingestion.model is set to ollama/gemma4:31b or gemma-local alias", () => {
    expect(agentsDefaults).toBeDefined();

    const ingestion = getConfigSection(agentsDefaults!, "ingestion");
    expect(ingestion).toBeDefined();
    expect(ingestion!.model).toBeDefined();

    const model = ingestion!.model as string;
    expect(model).toMatch(LOCAL_MODEL_RE);
  });
});

// ─────────────────────────────────────────────────────────────
// AC1 — Fallback chain includes cloud models (resilience)
// ─────────────────────────────────────────────────────────────

describe("AC1 — Fallback chain includes cloud models for resilience", () => {
  it("agents.defaults.model.fallbacks contains at least one cloud endpoint", () => {
    expect(agentsDefaults).toBeDefined();

    const modelSection = getConfigSection(agentsDefaults!, "model");
    expect(modelSection).toBeDefined();

    const fallbacks = modelSection!.fallbacks;
    expect(Array.isArray(fallbacks)).toBe(true);
    expect((fallbacks as unknown[]).length).toBeGreaterThan(0);

    const cloudProviders = ["zai/", "openai/", "anthropic/", "deepseek/", "google/"];
    const fallbackArr = fallbacks as string[];
    const hasCloud = fallbackArr.some((f) =>
      cloudProviders.some((p) => f.startsWith(p)),
    );
    expect(hasCloud).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// AC1 — Per-agent T2 overrides also use local gemma4:31b
// ─────────────────────────────────────────────────────────────

describe("AC1 — Per-agent T2 overrides use local gemma4:31b", () => {
  /**
   * If per-agent overrides exist under heartbeat/cron/ingestion sections
   * (e.g. heartbeat.agents.tdd.model), they must also default to local.
   * If none exist, the test passes trivially — the default inherits from
   * the parent section validated above.
   */

  function collectPerAgentModels(
    section: Record<string, unknown> | undefined,
  ): Array<[string, string]> {
    if (!section) return [];
    const results: Array<[string, string]> = [];
    const agentsSub = getConfigSection(section, "agents");
    if (!agentsSub) return results;

    for (const [agentName, agentCfg] of Object.entries(agentsSub)) {
      if (agentCfg && typeof agentCfg === "object") {
        const model = (agentCfg as Record<string, unknown>).model;
        if (typeof model === "string") {
          results.push([agentName, model]);
        }
      }
    }
    return results;
  }

  it("heartbeat per-agent overrides (if any) use local gemma4:31b", () => {
    const heartbeat = getConfigSection(agentsDefaults!, "heartbeat");
    const perAgent = collectPerAgentModels(heartbeat);

    if (perAgent.length === 0) {
      expect(perAgent).toHaveLength(0);
      return;
    }

    for (const [agentName, model] of perAgent) {
      expect(model).toMatch(
        LOCAL_MODEL_RE,
        `Agent "${agentName}" heartbeat override should use local model`,
      );
    }
  });

  it("cron per-agent overrides (if any) use local gemma4:31b", () => {
    const cron = getConfigSection(agentsDefaults!, "cron");
    const perAgent = collectPerAgentModels(cron);

    if (perAgent.length === 0) {
      expect(perAgent).toHaveLength(0);
      return;
    }

    for (const [agentName, model] of perAgent) {
      expect(model).toMatch(
        LOCAL_MODEL_RE,
        `Agent "${agentName}" cron override should use local model`,
      );
    }
  });

  it("ingestion per-agent overrides (if any) use local gemma4:31b", () => {
    const ingestion = getConfigSection(agentsDefaults!, "ingestion");
    const perAgent = collectPerAgentModels(ingestion);

    if (perAgent.length === 0) {
      expect(perAgent).toHaveLength(0);
      return;
    }

    for (const [agentName, model] of perAgent) {
      expect(model).toMatch(
        LOCAL_MODEL_RE,
        `Agent "${agentName}" ingestion override should use local model`,
      );
    }
  });
});
