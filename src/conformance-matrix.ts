/**
 * AI-1543 / G-9 — Conformance matrix generator.
 *
 * Given a workflow def + capability policy, emits every cell of the
 * (state × command × caller-class × ticket-flags) cross-product and annotates
 * each cell with the expected gate outcome (allow / block + reason).
 *
 * Caller classes:
 *   delegate             — the current ticket delegate; same role as state owner
 *   non-delegate-same-role — a different body that fills the same role
 *   wrong-role           — a body from an unrelated role (no delegate set)
 *   steward              — the steward body; delegate set to state owner
 *   human                — an unknown body (not in the capability policy)
 *
 * Ticket-flag dimensions: stakeLabel × delegateLinearUserId
 *
 * The generator is purely synchronous and derives every value from the supplied
 * def + policy. No network calls, no file I/O, no caches.
 */

import type { WorkflowDef } from './workflow-gate.js';

// ── Public types ───────────────────────────────────────────────────────────

export type CallerKind =
  | 'delegate'
  | 'non-delegate-same-role'
  | 'wrong-role'
  | 'steward'
  | 'human';

export interface CapabilityPolicyInput {
  capabilities?: Array<{ id: string }>;
  roles?: Array<{ id: string; requires?: string[] }>;
  containers: Array<{ id: string; grants: string[] }>;
  bodies: Array<{
    id: string;
    container: string;
    fills_roles: string[];
    openclaw_agent?: string;
  }>;
}

