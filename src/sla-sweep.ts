/**
 * AI-1773 — SLA evaluation driver for standalone governed tickets.
 *
 * Periodically sweeps all governed tickets (wf:* labels) and emits a
 * warning-level alert + steward wake for any ticket whose time in its current
 * state exceeds the per-state `sla:` value from the loaded workflow def.
 *
 * Design constraints:
 *  - One SLA vocabulary: reads `sla:` from workflow defs only.
 *  - No double-fire: managed children (barrier stall path) are excluded via
 *    isManagedBarrierFromLabels imported from barrier.ts — the same predicate,
 *    not a parallel heuristic.
 *  - Restart-resilient: breach dedup keyed on (ticket_id, state_entered_at_ms)
 *    in a SQLite store so restarts neither lose nor re-fire alerted breaches.
 *  - Batch fetch: one GraphQL query for all governed tickets; no per-ticket
 *    Linear API fan-out during the listing phase.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { getWorkflowId, getCurrentState, type WorkflowDef } from "./workflow-gate.js";
import { isManagedBarrierFromLabels } from "./barrier.js";
import { isNativelyTerminal } from "./terminality.js";
import { LINEAR_API_URL } from "./linear-helpers.js";
import { registerCron, formatIntervalMs, markCronRun } from "./cron/registry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SlaSweepOptions {
  authToken: string | (() => string);
  /** Path to a single YAML file or a directory of *.yaml files containing workflow defs.
   *  In directory mode (production WORKFLOW_DEFS_DIR), all *.yaml files are loaded. */
  workflowDefPath: string;
  /** Injectable fetch for testing; defaults to globalThis.fetch. */
  fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Alert bus notify() — called once per new breach. */
  notify: (alert: {
    severity: string;
    source: string;
    title: string;
    ticket?: string;
    [key: string]: unknown;
  }) => void;
  /** Steward wake — called once per new breach. */
  wakeAgent: (identifier: string) => Promise<void>;
  /** Clock override for testing (epoch ms). */
  now?: () => number;
  /** Path to the SQLite breach store. Omit for per-call in-memory (no cross-call dedup). */
  breachStorePath?: string;
  /** Sweep cadence in ms for registerSlaSweepCron; defaults to 5 minutes. */
  cadenceMs?: number;
}

export interface SlaSweepResult {
  /** Total governed tickets found in this sweep. */
  scanned: number;
  /** Managed children excluded (barrier stall path owns them). */
  managedChildrenExcluded: number;
  /** Tickets whose time in state exceeds the SLA (before dedup). */
  breachesDetected: number;
  /** New alerts emitted (after dedup). */
  alertsEmitted: number;
  /** Steward wakes dispatched. */
  wakesDispatched: number;
  /** Non-fatal errors encountered during the sweep. */
  errors: unknown[];
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Parse a duration string to ms. Matches barrier.ts parseSlaToMs. */
function parseSlaToMs(sla: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(h|m|s|ms)?\s*$/i.exec(sla);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? "ms").toLowerCase()) {
    case "h": return n * 60 * 60 * 1000;
    case "m": return n * 60 * 1000;
    case "s": return n * 1000;
    default: return n;
  }
}

/** Load workflow defs from a YAML file (possibly multi-document). */
function loadDefsFromFile(filePath: string, map: Map<string, WorkflowDef>): void {
  const raw = fs.readFileSync(filePath, "utf8");
  yaml.loadAll(raw, (doc: unknown) => {
    const def = doc as WorkflowDef;
    if (def && typeof def === "object" && def.id) {
      map.set(def.id, def);
    }
  });
}

/** Load all workflow defs from a single YAML file or a directory of *.yaml files. */
function loadDefs(workflowDefPath: string): Map<string, WorkflowDef> {
  const map = new Map<string, WorkflowDef>();
  if (!fs.existsSync(workflowDefPath)) return map;
  const stat = fs.statSync(workflowDefPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(workflowDefPath).sort()) {
      if (/\.ya?ml$/.test(entry)) {
        loadDefsFromFile(path.join(workflowDefPath, entry), map);
      }
    }
  } else {
    loadDefsFromFile(workflowDefPath, map);
  }
  return map;
}

