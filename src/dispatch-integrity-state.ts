/**
 * AI-2091 §9 (AI-1808 wiring addendum) — dispatch-integrity gate liveness.
 *
 * The four dispatch-integrity gates this umbrella adds can each ship
 * unit-tested-green yet never be wired into the live dispatch path — the exact
 * AI-1808 dead-code-in-prod failure mode. This registry closes that: each gate
 * marks itself active at the moment createApp() wires it onto the production
 * dispatch path, and /health projects the registry as `dispatchIntegrity`. A
 * gate reads `active: true` if and only if bootstrap really installed it — never
 * a hardcoded literal — so the wiring is observable without waiting for a live
 * misroute (AC: "observable without waiting for a live misroute").
 *
 *   G1 deliveryTimeRecipientResolution — wrong-agent      (AI-2042)
 *   G2 phantomFetchabilityGate         — unfetchable       (AI-2015 / AI-2034)
 *   G3 wakeSessionDedup                — duplicate session (AI-1774)
 */

export type DispatchIntegrityGateKey =
  | "deliveryTimeRecipientResolution"
  | "phantomFetchabilityGate"
  | "wakeSessionDedup";

export interface DispatchIntegrityGateState {
  active: boolean;
  wiredAt: string | null;
  detail: string | null;
}

const GATE_KEYS: DispatchIntegrityGateKey[] = [
  "deliveryTimeRecipientResolution",
  "phantomFetchabilityGate",
  "wakeSessionDedup",
];

function blankGates(): Record<DispatchIntegrityGateKey, DispatchIntegrityGateState> {
  return GATE_KEYS.reduce(
    (acc, key) => {
      acc[key] = { active: false, wiredAt: null, detail: null };
      return acc;
    },
    {} as Record<DispatchIntegrityGateKey, DispatchIntegrityGateState>,
  );
}

let gates = blankGates();

/** Called at the createApp() wiring point for each gate — marks it live on the
 *  production dispatch path. Idempotent across createApp() calls. */
export function markDispatchIntegrityGateActive(
  key: DispatchIntegrityGateKey,
  detail?: string,
): void {
  gates[key] = {
    active: true,
    wiredAt: new Date().toISOString(),
    detail: detail ?? null,
  };
}

/** Snapshot for /health.dispatchIntegrity (deep-cloned). */
export function getDispatchIntegrityState(): Record<DispatchIntegrityGateKey, DispatchIntegrityGateState> {
  const out = blankGates();
  for (const key of GATE_KEYS) {
    out[key] = { ...gates[key] };
  }
  return out;
}

export function resetDispatchIntegrityStateForTest(): void {
  gates = blankGates();
}
