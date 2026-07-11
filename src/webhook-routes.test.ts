/**
 * Tests for webhook-routes.ts — static session-key mapping.
 */

import {
  initWebhookRoutes,
  resolveMappedSessionKey,
  findUnmappedAgents,
  resetWebhookRoutes,
} from "./webhook-routes.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const SAMPLE_CONFIG = `routes:
  - agent: ai
    sessionKey: "linear-{identifier}"
    description: "Ai's Linear webhook sessions"
  - agent: astrid
    sessionKey: "linear-{identifier}"
  - agent: grover
    sessionKey: "linear-{identifier}"
  - agent: felix
    sessionKey: "linear-{identifier}"
  - agent: igor
    sessionKey: "linear-{identifier}"
  - agent: sage
    sessionKey: "linear-{identifier}"
  - agent: noah
    sessionKey: "linear-{identifier}"
  - agent: kana
    sessionKey: "linear-{identifier}"
  - agent: mika
    sessionKey: "linear-{identifier}"
  - agent: finn
    sessionKey: "linear-{identifier}"
  - agent: laren
    sessionKey: "linear-{identifier}"
  - agent: kenji
    sessionKey: "linear-{identifier}"
  - agent: clay
    sessionKey: "linear-{identifier}"
  - agent: caspar
    sessionKey: "linear-{identifier}"
  - agent: ken
    sessionKey: "linear-{identifier}"
  - agent: maren
    sessionKey: "linear-{identifier}"
  - agent: poe
    sessionKey: "linear-{identifier}"
  - agent: mckell
    sessionKey: "linear-{identifier}"
  - agent: lacey
    sessionKey: "linear-{identifier}"
  - agent: signe
    sessionKey: "linear-{identifier}"
  - agent: yoshi
    sessionKey: "linear-{identifier}"
  - agent: penny
    sessionKey: "linear-{identifier}"
  - agent: hanzo
    sessionKey: "linear-{identifier}"
  - agent: kat
    sessionKey: "linear-{identifier}"
  - agent: cra
    sessionKey: "linear-{identifier}"
  - agent: tdd
    sessionKey: "linear-{identifier}"
  - agent: scout
    sessionKey: "linear-{identifier}"
  - agent: woz
    sessionKey: "linear-{identifier}"
`;

const ALL_AGENTS = [
  "ai", "astrid", "grover", "felix", "igor", "sage", "noah",
  "kana", "mika", "finn", "laren", "kenji", "clay", "caspar",
  "ken", "maren", "poe", "mckell", "lacey", "signe", "yoshi",
  "penny", "hanzo", "kat", "cra", "tdd", "scout", "woz",
];

describe("webhook-routes", () => {
  let tmpDir: string;

  beforeEach(() => {
    resetWebhookRoutes();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-routes-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetWebhookRoutes();
  });

  function writeConfig(yaml: string): string {
    const p = path.join(tmpDir, "webhook-routes.yaml");
    fs.writeFileSync(p, yaml, "utf8");
    return p;
  }

  describe("load", () => {
    it("returns null when no config file exists", () => {
      initWebhookRoutes(path.join(tmpDir, "nonexistent.yaml"));
      const result = resolveMappedSessionKey("ai", "AI-2112", "linear-AI-2112-fallback");
      // No config → returns fallback
      expect(result).toBe("linear-AI-2112-fallback");
    });

    it("loads a valid config and resolves known agents", () => {
      const p = writeConfig(SAMPLE_CONFIG);
      initWebhookRoutes(p);
      const result = resolveMappedSessionKey("ai", "AI-2112", "fallback");
      expect(result).toBe("linear-AI-2112");
    });

    it("returns null for an unmapped agent when allowUnmapped is false", () => {
      const p = writeConfig(`routes:
  - agent: ai
    sessionKey: "linear-{identifier}"
`);
      initWebhookRoutes(p);
      const result = resolveMappedSessionKey("unregistered-agent", "GEN-1", "fallback");
      expect(result).toBeNull();
    });

    it("returns fallback for an unmapped agent when allowUnmapped is true", () => {
      const p = writeConfig(`allowUnmapped: true
routes:
  - agent: ai
    sessionKey: "linear-{identifier}"
`);
      initWebhookRoutes(p);
      const result = resolveMappedSessionKey("unregistered-agent", "GEN-1", "fallback");
      expect(result).toBe("fallback");
    });

    it("returns null for an unmapped route with no identifier", () => {
      const p = writeConfig(`routes:
  - agent: ai
    sessionKey: "linear-{identifier}"
`);
      initWebhookRoutes(p);
      const result = resolveMappedSessionKey("ai", null, "fallback");
      expect(result).toBeNull();
    });
  });

  describe("findUnmappedAgents", () => {
    it("returns empty when all agents are mapped", () => {
      const p = writeConfig(SAMPLE_CONFIG);
      initWebhookRoutes(p);
      const missing = findUnmappedAgents(ALL_AGENTS);
      expect(missing).toEqual([]);
    });

    it("returns unmapped agents", () => {
      const p = writeConfig(`routes:
  - agent: ai
    sessionKey: "linear-{identifier}"
  - agent: grover
    sessionKey: "linear-{identifier}"
`);
      initWebhookRoutes(p);
      const missing = findUnmappedAgents(ALL_AGENTS);
      expect(missing).toContain("astrid");
      expect(missing).toContain("felix");
      expect(missing).not.toContain("ai");
      expect(missing).not.toContain("grover");
    });

    it("returns empty when no config loaded", () => {
      // Don't init — no config
      const missing = findUnmappedAgents(ALL_AGENTS);
      expect(missing).toEqual([]);
    });
  });

  describe("resolveMappedSessionKey", () => {
    it("resolves {identifier} placeholder", () => {
      const p = writeConfig(`routes:
  - agent: ai
    sessionKey: "linear-{identifier}"
`);
      initWebhookRoutes(p);
      expect(resolveMappedSessionKey("ai", "AI-42", "")).toBe("linear-AI-42");
      expect(resolveMappedSessionKey("ai", "GEN-99999", "")).toBe("linear-GEN-99999");
    });

    it("returns fallback when no config is loaded", () => {
      // Config not loaded
      expect(resolveMappedSessionKey("ai", "AI-2112", "linear-AI-2112")).toBe("linear-AI-2112");
    });
  });
});
