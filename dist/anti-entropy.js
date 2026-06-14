/**
 * AI-1547 — Transition atomicity + standing anti-entropy reconciliation loop (G-7/G-17).
 *
 * Two gaps addressed:
 *
 *   G-7: A crash between the label write and the native stateId write leaves the
 *   ticket with the new label but the old native state. On restart, the reconciliation
 *   pass detects the mismatch and heals the native stateId to match the label.
 *   (The label is authoritative because the proxy writes it first and restarts are
 *   more reliable than in-flight writes completing.)
 *
 *   G-17: Boot-time-only reconciliation misses dropped webhooks. A dropped
 *   terminal-child webhook leaves the parent's barrier un-decremented and projections
 *   stale. The standing anti-entropy loop catches this on its next cadence pass.
 *
 * AC1: fault-injected kill between the two writes → restart reconciles native to label.
 * AC2: a dropped terminal-child webhook → anti-entropy pass detects the barrier
 *      didn't decrement and reconciles it.
 * AC3: anti-entropy runs on a cadence and alerts on drift.
 */
import { createLogger, componentLogger } from "./logger.js";
import { loadWorkflowRegistry, getWorkflowId, getCurrentState, resolveNativeStateId, } from "./workflow-gate.js";
import { attemptBarrierTransition } from "./barrier.js";
import { LINEAR_API_URL } from "./linear-helpers.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "anti-entropy");
// ── Linear API helpers ─────────────────────────────────────────────────────
/**
 * Fetch all active wf:* tickets with their native Linear state.
 * "Active" means not in terminal workflow states (state:done, state:escape).
 */