export interface ConformanceCell {
  state: string;
  command: string;
  caller: {
    kind: CallerKind;
    bodyId: string;
    linearUserId?: string | null;
  };
  flags: {
    stakeLabel: string | null;
    delegateLinearUserId?: string | null;
  };
  expected: 'allow' | 'block';
  blockReason?: 'wrong-state' | 'cap-missing' | 'wrong-delegate' | 'human-signoff' | 'unknown-caller';
  legalCommands: string[];
  requiredCapability?: string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

const HUMAN_BODY_ID = 'human-user';
const STAKE_LABELS: (string | null)[] = [null, 'stakes:low', 'stakes:medium', 'stakes:high'];
const CALLER_KINDS: CallerKind[] = [
  'delegate',
  'non-delegate-same-role',
  'wrong-role',
  'steward',
  'human',
];

interface CallerSpec {
  bodyId: string;
  linearUserId: string | null;
  delegateLinearUserId: string | null;
}

function resolveLinearUserId(bodyId: string): string | null {
  // Use a deterministic computed ID so the matrix is consistent at describe-time
  // (before agents are loaded via reloadAgents). The AC2 tests feed this same
  // computed value back to checkWorkflowRules via the fetch mock, so the
  // delegate-match logic stays self-consistent without depending on runtime state.
  return `${bodyId}-linear`;
}

function bodiesForRole(policy: CapabilityPolicyInput, role: string): string[] {
  return policy.bodies.filter((b) => b.fills_roles.includes(role)).map((b) => b.id);
}

function bodyHasCap(policy: CapabilityPolicyInput, bodyId: string, cap: string): boolean {
  const body = policy.bodies.find((b) => b.id === bodyId);
  if (!body) return false;
  const container = policy.containers.find((c) => c.id === body.container);
  return container?.grants.includes(cap) ?? false;
}

function isKnownBody(policy: CapabilityPolicyInput, bodyId: string): boolean {
  return policy.bodies.some((b) => b.id === bodyId);
}

function findStewardBody(policy: CapabilityPolicyInput): string | null {
  const stewardBodies = bodiesForRole(policy, 'steward');
  if (stewardBodies.length > 0) return stewardBodies[0];
  // Fallback: body whose container grants human:escalate
  const body = policy.bodies.find((b) => {
    const container = policy.containers.find((c) => c.id === b.container);
    return container?.grants.includes('human:escalate');
  });
  return body?.id ?? policy.bodies[0]?.id ?? null;
}

/**
 * Build per-(state, callerKind) caller specifications.
 * Returns null for combinations that have no representative body (e.g.
 * non-delegate-same-role when the role has only one body).
 */
function buildCallerSpec(
  policy: CapabilityPolicyInput,
  stateOwnerRole: string | undefined,
  kind: CallerKind,
): CallerSpec | null {
  const roleBodies = stateOwnerRole ? bodiesForRole(policy, stateOwnerRole) : [];
  const delegateBodyId = roleBodies[0] ?? policy.bodies[0]?.id ?? null;
  const delegateLinearUserId = delegateBodyId ? resolveLinearUserId(delegateBodyId) : null;

  switch (kind) {
    case 'delegate': {
      if (!delegateBodyId) return null;
      return {
        bodyId: delegateBodyId,
        linearUserId: delegateLinearUserId,
        delegateLinearUserId,
      };
    }

    case 'non-delegate-same-role': {
      if (roleBodies.length < 2) return null;
      const nonDelegateId = roleBodies[1];
      return {
        bodyId: nonDelegateId,
        linearUserId: resolveLinearUserId(nonDelegateId),
        delegateLinearUserId,
      };
    }

    case 'wrong-role': {
      // Pick first body NOT filling the owner role (no delegate set so it reaches full pipeline).
      let wrongRoleId: string | undefined;
      if (stateOwnerRole) {
        wrongRoleId = policy.bodies.find((b) => !b.fills_roles.includes(stateOwnerRole))?.id;
      } else {
        // Terminal state: pick any body different from the delegate
        wrongRoleId = policy.bodies.find((b) => b.id !== delegateBodyId)?.id;
      }
      if (!wrongRoleId) return null;
      return {
        bodyId: wrongRoleId,
        linearUserId: resolveLinearUserId(wrongRoleId),
        delegateLinearUserId: null, // no delegate set → proceeds to full pipeline
      };
    }

    case 'steward': {
      const stewardId = findStewardBody(policy);
      if (!stewardId) return null;
      return {
        bodyId: stewardId,
        linearUserId: resolveLinearUserId(stewardId),
        delegateLinearUserId,
      };
    }

    case 'human': {
      return {
        bodyId: HUMAN_BODY_ID,
        linearUserId: null,
        delegateLinearUserId: null,
      };
    }
  }
}

// ── Gate logic ─────────────────────────────────────────────────────────────

/**
 * Determines the expected gate outcome for a single cell.
 * Mirrors the check order in checkWorkflowRules without any I/O.
 */
function resolveExpected(
  stateNode: WorkflowDef['states'][number],
  command: string,
  spec: CallerSpec,
  stakeLabel: string | null,
  def: WorkflowDef,
  policy: CapabilityPolicyInput,
  breakGlassCommand: string,
): Pick<ConformanceCell, 'expected' | 'blockReason' | 'requiredCapability'> {
  // 1. Unknown body — block for most operations.
  // Exception: stakes-gated sign-off transitions allow actual humans (unknown to policy).
  if (!isKnownBody(policy, spec.bodyId)) {
    const transitions = stateNode.transitions ?? [];
    const cmdMatch = transitions.find((t) => t.command === command);
    if (cmdMatch?.requires_human_signoff_above_stakes && def.stakes) {
      const stakeLevel = stakeLabel != null ? (def.stakes.levels[stakeLabel] ?? 0) : 0;
      if (stakeLevel >= def.stakes.threshold) {
        return { expected: 'allow' }; // Human sign-off: unknown caller is the human
      }
    }
    return { expected: 'block', blockReason: 'unknown-caller' };
  }

  // 2. Break-glass — AI-1668: caller-gated (delegate or steward only).
  // Fail-open when no delegate set or caller identity unknown (§4.4 preserved for those cases).
  if (command === breakGlassCommand) {
    if (!spec.delegateLinearUserId) return { expected: 'allow' };
    if (!spec.linearUserId) return { expected: 'allow' };
    if (spec.linearUserId === spec.delegateLinearUserId) return { expected: 'allow' };
    const stewardBodyId = findStewardBody(policy);
    if (stewardBodyId && spec.bodyId === stewardBodyId) return { expected: 'allow' };
    return { expected: 'block', blockReason: 'wrong-delegate' };
  }

  // 3. Delegate-only enforcement (AI-1397)
  if (
    spec.linearUserId &&
    spec.delegateLinearUserId &&
    spec.linearUserId !== spec.delegateLinearUserId
  ) {
    return { expected: 'block', blockReason: 'wrong-delegate' };
  }
  // Unknown callerLinearUserId with a known delegate → block (unknown-caller variant)
  if (!spec.linearUserId && spec.delegateLinearUserId) {
    return { expected: 'block', blockReason: 'wrong-delegate' };
  }

  // 4. State-transition check
  const transitions = stateNode.transitions ?? [];
  const match = transitions.find((t) => t.command === command);
  if (!match) {
    return { expected: 'block', blockReason: 'wrong-state' };
  }

  // 5. Capability gate
  if (match.requires_capability) {
    if (!bodyHasCap(policy, spec.bodyId, match.requires_capability)) {
      return {
        expected: 'block',
        blockReason: 'cap-missing',
        requiredCapability: match.requires_capability,
      };
    }
  }

  // 6. Stakes-threshold human sign-off gate (H-7 / AI-1482)
  if (match.requires_human_signoff_above_stakes && def.stakes) {
    const stakeLevel = stakeLabel != null ? (def.stakes.levels[stakeLabel] ?? 0) : 0;
    if (stakeLevel >= def.stakes.threshold) {
      // Known bodies are AI agents; unknown bodies are assumed human (but those
      // are caught at check 1 above). All cells reaching here have known bodies.
      return { expected: 'block', blockReason: 'human-signoff' };
    }
  }

  return { expected: 'allow' };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate the full (state × command × caller-class × ticket-flags) conformance
 * matrix from the supplied workflow def and capability policy.
 *
 * Every cell carries:
 *   • `expected`      — 'allow' or 'block'
 *   • `blockReason`   — why it's blocked (undefined on allow cells)
 *   • `legalCommands` — the commands that ARE legal in this state (for wrong-state
 *                       rejection assertions)
 *
 * The result is deterministic and synchronous: same inputs → same matrix.
 */
export function buildConformanceMatrix(
  def: WorkflowDef,
  policy: CapabilityPolicyInput,
): ConformanceCell[] {
  const breakGlassCommand = def.break_glass?.command ?? 'escape';

  // Collect every command referenced in any state + break-glass
  const allCommands = new Set<string>([breakGlassCommand]);
  for (const s of def.states) {
    for (const t of s.transitions ?? []) {
      allCommands.add(t.command);
    }
  }
  const commandList = [...allCommands];

  const cells: ConformanceCell[] = [];

  for (const stateNode of def.states) {
    // Legal commands for this state (used in legalCommands field + wrong-state assertions)
    const legalCommands = [
      ...(stateNode.transitions ?? []).map((t) => t.command),
      breakGlassCommand,
    ];

    // Build caller specs once per (state, callerKind) pair
    const specsForState = new Map<CallerKind, CallerSpec | null>(
      CALLER_KINDS.map((k) => [k, buildCallerSpec(policy, stateNode.owner_role, k)]),
    );

    for (const command of commandList) {
      for (const kind of CALLER_KINDS) {
        const spec = specsForState.get(kind);
        if (!spec) continue; // no representative body for this kind in this state

        for (const stakeLabel of STAKE_LABELS) {
          const outcome = resolveExpected(
            stateNode,
            command,
            spec,
            stakeLabel,
            def,
            policy,
            breakGlassCommand,
          );

          const cell: ConformanceCell = {
            state: stateNode.id,
            command,
            caller: {
              kind,
              bodyId: spec.bodyId,
              linearUserId: spec.linearUserId,
            },
            flags: {
              stakeLabel,
              delegateLinearUserId: spec.delegateLinearUserId,
            },
            expected: outcome.expected,
            legalCommands,
          };

          if (outcome.blockReason) cell.blockReason = outcome.blockReason;
          if (outcome.requiredCapability) cell.requiredCapability = outcome.requiredCapability;

          cells.push(cell);
        }
      }
    }
  }

  return cells;
}
