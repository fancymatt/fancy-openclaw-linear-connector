/**
 * AI-1594 — Governed state:* regression guard.
 *
 * AC3: A stale webhook carrying an older state:* label set must NOT cause the
 *      connector to treat the ticket as regressed. The StateHighWaterMarkTracker
 *      records the furthest state each ticket has reached (per B2 apply); the
 *      webhook handler checks detectStateRegression before running role-guard
 *      delegate correction.
 *
 * AC4: detectStateRegression emits a structured warning when a backwards
 *      label transition is observed without a corresponding B2 apply.
 */
/**
 * Returns the topological rank of `stateId` in the workflow's forward path via
 * BFS from entry_state. Returns null for states unreachable via normal
 * forward transitions (break-glass terminals, unknown state ids).
 */
export function rankStateInWorkflow(stateId, def) {
    const entryState = def.entry_state;
    if (!entryState)
        return null;
    const visited = new Map();
    const queue = [entryState];
    let rank = 0;
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current))
            continue;
        visited.set(current, rank++);
        const node = def.states.find((s) => s.id === current);
        if (!node)
            continue;
        for (const t of node.transitions ?? []) {
            if (!visited.has(t.to)) {
                queue.push(t.to);
            }
        }
    }
    return visited.has(stateId) ? visited.get(stateId) : null;
}
/**
 * Returns true when `observedState` ranks strictly before `lastKnownState`
 * in the forward path (i.e. the observed state is a regression).
 * Fails open (returns false) when either state is unknown to the workflow.
 */
export function isStateBackwards(observedState, lastKnownState, def) {
    const observedRank = rankStateInWorkflow(observedState, def);
    const lastKnownRank = rankStateInWorkflow(lastKnownState, def);
    if (observedRank === null || lastKnownRank === null)
        return false;
    return observedRank < lastKnownRank;
}
/**
 * Checks whether the `state:*` label in `labels` represents a regression
 * relative to `lastKnownState`. Callers must skip delegate-correction logic
 * when `isRegression` is true (AC3) and emit the `warning` string (AC4).
 *
 * Fails open (no regression) when:
 *   - lastKnownState is null (ticket freshly seen, no basis for comparison)
 *   - labels carry no `wf:*` label (ad-hoc ticket)
 *   - labels carry no `state:*` label (enrollment-gap ticket)
 */
export function detectStateRegression(ticketId, labels, lastKnownState, def) {
    if (lastKnownState === null)
        return { isRegression: false };
    if (!labels.some((l) => l.startsWith("wf:")))
        return { isRegression: false };
    const stateLabel = labels.find((l) => l.startsWith("state:"));
    if (!stateLabel)
        return { isRegression: false };
    const observedState = stateLabel.slice("state:".length);
    if (isStateBackwards(observedState, lastKnownState, def)) {
        return {
            isRegression: true,
            observedState,
            lastKnownState,
            warning: `[AI-1594] State regression on ${ticketId}: observed state:${observedState} is behind ` +
                `last known state:${lastKnownState} — stale webhook suspected; skipping delegate correction`,
        };
    }
    return { isRegression: false };
}
/**
 * Creates a per-ticket monotonic high-water-mark tracker. When `def` is
 * provided, `advance` uses workflow ranking to reject backwards moves. Without
 * `def`, all advances are accepted (fail open — no regression detection).
 */
export function createStateHighWaterMarkTracker(def) {
    const store = new Map();
    return {
        getLastKnownState(ticketId) {
            return store.get(ticketId) ?? null;
        },
        advance(ticketId, state) {
            const current = store.get(ticketId);
            if (current === undefined) {
                store.set(ticketId, state);
                return false;
            }
            if (current === state)
                return false;
            if (def && isStateBackwards(state, current, def)) {
                return true; // regression detected; high-water mark NOT updated
            }
            store.set(ticketId, state);
            return false;
        },
    };
}
/**
 * Process-wide singleton tracker shared between the B2 proxy path (advance)
 * and the webhook delivery path (regression check). Created without a def
 * because the B2 path is always authoritative forward motion — regression
 * detection uses detectStateRegression separately with the loaded def.
 */
export const sharedStateTracker = createStateHighWaterMarkTracker();
//# sourceMappingURL=state-regression.js.map