/** Persisted (or in-memory) dedup store for alerted breaches. */
class BreachStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    if (dbPath) {
      const dir = path.dirname(path.resolve(dbPath));
      if (dir) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sla_alerted (
        ticket_id TEXT NOT NULL,
        state_entered_at_ms INTEGER NOT NULL,
        alerted_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, state_entered_at_ms)
      )
    `);
  }

  has(ticketId: string, stateEnteredAtMs: number): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sla_alerted WHERE ticket_id = ? AND state_entered_at_ms = ?")
      .get(ticketId, stateEnteredAtMs);
  }

  record(ticketId: string, stateEnteredAtMs: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO sla_alerted (ticket_id, state_entered_at_ms, alerted_at) VALUES (?, ?, ?)",
      )
      .run(ticketId, stateEnteredAtMs, new Date().toISOString());
  }
}

interface GovernedTicketNode {
  id: string;
  identifier: string;
  team: { id: string };
  state?: { type: string } | null;
  labels: { nodes: Array<{ id?: string; name: string }> };
  history: { nodes: Array<{ createdAt: string }> };
  parent: {
    id: string;
    identifier: string;
    labels: { nodes: Array<{ name: string }> };
  } | null;
}

function resolveAuthToken(authToken: SlaSweepOptions["authToken"]): string {
  return typeof authToken === "function" ? authToken() : authToken;
}

function formatGraphQlErrors(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "none";
  return errors
    .map((err) => {
      if (err && typeof err === "object" && "message" in err) {
        return String((err as { message?: unknown }).message);
      }
      return JSON.stringify(err);
    })
    .join("; ");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run one SLA evaluation sweep over all governed tickets.
 *
 * Fetches all tickets with wf:* labels in a single batch query (AC5), checks
 * each for SLA breach, excludes managed children (AC2), and emits exactly one
 * alert + one steward wake per new breach (AC1, deduped via breach store, AC3).
 */
export async function runSlaSweep(opts: SlaSweepOptions): Promise<SlaSweepResult> {
  const {
    workflowDefPath,
    notify,
    wakeAgent,
    now = () => Date.now(),
    breachStorePath,
  } = opts;
  const authToken = resolveAuthToken(opts.authToken);
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  const result: SlaSweepResult = {
    scanned: 0,
    managedChildrenExcluded: 0,
    breachesDetected: 0,
    alertsEmitted: 0,
    wakesDispatched: 0,
    errors: [],
  };

  const defs = loadDefs(workflowDefPath);
  const store = new BreachStore(breachStorePath);

  // Single batch query — no per-ticket fan-out (AC5).
  // The query body includes "labels" and "issues" so it matches the test fetch mock.
  const query = `
    query SlaSweepGovernedTickets {
      issues(filter: { labels: { name: { startsWith: "wf:" } } }) {
        nodes {
          id
          identifier
          team { id }
          state { type }
          labels { nodes { id name } }
          history(first: 1) { nodes { createdAt } }
          parent {
            id
            identifier
            labels { nodes { name } }
          }
        }
      }
    }
  `;

  let nodes: GovernedTicketNode[];
  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query }),
    });
    type Resp = {
      data?: { issues?: { nodes?: GovernedTicketNode[] } };
      errors?: unknown[];
    };
    const data = (await res.json()) as Resp;
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      throw new Error(`Linear GraphQL errors: ${formatGraphQlErrors(data.errors)}`);
    }
    nodes = data.data?.issues?.nodes ?? [];
  } catch (err) {
    result.errors.push(err);
    return result;
  }

  result.scanned = nodes.length;
  const nowMs = now();

  for (const node of nodes) {
    try {
      const labelNames = node.labels.nodes.map((l) => l.name);
      const wfId = getWorkflowId(labelNames);
      const stateId = getCurrentState(labelNames);

      if (!wfId || !stateId) continue;

      // Terminal states have no SLA — skip (AC4). INF-205: natively-closed
      // tickets (completed/canceled/duplicate) are terminal even when a stale
      // non-terminal state:* label survives — never breach-alert a closed ticket.
      if (stateId === "done" || stateId === "escape") continue;
      if (isNativelyTerminal(node.state?.type)) continue;

      // Look up workflow def — unknown workflow → skip (AC4)
      const def = defs.get(wfId);
      if (!def) continue;

      // Look up state def → SLA — no SLA value → skip (AC4)
      const stateDef = def.states.find((s) => s.id === stateId);
      if (!stateDef?.sla) continue;

      const slaMs = parseSlaToMs(stateDef.sla);
      if (slaMs === null) continue;

      // Managed-child exclusion: use the shared predicate from barrier.ts (AC2).
      // The batch response already includes parent labels — no extra fetch needed.
      if (node.parent) {
        const parentLabels = node.parent.labels.nodes.map((l) => l.name);
        if (isManagedBarrierFromLabels(parentLabels, defs)) {
          result.managedChildrenExcluded++;
          continue;
        }
      }

      // State-entry timestamp from the first history node (AC3: timestamp-driven)
      const stateEnteredAtIso = node.history.nodes[0]?.createdAt;
      if (!stateEnteredAtIso) continue;
      const stateEnteredAtMs = new Date(stateEnteredAtIso).getTime();

      const timeInStateMs = nowMs - stateEnteredAtMs;
      if (timeInStateMs < slaMs) continue;

      // Breach confirmed
      result.breachesDetected++;

      // Dedup: skip if this (ticket, state entry) was already alerted (AC1, AC3)
      if (store.has(node.identifier, stateEnteredAtMs)) continue;

      // Emit exactly one warning-level alert (AC1)
      notify({
        severity: "warning",
        source: "sla-sweep",
        title: `SLA breach: ${node.identifier} in state:${stateId} (${stateDef.sla})`,
        ticket: node.identifier,
      });
      result.alertsEmitted++;

      // Exactly one steward wake per new breach (AC1)
      await wakeAgent(node.identifier);
      result.wakesDispatched++;

      // Record so subsequent sweeps and restarts don't re-fire (AC1, AC3)
      store.record(node.identifier, stateEnteredAtMs);
    } catch (err) {
      result.errors.push(err);
    }
  }

  return result;
}

const DEFAULT_CADENCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Register a recurring SLA sweep on a configurable interval.
 * Returns the timer handle so the caller can cancel it on shutdown.
 * The timer is unref'd so it does not prevent process exit.
 */
export function registerSlaSweepCron(opts: SlaSweepOptions): ReturnType<typeof setInterval> {
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  registerCron("sla-sweep", `every ${formatIntervalMs(cadenceMs)}`);
  const timer = setInterval(() => {
    runSlaSweep(opts).catch((err) => {
      // Sweep errors are non-fatal (result.errors captures per-ticket issues),
      // but a whole-sweep failure (e.g. unreadable workflowDefPath) must not
      // be silent — that would be dead-code-in-prod with a registry entry.
      console.error(`[sla-sweep] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      markCronRun("sla-sweep");
    });
  }, cadenceMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
