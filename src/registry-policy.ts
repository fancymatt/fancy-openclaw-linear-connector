/**
 * Phase 2 — registry ⇄ capability-policy cross-check (rebuild project, WS2).
 *
 * agents.json is the single source of truth for agent identity and physical
 * placement. The capability policy's `bodies:` section must agree with it:
 *
 *   1. Every policy body resolves to a registered agent. A body without a
 *      registration is dead config — a ticket delegated to it no-routes, and
 *      the audit's live example (`r2d2`) sat undetected for weeks.
 *   2. Each body's physical container matches the registry. The policy
 *      `container:` is a CAPABILITY BUNDLE and may legitimately diverge from
 *      the docker container name (igor: bundle `dev-backend`, lives in `dev`).
 *      Where they diverge, the body must say so explicitly via
 *      `openclaw_container:` — implicit divergence is exactly how the AI-1738
 *      half-applied cutover went unnoticed.
 *
 * Drift alerts loudly (alert bus, warning → push) but does NOT flip
 * config-health: config-health unhealthy fail-closes the whole engine, and
 * one stale body must not freeze unrelated tickets. Genuine load failures of
 * either file still flip config-health via their own artifact kinds.
 */

import { getAgents, onAgentsReloaded, type AgentConfig } from "./agents.js";
import { getPolicyBodies, type PolicyBody } from "./escalation-gate.js";
import { notify } from "./alerts/alert-bus.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "registry-policy");

export interface RegistryPolicyStatus {
  /** ISO timestamp of the last completed check, or null if never run. */
  lastCheck: string | null;
  violations: string[];
  /** Non-failing observations (e.g. agents with no policy body). */
  notes: string[];
}

let _status: RegistryPolicyStatus = { lastCheck: null, violations: [], notes: [] };

/** Physical (docker) container an agent runs in, derived from its secretsPath. */
export function physicalContainerOf(agent: Pick<AgentConfig, "secretsPath">): string | null {
  const match = (agent.secretsPath ?? "").match(/\/containers\/([^/]+)\/workspace\//);
  return match ? match[1] : null;
}

function findAgentForBody(
  body: Pick<PolicyBody, "id" | "openclaw_agent">,
  agents: AgentConfig[],
): AgentConfig | undefined {
  const candidates = [body.id, body.openclaw_agent].filter(Boolean) as string[];
  return agents.find((a) =>
    candidates.includes(a.name) || (a.openclawAgent !== undefined && candidates.includes(a.openclawAgent)),
  );
}

/**
 * Pure cross-check. Returns violations (loud) and notes (informational).
 * Exported for tests.
 */
export function crossCheckRegistryPolicy(
  agents: AgentConfig[],
  bodies: PolicyBody[],
): { violations: string[]; notes: string[] } {
  const violations: string[] = [];
  const notes: string[] = [];

  for (const body of bodies) {
    const agent = findAgentForBody(body, agents);
    if (!agent) {
      violations.push(
        `policy body '${body.id}' has no registered agent in agents.json — ` +
          `tickets delegated to it will no-route; register the agent or remove the body`,
      );
      continue;
    }

    const physical = physicalContainerOf(agent);
    if (!physical) {
      // Host-side agents (e.g. grover) have no container secretsPath — nothing to assert.
      notes.push(`body '${body.id}': no container-derived secretsPath in registry; placement not asserted`);
      continue;
    }

    const declared = body.openclaw_container ?? body.container;
    if (declared !== physical) {
      violations.push(
        `policy body '${body.id}' places the agent in '${declared}' but the registry says '${physical}' ` +
          `(secretsPath) — if the capability bundle name legitimately differs from the docker container, ` +
          `declare it with 'openclaw_container: ${physical}' on the body; otherwise finish the cutover`,
      );
    }
  }

  const bodiless = agents.filter((a) =>
    !bodies.some((b) => {
      const ids = [b.id, b.openclaw_agent].filter(Boolean) as string[];
      return ids.includes(a.name) || (a.openclawAgent !== undefined && ids.includes(a.openclawAgent));
    }),
  );
  if (bodiless.length > 0) {
    notes.push(
      `registered agents with no policy body (fail-closed, no workflow capabilities): ` +
        bodiless.map((a) => a.name).join(", "),
    );
  }

  return { violations, notes };
}

/**
 * Load both artifacts, run the cross-check, alert on drift.
 * Never throws — a check failure must not take down the caller.
 */
export async function runRegistryPolicyCheck(trigger: string): Promise<RegistryPolicyStatus> {
  try {
    const bodies = await getPolicyBodies();
    const { violations, notes } = crossCheckRegistryPolicy(getAgents(), bodies);
    _status = { lastCheck: new Date().toISOString(), violations, notes };

    if (violations.length > 0) {
      log.error(`registry⇄policy drift (${trigger}): ${violations.join(" | ")}`);
      notify({
        severity: "warning",
        source: "registry-policy",
        title: `agents.json and capability-policy disagree — ${violations.length} violation(s)`,
        detail: violations.join("\n"),
        dedupKey: "registry-policy|drift",
      });
    } else {
      log.info(`registry⇄policy check clean (${trigger}): ${bodies.length} bodies asserted` +
        (notes.length ? ` — notes: ${notes.join("; ")}` : ""));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`registry⇄policy check failed to run (${trigger}): ${msg}`);
    _status = { lastCheck: new Date().toISOString(), violations: [`check failed to run: ${msg}`], notes: [] };
  }
  return _status;
}

/** Last check result — surfaced by /admin and, later, the console. */
export function getRegistryPolicyStatus(): RegistryPolicyStatus {
  return _status;
}

/** Wire the check to run now and again on every successful registry hot-reload. */
export function startRegistryPolicyCheck(): void {
  void runRegistryPolicyCheck("startup");
  onAgentsReloaded(() => void runRegistryPolicyCheck("agents.json reload"));
}
