/**
 * Phase 2 / slice 1 — escalation gate enforcement (AI-1346).
 *
 * Enforces inbound Linear CLI rules in the connector proxy. Slice 1 rule:
 * on workflow tickets (carrying a wf:* label), `needs-human` is steward-only.
 * Ad-hoc tickets (no wf:* label) are full pass-through — §4.6 mode switch.
 *
 * The rule table is data-driven so Phase 3 (full per-step command validation)
 * can add rules as config rather than surgery.
 *
 * Authority model:
 *   body → container (capability-policy.yaml) → grants capabilities[]
 *   The proxy NEVER trusts agent-supplied state; it fetches labels independently.
 *
 * Design: design.md §4.6, §11, §13.
 */

import fs from "node:fs/promises";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { recordSuccess, recordFailure } from "./config-health.js";
import { defaultCapabilityPolicyPath } from "./instance-config.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "escalation-gate");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Resolve the policy path dynamically (reads env each call so test beforeAll works). */
function policyPath(): string {
  return process.env.CAPABILITY_POLICY_PATH ?? defaultCapabilityPolicyPath();
}

// ── YAML schema types ──────────────────────────────────────────────────────

interface PolicyBody {
  id: string;
  /** Optional OpenClaw runtime agent alias. Resolves `x-openclaw-agent` headers that differ from `id` (e.g. main → ai). */
  openclaw_agent?: string;
  container: string;
  fills_roles: string[];
}

interface PolicyContainer {
  id: string;
  grants: string[];
}

interface CapabilityPolicy {
  bodies: PolicyBody[];
  containers: PolicyContainer[];
}

// ── Data-driven rule table ─────────────────────────────────────────────────

/**
 * One enforcement rule. The proxy evaluates all rules matching the incoming
 * intent; the first violation produces a rejection.
 */
export interface EnforcementRule {
  /** Value of `x-openclaw-linear-intent` that triggers this rule. */
  intent: string;
  /** Capability the calling body must hold. */
  requiredCapability: string;
  /** Human-readable description of the legal alternative, used in the error. */
  legalMove: string;
}

/**
 * Phase 2 enforcement rules (slice 1: one rule).
 * Phase 3 will extend this table — adding a rule is config, not code surgery.
 */
export const ENFORCEMENT_RULES: EnforcementRule[] = [
  {
    intent: "needs-human",
    requiredCapability: "human:escalate",
    legalMove: "escalate → steward (Astrid)",
  },
];

// ── Policy cache ───────────────────────────────────────────────────────────

let _policyCache: CapabilityPolicy | null = null;

async function loadPolicy(): Promise<CapabilityPolicy> {
  if (_policyCache) return _policyCache;
  try {
    const raw = await fs.readFile(policyPath(), "utf8");
    _policyCache = yaml.load(raw) as CapabilityPolicy;
    recordSuccess("capability-policy");
    return _policyCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure("capability-policy", msg);
    throw err;
  }
}

/** Invalidate the in-process policy cache (used in tests). */
export function resetPolicyCache(): void {
  _policyCache = null;
}

// ── Body → capability resolution ───────────────────────────────────────────

/**
 * Returns the set of capabilities granted to a body via its container.
 * Unknown body IDs return an empty set (fail-closed).
 */
async function resolveBodyCapabilities(bodyId: string): Promise<Set<string>> {
  const policy = await loadPolicy();
  const body = policy.bodies.find((b) => b.id === bodyId || b.openclaw_agent === bodyId);
  if (!body) {
    log.warn(`escalation-gate: unknown body '${bodyId}' — treating as no capabilities`);
    return new Set();
  }
  const container = policy.containers.find((c) => c.id === body.container);
  if (!container) {
    log.warn(`escalation-gate: unknown container '${body.container}' for body '${bodyId}'`);
    return new Set();
  }
  return new Set(container.grants);
}

/**
 * Returns true when the body holds the given capability via its container.
 * Exported for unit tests.
 */
export async function bodyHasCapability(bodyId: string, capability: string): Promise<boolean> {
  const caps = await resolveBodyCapabilities(bodyId);
  return caps.has(capability);
}

/**
 * Returns true when the body ID resolves to a known entry in the capability policy.
 * Unknown bodies (not in policy) are treated as untrusted callers.
 * Used by the workflow gate for fail-closed enforcement on wf:dev-impl tickets (AI-1402).
 */
export async function isBodyKnown(bodyId: string): Promise<boolean> {
  const policy = await loadPolicy();
  return policy.bodies.some((b) => b.id === bodyId || b.openclaw_agent === bodyId);
}

/**
 * Returns body IDs that fill the given role (§16.2).
 * Used by the workflow gate to derive legal assignment targets.
 */
export async function resolveBodiesForRole(roleId: string): Promise<string[]> {
  const policy = await loadPolicy();
  return policy.bodies
    .filter((b) => b.fills_roles.includes(roleId))
    .map((b) => b.id);
}

// ── Workflow ticket detection ──────────────────────────────────────────────

/**
 * Fetch label names for a Linear issue using the caller's auth token.
 * The proxy does NOT trust agent-supplied state (design.md §11 Phase 2):
 * it independently queries Linear to determine ticket context.
 * Returns an empty array on any error (network failure, unknown issue) —
 * enforcement fails open rather than blocking legitimate traffic.
 */
async function fetchTicketLabels(issueId: string, authToken: string): Promise<string[]> {
  const query = `query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type LabelResp = { data?: { issue?: { labels?: { nodes: Array<{ name: string }> } } } };
    const data = (await res.json()) as LabelResp;
    return (data.data?.issue?.labels?.nodes ?? []).map((n) => n.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`escalation-gate: label fetch failed for issue ${issueId}: ${msg} — failing open`);
    return [];
  }
}

/** True when any label matches the wf:* pattern (§4.6 mode switch). */
function isWorkflowTicket(labels: string[]): boolean {
  return labels.some((l) => /^wf:/i.test(l));
}

// ── Public enforcement API ─────────────────────────────────────────────────

/**
 * Evaluate enforcement rules for an inbound proxied request.
 *
 * Returns a rejection message string when the request should be blocked,
 * or `null` if it should be forwarded unchanged.
 *
 * Fails open on ambiguity (no issue context, label fetch failure, unknown body):
 * enforcement only blocks when it has affirmative evidence of a violation.
 */
export async function checkEnforcementRules(
  intent: string,
  issueId: string | null,
  authToken: string,
  bodyId: string
): Promise<string | null> {
  const rule = ENFORCEMENT_RULES.find((r) => r.intent === intent);
  if (!rule) return null;

  // Without a ticket ID we can't determine workflow context — fail open.
  if (!issueId) return null;

  const labels = await fetchTicketLabels(issueId, authToken);

  // §4.6 mode switch: ad-hoc tickets (no wf:* label) are full pass-through.
  if (!isWorkflowTicket(labels)) return null;

  const allowed = await bodyHasCapability(bodyId, rule.requiredCapability);
  if (allowed) return null;

  return (
    `[Proxy] '${intent}' on a workflow ticket requires the '${rule.requiredCapability}' capability. ` +
    `Legal move: ${rule.legalMove}.`
  );
}
