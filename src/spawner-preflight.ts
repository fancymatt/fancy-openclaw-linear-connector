/**
 * INF-97: Sprint-spawner pre-flight readiness gate.
 *
 * Evaluates substrate health check results before a sprint-spawner fans out.
 * This is the GATE function — it receives already-computed check results and
 * produces a verdict (ok/blockFanOut), an actionable readiness report, and an
 * optional break-glass override path.
 *
 * Actual check execution lives in the caller (the sprint-spawner or its
 * orchestration layer); this module evaluates those results and enforces
 * the gate.
 *
 * Liveness is observable at /health.spawnerPreflight without waiting for a
 * sprint-spawner trigger (AC6).
 */

import crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PreFlightCheck {
  /** Machine-readable check name (e.g. "workflowDefDrift"). */
  name: string;
  /** Whether the check passed. */
  ok: boolean;
  /** Human-readable detail about the check result. */
  detail: string;
  /** Named owner responsible for remediation (if failed). */
  owner?: string;
}

export interface PreFlightRemediation {
  /** Name of the failed check. */
  check: string;
  /** Named owner responsible. */
  owner: string;
  /** Suggested remediation. */
  remediation: string;
}

export interface PreFlightReport {
  /** ISO timestamp when the pre-flight ran. */
  timestamp: string;
  /** All check results, in insertion order. */
  checks: PreFlightCheck[];
  /** Named-owner remediation items (empty when all pass). */
  remediation: PreFlightRemediation[];
  /** Whether an override was logged (only present when override used). */
  overrideLogged?: boolean;
  /** Actor who invoked the override. */
  overrideActor?: string;
  /** ISO timestamp of override acknowledgment. */
  overrideAcknowledgedAt?: string;
}

export interface PreFlightResult {
  /** Whether the pre-flight passed (all checks OK or override granted). */
  ok: boolean;
  /** Whether fan-out should be blocked. */
  blockFanOut: boolean;
  /** Full readiness report. */
  report: PreFlightReport;
  /** Single-use override token (only generated when blocked). */
  overrideToken?: string;
  /** ISO timestamp of override acknowledgment (only when override used). */
  overrideAcknowledgedAt?: string;
  /** Actor who invoked the override (only when override used). */
  overrideActor?: string;
}

export interface PreFlightStatus {
  /** ISO timestamp of the last pre-flight run, or null if never run. */
  lastRunAt: string | null;
  /** Whether the last run was healthy. Null if never run or after reset. */
  healthy: boolean | null;
  /** Whether the component is registered/scheduled (always true after bootstrap). */
  scheduled: boolean;
}

/** A single check input value passed to runPreFlight. */
interface CheckInputValue {
  ok: boolean;
  detail: string;
  owner?: string;
}

/** Input checks record keyed by check name. */
type CheckInput = Record<string, CheckInputValue>;

export interface RunPreFlightOptions {
  /** Check results to evaluate. */
  checks: CheckInput;
  /** Break-glass override token (optional, from a prior blocked run). */
  overrideToken?: string;
  /** Human actor requesting the override. */
  overrideActor?: string;
}

// ── Singleton state ────────────────────────────────────────────────────────

let _lastRunAt: string | null = null;
let _healthy: boolean | null = null;
let _scheduled = false;
/** The currently active (unconsumed) override token, if any. */
let _pendingOverrideToken: string | null = null;
/** Set of consumed override tokens (for audit/replay defense). */
const _consumedTokens = new Set<string>();

/**
 * Register the pre-flight component as scheduled. Called once at bootstrap.
 */
export function registerSpawnerPreflight(): void {
  _scheduled = true;
}

// ── Override token generation ──────────────────────────────────────────────

function generateOverrideToken(): string {
  return crypto.randomUUID();
}

// ── Main evaluation ────────────────────────────────────────────────────────

/**
 * Run the pre-flight readiness gate.
 *
 * @param options - Check results and optional override parameters.
 * @returns A PreFlightResult with the verdict and readiness report.
 * @throws If the checks object is empty.
 */
export async function runPreFlight(options: RunPreFlightOptions): Promise<PreFlightResult> {
  const { checks, overrideToken, overrideActor } = options;
  const now = new Date().toISOString();

  const checkNames = Object.keys(checks);
  if (checkNames.length === 0) {
    throw new Error("pre-flight checks object is empty — at least one check required");
  }

  // ── Build check list in insertion order ──────────────────────────────
  const checkResults: PreFlightCheck[] = checkNames.map((name) => {
    const input = checks[name];
    return {
      name,
      ok: input.ok,
      detail: input.detail,
      owner: input.owner,
    };
  });

  const failures = checkResults.filter((c) => !c.ok);
  const allPass = failures.length === 0;

  // ── Override handling ────────────────────────────────────────────────
  let overrideUsed = false;
  let overrideAcknowledgedAt: string | undefined;

  if (!allPass && overrideToken && overrideActor) {
    // Validate the override token against the pending token
    if (_pendingOverrideToken !== null && overrideToken === _pendingOverrideToken && !_consumedTokens.has(overrideToken)) {
      // Consume the token (single-use)
      _consumedTokens.add(overrideToken);
      _pendingOverrideToken = null;
      overrideUsed = true;
      overrideAcknowledgedAt = now;
    }
  }

  const canProceed = allPass || overrideUsed;
  const blockFanOut = !canProceed;

  // ── Build report ─────────────────────────────────────────────────────
  const remediation: PreFlightRemediation[] = failures
    .filter((c) => c.owner)
    .map((c) => ({
      check: c.name,
      owner: c.owner!,
      remediation: `Fix ${c.name}: ${c.detail}`,
    }))
    .concat(
      failures
        .filter((c) => !c.owner)
        .map((c) => ({
          check: c.name,
          owner: "unassigned",
          remediation: `Fix ${c.name}: ${c.detail} — no owner specified`,
        })),
    );

  const report: PreFlightReport = {
    timestamp: now,
    checks: checkResults,
    remediation,
  };

  if (overrideUsed) {
    report.overrideLogged = true;
    report.overrideActor = overrideActor;
    report.overrideAcknowledgedAt = overrideAcknowledgedAt;
  }

  // ── Generate override token if blocked ───────────────────────────────
  let resultOverrideToken: string | undefined;
  if (blockFanOut) {
    resultOverrideToken = generateOverrideToken();
    _pendingOverrideToken = resultOverrideToken;
  } else {
    // Clear any stale pending token when checks pass or override succeeds
    _pendingOverrideToken = null;
  }

  // ── Update liveness state ────────────────────────────────────────────
  _lastRunAt = now;
  _healthy = canProceed;

  return {
    ok: canProceed,
    blockFanOut,
    report,
    overrideToken: resultOverrideToken,
    overrideAcknowledgedAt,
    overrideActor: overrideUsed ? overrideActor : undefined,
  };
}

/**
 * Get the current pre-flight liveness state.
 */
export function getPreFlightLiveness(): PreFlightStatus {
  return {
    lastRunAt: _lastRunAt,
    healthy: _healthy,
    scheduled: _scheduled,
  };
}

/**
 * Reset pre-flight status (for tests).
 */
export function resetPreFlightStatus(): void {
  _lastRunAt = null;
  _healthy = null;
  // Do NOT reset _scheduled — that's a bootstrap-time flag.
  // Do NOT clear _consumedTokens — that's an internal override mechanism,
  // not a test concern (tokens are inherently single-use and tests generate
  // their own tokens per run).
}
