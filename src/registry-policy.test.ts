/**
 * Phase 2 (rebuild) — registry ⇄ capability-policy cross-check.
 */

import { crossCheckRegistryPolicy, physicalContainerOf } from "./registry-policy.js";
import type { AgentConfig } from "./agents.js";
import type { PolicyBody } from "./escalation-gate.js";

function agent(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
  return {
    linearUserId: "u-" + overrides.name,
    clientId: "c",
    clientSecret: "s",
    accessToken: "t",
    refreshToken: "r",
    ...overrides,
  } as AgentConfig;
}

function body(overrides: Partial<PolicyBody> & { id: string; container: string }): PolicyBody {
  return { fills_roles: [], ...overrides };
}

const secrets = (container: string, name: string) =>
  `/home/fancymatt/.openclaw/containers/${container}/workspace/${name}/.secrets/linear.env`;

describe("physicalContainerOf", () => {
  it("derives the container from a secretsPath", () => {
    expect(physicalContainerOf({ secretsPath: secrets("workflow", "astrid") })).toBe("workflow");
  });

  it("returns null when there is no secretsPath or no container segment", () => {
    expect(physicalContainerOf({})).toBeNull();
    expect(physicalContainerOf({ secretsPath: "/etc/linear.env" })).toBeNull();
  });
});

describe("crossCheckRegistryPolicy", () => {
  it("is clean when every body matches a registered agent in the declared container", () => {
    const { violations, notes } = crossCheckRegistryPolicy(
      [agent({ name: "astrid", secretsPath: secrets("workflow", "astrid") })],
      [body({ id: "astrid", container: "workflow" })],
    );
    expect(violations).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("flags a body with no registered agent", () => {
    const { violations } = crossCheckRegistryPolicy(
      [agent({ name: "astrid", secretsPath: secrets("workflow", "astrid") })],
      [body({ id: "astrid", container: "workflow" }), body({ id: "r2d2", container: "utility" })],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'r2d2'");
    expect(violations[0]).toContain("no registered agent");
  });

  it("matches a body to an agent via openclaw_agent / openclawAgent aliases", () => {
    const { violations } = crossCheckRegistryPolicy(
      [agent({ name: "ai", openclawAgent: "ai", secretsPath: secrets("ai", "ai") })],
      [body({ id: "main", openclaw_agent: "ai", container: "ai" })],
    );
    expect(violations).toEqual([]);
  });

  it("flags a container mismatch between policy and registry", () => {
    const { violations } = crossCheckRegistryPolicy(
      [agent({ name: "igor", secretsPath: secrets("dev", "igor") })],
      [body({ id: "igor", container: "dev-backend" })],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'igor'");
    expect(violations[0]).toContain("'dev-backend'");
    expect(violations[0]).toContain("'dev'");
    expect(violations[0]).toContain("openclaw_container");
  });

  it("accepts a legitimate bundle/container divergence declared via openclaw_container", () => {
    const { violations } = crossCheckRegistryPolicy(
      [agent({ name: "igor", secretsPath: secrets("dev", "igor") })],
      [body({ id: "igor", container: "dev-backend", openclaw_container: "dev" })],
    );
    expect(violations).toEqual([]);
  });

  it("flags a stale openclaw_container annotation too", () => {
    const { violations } = crossCheckRegistryPolicy(
      [agent({ name: "igor", secretsPath: secrets("dev-backend-v2", "igor") })],
      [body({ id: "igor", container: "dev-backend", openclaw_container: "dev" })],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'dev'");
    expect(violations[0]).toContain("'dev-backend-v2'");
  });

  it("does not assert placement for host-side agents without a container secretsPath", () => {
    const { violations, notes } = crossCheckRegistryPolicy(
      [agent({ name: "grover" })],
      [body({ id: "grover", container: "infra-admin" })],
    );
    expect(violations).toEqual([]);
    expect(notes.some((n) => n.includes("grover") && n.includes("not asserted"))).toBe(true);
  });

  it("notes registered agents that have no policy body (fail-closed)", () => {
    const { violations, notes } = crossCheckRegistryPolicy(
      [
        agent({ name: "astrid", secretsPath: secrets("workflow", "astrid") }),
        agent({ name: "woz", secretsPath: secrets("utility", "woz") }),
      ],
      [body({ id: "astrid", container: "workflow" })],
    );
    expect(violations).toEqual([]);
    expect(notes.some((n) => n.includes("woz") && n.includes("no policy body"))).toBe(true);
  });
});