export async function fetchActiveWfTickets(authToken) {
    const query = `
    query AntiEntropyIssues {
      issues(
        filter: { labels: { some: { name: { startsWith: "wf:" } } } }
        first: 250
      ) {
        nodes {
          id
          identifier
          state { id name }
          labels { nodes { name } }
          team { id }
        }
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query }),
        });
        const data = (await res.json());
        const all = data.data?.issues?.nodes ?? [];
        return all
            .filter((n) => {
            const stateLabel = n.labels.nodes.find((l) => l.name.startsWith("state:"))?.name;
            const stateId = stateLabel?.slice("state:".length);
            return stateId !== "done" && stateId !== "escape" && n.state !== null;
        })
            .map((n) => ({
            internalId: n.id,
            identifier: n.identifier,
            labels: n.labels.nodes.map((l) => l.name),
            teamId: n.team?.id ?? "",
            nativeStateId: n.state.id,
            nativeStateName: n.state.name,
        }));
    }
    catch (err) {
        log.error(`anti-entropy: fetchActiveWfTickets failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
/**
 * Write only the native stateId for a ticket (without touching labels or delegate).
 * Used by reconciliation to heal native-state drift.
 */
async function healNativeStateId(internalId, nativeStateId, authToken) {
    const mutation = `
    mutation HealNativeState($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
      }
    }
  `;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: mutation, variables: { issueId: internalId, stateId: nativeStateId } }),
        });
        const data = (await res.json());
        return data.data?.issueUpdate?.success ?? false;
    }
    catch (err) {
        log.warn(`anti-entropy: healNativeStateId failed for ${internalId}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
// ── Core reconciliation ────────────────────────────────────────────────────
/**
 * For a single ticket, check whether the native Linear stateId matches what the
 * state:* label implies (via the workflow YAML's native_state field). If it
 * doesn't match, alert and heal.
 */
async function reconcileNativeState(ticket, registry, authToken) {
    const wfId = getWorkflowId(ticket.labels);
    const stateLabel = getCurrentState(ticket.labels);
    if (!wfId || !stateLabel)
        return null;
    const def = registry.get(wfId);
    if (!def)
        return null;
    const stateDef = def.states.find((s) => s.id === stateLabel);
    if (!stateDef?.native_state)
        return null;
    const expectedNativeStateId = await resolveNativeStateId(ticket.teamId, stateDef.native_state, authToken);
    if (!expectedNativeStateId)
        return null;
    if (ticket.nativeStateId === expectedNativeStateId)
        return null; // in sync
    const result = {
        identifier: ticket.identifier,
        expectedNativeState: stateDef.native_state,
        expectedNativeStateId,
        actualNativeStateName: ticket.nativeStateName,
        actualNativeStateId: ticket.nativeStateId,
        healed: false,
    };
    log.warn(`anti-entropy: native state drift on ${ticket.identifier}: ` +
        `label='state:${stateLabel}' expects native='${stateDef.native_state}' (${expectedNativeStateId}) ` +
        `but actual native='${ticket.nativeStateName}' (${ticket.nativeStateId}) — healing`);
    const healed = await healNativeStateId(ticket.internalId, expectedNativeStateId, authToken);
    result.healed = healed;
    if (healed) {
        log.info(`anti-entropy: healed native state on ${ticket.identifier}: ` +
            `'${ticket.nativeStateName}' → '${stateDef.native_state}'`);
    }
    else {
        result.error = "healNativeStateId mutation returned non-success";
        log.warn(`anti-entropy: failed to heal native state on ${ticket.identifier}`);
    }
    return result;
}
/**
 * For a ticket in state:managing, check whether all children are terminal and
 * the barrier should have fired. If so, fire it now (AC2 — dropped webhook
 * recovery).
 */
async function reconcileBarrier(ticket, authToken) {
    const result = {
        identifier: ticket.identifier,
        transitioned: false,
        skipped: false,
    };
    try {
        const barrierResult = await attemptBarrierTransition(ticket.identifier, authToken);
        if (barrierResult.transitioned) {
            result.transitioned = true;
            log.info(`anti-entropy: barrier fired for ${ticket.identifier} — ` +
                `${barrierResult.terminalCount}/${barrierResult.totalChildren} children terminal (dropped webhook recovery)`);
        }
        else if (barrierResult.error) {
            // Not all terminal, or not applicable — not an error condition
            result.skipped = true;
            result.skipReason = barrierResult.error;
        }
    }
    catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        log.warn(`anti-entropy: barrier reconcile failed for ${ticket.identifier}: ${result.error}`);
    }
    return result;
}
// ── Main entry point ───────────────────────────────────────────────────────
/**
 * Run one anti-entropy pass: reconcile native states and fire any missed barriers.
 *
 * Called both at startup (G-7 AC1) and on the standing periodic cron (G-17 AC2/AC3).
 */
export async function runAntiEntropy(authToken, options) {
    const result = {
        scanned: 0,
        nativeDrifts: [],
        barrierFires: [],
        errors: [],
    };
    log.info("anti-entropy: starting pass");
    let registry;
    if (options?.registry) {
        registry = options.registry;
    }
    else {
        try {
            registry = await loadWorkflowRegistry();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`anti-entropy: failed to load workflow registry — aborting: ${msg}`);
            result.errors.push(`registry load failed: ${msg}`);
            return result;
        }
    }
    const tickets = await fetchActiveWfTickets(authToken);
    result.scanned = tickets.length;
    log.info(`anti-entropy: scanned ${tickets.length} active wf:* ticket(s)`);
    for (const ticket of tickets) {
        // ── G-7: Native state reconciliation ──────────────────────────────────
        try {
            const drift = await reconcileNativeState(ticket, registry, authToken);
            if (drift)
                result.nativeDrifts.push(drift);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`anti-entropy: native state check failed for ${ticket.identifier}: ${msg}`);
            result.errors.push(`${ticket.identifier}: native state check failed: ${msg}`);
        }
        // ── G-17: Barrier reconciliation for managing tickets ─────────────────
        const stateLabel = getCurrentState(ticket.labels);
        if (stateLabel === "managing") {
            const barrierResult = await reconcileBarrier(ticket, authToken);
            if (barrierResult.transitioned || barrierResult.error) {
                result.barrierFires.push(barrierResult);
            }
        }
    }
    const driftCount = result.nativeDrifts.length;
    const healedCount = result.nativeDrifts.filter((d) => d.healed).length;
    const barrierFiredCount = result.barrierFires.filter((b) => b.transitioned).length;
    log.info(`anti-entropy: pass complete — ` +
        `scanned=${result.scanned} native_drifts=${driftCount} healed=${healedCount} ` +
        `barrier_fires=${barrierFiredCount} errors=${result.errors.length}`);
    if (driftCount > 0 || barrierFiredCount > 0) {
        log.warn(`anti-entropy: DRIFT ALERT — ` +
            `${driftCount} native state drift(s) (${healedCount} healed), ` +
            `${barrierFiredCount} missed barrier(s) recovered`);
    }
    return result;
}
//# sourceMappingURL=anti-entropy.js.map