/**
 * INF-105 — Validation SLA watchdog.
 *
 * Periodically scans governed tickets in validation-eligible states
 * (e.g. `ac-validate`) delegated to the validator, and posts an
 * automated nudge comment + re-dispatches any that have been waiting
 * longer than the threshold.
 *
 * Design (Astrid, 2026-07-19):
 *  - Primary fix: Validation SLA watchdog — connector-side timer on
 *    validation-wait tickets. When a ticket has delegate = validator and was
 *    handed off for validation >15 min ago, re-dispatch a validate-and-close
 *    nudge comment (re-surfaces it in the validator's queue).
 *  - Idempotent: nudges at most every cooldown period per (ticket, state-entry).
 *  - Re-nudge: after the cooldown, if still waiting, another nudge fires.
 *
 * This follows the same pattern as sla-sweep.ts: batch query, client-side
 * filtering, SQLite dedup store, periodic timer registered at bootstrap.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createLogger, componentLogger } from "./logger.js";
import { registerCron, formatIntervalMs } from "./cron/registry.js";
import { LINEAR_API_URL } from "./linear-helpers.js";

// ── Logging ───────────────────────────────────────────────────────────────────

const log = componentLogger(createLogger(), "validation-watchdog");

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Check every 5 minutes. */
const DEFAULT_CADENCE_MS = 5 * 60 * 1000;

/** 15 minutes before first nudge. */
const DEFAULT_THRESHOLD_MS = 15 * 60 * 1000;

/** Don't re-nudge within 10 minutes. */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** Default validation state IDs (comma-separated). */
const DEFAULT_WATCHED_STATES = "ac-validate,review";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ValidationWatchdogOptions {
  /**
   * Linear API auth token, or a resolver returning the current token.
   * INF-333: pass a resolver in production — agent OAuth tokens rotate
   * (boot + every 20h), and a token captured once at registration is
   * revoked by the first refresh cycle, killing every sweep with
   * "Authentication required, not authenticated."
   */
  authToken: string | (() => string);
  /** Linear user ID of the validator (the agent who validates). */
  validatorLinearUserId: string;
  /** Injectable fetch for testing. */
  fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Wake function: re-dispatches the validator for this ticket. */
  wakeValidator: (identifier: string) => Promise<void>;
  /** Clock override for testing (epoch ms). */
  now?: () => number;
  /** Path to SQLite nudge dedup store. */
  nudgeStorePath?: string;
  /** Check cadence ms; default 5 min. */
  cadenceMs?: number;
  /** Time in state before first nudge ms; default 15 min. */
  thresholdMs?: number;
  /** Min time between nudges ms; default 10 min. */
  cooldownMs?: number;
  /** Comma-separated state IDs to watch; default "ac-validate,review". */
  watchedStates?: string;
}

export interface ValidationWatchdogResult {
  /** Total governed tickets scanned. */
  scanned: number;
  /** Tickets in watched states delegated to validator. */
  candidatesFound: number;
  /** Tickets exceeding threshold before dedup. */
  staleDetected: number;
  /** Nudge comments posted in this sweep. */
  nudgesPosted: number;
  /** Validator wakes dispatched. */
  wakesDispatched: number;
  /** Non-fatal errors. */
  errors: unknown[];
}

// ── SQLite nudge dedup store ──────────────────────────────────────────────────

class ValidationNudgeStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    if (dbPath) {
      const dir = path.dirname(path.resolve(dbPath));
      if (dir) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS validation_nudge (
        ticket_id TEXT NOT NULL,
        state_entered_at_ms INTEGER NOT NULL,
        last_nudge_at TEXT NOT NULL,
        nudge_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (ticket_id, state_entered_at_ms)
      )
    `);
  }

  /**
   * Atomically check whether a nudge is due and record it.
   * Returns { nudgeDue: true } if the cooldown has expired (or no prior nudge).
   * Returns { nudgeDue: false, lastNudgeAgeMs } if still in cooldown.
   */
  acquireNudgeSlot(
    ticketId: string,
    stateEnteredAtMs: number,
    cooldownMs: number,
  ): { nudgeDue: boolean; lastNudgeAgeMs: number | null } {
    const acquire = this.db.transaction((): { nudgeDue: boolean; lastNudgeAgeMs: number | null } => {
      const row = this.db
        .prepare(
          "SELECT last_nudge_at, nudge_count FROM validation_nudge WHERE ticket_id = ? AND state_entered_at_ms = ?",
        )
        .get(ticketId, stateEnteredAtMs) as { last_nudge_at: string; nudge_count: number } | undefined;

      if (!row) {
        this.db
          .prepare(
            "INSERT INTO validation_nudge (ticket_id, state_entered_at_ms, last_nudge_at, nudge_count) VALUES (?, ?, ?, 1)",
          )
          .run(ticketId, stateEnteredAtMs, new Date().toISOString());
        return { nudgeDue: true, lastNudgeAgeMs: null };
      }

      const lastNudgeMs = new Date(row.last_nudge_at + "Z").getTime();
      const ageMs = Date.now() - lastNudgeMs;

      if (ageMs < cooldownMs) {
        return { nudgeDue: false, lastNudgeAgeMs: ageMs };
      }

      this.db
        .prepare(
          "UPDATE validation_nudge SET last_nudge_at = ?, nudge_count = nudge_count + 1 WHERE ticket_id = ? AND state_entered_at_ms = ?",
        )
        .run(new Date().toISOString(), ticketId, stateEnteredAtMs);
      return { nudgeDue: true, lastNudgeAgeMs: ageMs };
    });

    return acquire();
  }

  close(): void {
    this.db.close();
  }
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

/**
 * Batch query: fetch all governed tickets in a single call, plus delegate
 * info and the most recent history entry timestamp for state-entry calc.
 *
 * We query for all tickets with `wf:*` labels (governed tickets), then
 * filter client-side for the specific validation states. This matches the
 * SLA sweep pattern and avoids adding a new query shape.
 */
const GOVERNED_TICKETS_QUERY = `
  query ValidationWatchdogGoverned {
    issues(filter: { labels: { name: { startsWith: "wf:" } } }, first: 100) {
      nodes {
        id
        identifier
        labels { nodes { name } }
        delegate { id name }
        history(first: 1, orderBy: createdAt) { nodes { createdAt } }
      }
    }
  }
`;

/** Post a comment on a Linear issue. */
const CREATE_COMMENT_MUTATION = `
  mutation CreateValidationNudge($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

// ── Internal: find state entry timestamp ──────────────────────────────────────

/**
 * Determine when the ticket entered its current validation state by using
 * the most recent history entry as the state entry timestamp.
 *
 * This matches the SLA sweep's approach (sla-sweep.ts line ~143):
 * `history(first: 1) { nodes { createdAt } }` — the most recent history
 * event is the state transition that landed the ticket in its current state.
 *
 * If there's no history (shouldn't happen for a governed ticket), falls back
 * to the current time minus the ticket's time-in-state approximation.
 */
function getStateEntryTimestamp(
  historyNodes: Array<{ createdAt: string }>,
): number | null {
  if (historyNodes.length === 0) return null;
  const latest = historyNodes[0];
  const ts = new Date(latest.createdAt).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** Extract the state: label value from an array of label names. */
function getCurrentStateFromLabels(labelNames: string[]): string | null {
  for (const name of labelNames) {
    if (name.startsWith("state:")) {
      return name.slice("state:".length);
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run one validation watchdog sweep.
 *
 * 1. Batch-fetches all governed tickets (wf:* labels).
 * 2. Filters for watched validation states with delegate = validator.
 * 3. Checks time-in-state against threshold.
 * 4. Posts nudge comment + wakes validator for stale tickets (cooldown-gated).
 */
export async function runValidationWatchdog(
  opts: ValidationWatchdogOptions,
): Promise<ValidationWatchdogResult> {
  const {
    authToken: authTokenOpt,
    validatorLinearUserId,
    wakeValidator,
    now = () => Date.now(),
    nudgeStorePath,
    thresholdMs = DEFAULT_THRESHOLD_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    watchedStates = DEFAULT_WATCHED_STATES,
  } = opts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // INF-333: resolve per sweep so token rotation between registration and
  // tick never leaves the watchdog holding a revoked token.
  const authToken = typeof authTokenOpt === "function" ? authTokenOpt() : authTokenOpt;

  const result: ValidationWatchdogResult = {
    scanned: 0,
    candidatesFound: 0,
    staleDetected: 0,
    nudgesPosted: 0,
    wakesDispatched: 0,
    errors: [],
  };

  const stateSet = new Set(watchedStates.split(",").map((s) => s.trim()).filter(Boolean));
  const store = new ValidationNudgeStore(nudgeStorePath);

  try {
    // ── 1. Batch fetch all governed tickets ──
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: GOVERNED_TICKETS_QUERY }),
    });

    type ValResp = {
      data?: {
        issues?: {
          nodes?: Array<{
            id: string;
            identifier: string;
            labels: { nodes: Array<{ name: string }> };
            delegate: { id: string; name: string } | null;
            history: { nodes: Array<{ createdAt: string }> };
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    const json = (await res.json()) as ValResp;
    if (json.errors?.length) {
      throw new Error(
        `Linear API errors: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const nodes = json.data?.issues?.nodes ?? [];
    result.scanned = nodes.length;

    // ── 2. Filter for watched validation states with validator delegate ──
    for (const node of nodes) {
      try {
        const labelNames = node.labels.nodes.map((l) => l.name);
        const currentState = getCurrentStateFromLabels(labelNames);
        if (!currentState) continue;

        // Only care about validation-eligible states
        if (!stateSet.has(currentState)) continue;

        // Must be delegated to the validator
        if (!node.delegate || node.delegate.id !== validatorLinearUserId) continue;
        result.candidatesFound++;

        // ── 3. Check time in state against threshold ──
        const stateEnteredAtMs = getStateEntryTimestamp(node.history.nodes);
        if (stateEnteredAtMs === null) continue;

        const nowMs = now();
        const timeInStateMs = nowMs - stateEnteredAtMs;

        if (timeInStateMs < thresholdMs) continue;
        result.staleDetected++;

        // ── 4. Idempotent nudge check (cooldown-gated) ──
        const { nudgeDue } = store.acquireNudgeSlot(
          node.identifier,
          stateEnteredAtMs,
          cooldownMs,
        );
        if (!nudgeDue) continue;

        // ── 5. Post nudge comment ──
        const waitMinutes = Math.round(timeInStateMs / 60000);
        const nudgeBody = [
          `⏰ **Validation SLA nudge**`,
          ``,
          `Ticket \`${node.identifier}\` entered **\`state:${currentState}\`** >${waitMinutes} min ago and is still awaiting validation.`,
          ``,
          `This is an automated re-dispatch from the Validation SLA watchdog (INF-105).`,
          ``,
          `The ticket has been re-surfaced in the validator's queue.`,
        ].join("\n");

        const commentRes = await fetchFn(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authToken },
          body: JSON.stringify({
            query: CREATE_COMMENT_MUTATION,
            variables: { issueId: node.id, body: nudgeBody },
          }),
        });

        type CommentResp = { data?: { commentCreate?: { success: boolean } } };
        const commentJson = (await commentRes.json()) as CommentResp;

        if (!commentJson.data?.commentCreate?.success) {
          result.errors.push(
            new Error(`Failed to post comment on ${node.identifier}`),
          );
          log.error(
            `INF-105: commentCreate failed for ${node.identifier}`,
          );
          continue;
        }

        result.nudgesPosted++;
        log.info(
          `INF-105: posted validation nudge on ${node.identifier} ` +
          `(state=${currentState}, waited=${waitMinutes}min)`,
        );

        // ── 6. Wake the validator ──
        try {
          await wakeValidator(node.identifier);
          result.wakesDispatched++;
          log.info(
            `INF-105: validator wake dispatched for ${node.identifier}`,
          );
        } catch (wakeErr) {
          result.errors.push(wakeErr);
          log.error(
            `INF-105: validator wake failed for ${node.identifier}: ` +
            `${wakeErr instanceof Error ? wakeErr.message : String(wakeErr)}`,
          );
        }
      } catch (err) {
        result.errors.push(err);
      }
    }
  } catch (err) {
    result.errors.push(err);
    log.error(
      `INF-105: watchdog sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    store.close();
  }

  return result;
}

// ── Cron registration ─────────────────────────────────────────────────────────

/**
 * Register a recurring validation SLA watchdog on a configurable interval.
 * Returns the timer handle so the caller can cancel on shutdown.
 * Timer is unref'd so it does not prevent process exit.
 */
export function registerValidationWatchdogCron(
  opts: ValidationWatchdogOptions,
): ReturnType<typeof setInterval> {
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  registerCron("validation-watchdog", `every ${formatIntervalMs(cadenceMs)}`);

  log.info(
    `INF-105: Validation watchdog registered — ` +
    `cadence=${cadenceMs}ms threshold=${opts.thresholdMs ?? DEFAULT_THRESHOLD_MS}ms ` +
    `cooldown=${opts.cooldownMs ?? DEFAULT_COOLDOWN_MS}ms ` +
    `states=${opts.watchedStates ?? DEFAULT_WATCHED_STATES}`,
  );

  const timer = setInterval(() => {
    runValidationWatchdog(opts).catch((err) => {
      console.error(
        `[validation-watchdog] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, cadenceMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
