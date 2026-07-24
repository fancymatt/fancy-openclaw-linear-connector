/**
 * INF-473 — Intake-ack watchdog.
 *
 * Periodically scans governed tickets in 'intake' state that have an AI delegate,
 * and posts an automated nudge comment + re-dispatches if they have been
 * waiting longer than the threshold.
 *
 * Problem: A ticket assigned to an agent in 'intake' (or entry-like state) can
 * stall indefinitely if the agent takes a minor action (e.g. Thinking status)
 * but never runs the transition verb ('accept'). The FirstActionWatchdog is
 * satisfied by the minor action, and the StuckDelegateDetector needs a comment.
 *
 * This watchdog ensures that assigned tickets move out of 'intake' within a
 * reasonable window (default 1h).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createLogger, componentLogger } from "./logger.js";
import { registerCron, formatIntervalMs, markCronRun } from "./cron/registry.js";
import { LINEAR_API_URL } from "./linear-helpers.js";
import { normalizeSessionKey } from "./session-key.js";

// ── Logging ───────────────────────────────────────────────────────────────────

const log = componentLogger(createLogger(), "intake-ack-watchdog");

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Check every 10 minutes. */
const DEFAULT_CADENCE_MS = 10 * 60 * 1000;

/** 1 hour before first nudge. */
const DEFAULT_THRESHOLD_MS = 60 * 60 * 1000;

/** Don't re-nudge within 30 minutes. */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/** The state ID to watch. */
const WATCHED_STATE = "intake";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IntakeAckWatchdogOptions {
  /** Linear API auth token, or a resolver returning the current token. */
  authToken: string | (() => string);
  /** Set of known AI agent Linear user IDs to watch. */
  agentLinearUserIds: Set<string>;
  /** Injectable fetch for testing. */
  fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Wake function: re-dispatches the delegate for this ticket. */
  wakeAgent: (identifier: string, agentId: string) => Promise<void>;
  /** Clock override for testing (epoch ms). */
  now?: () => number;
  /** Path to SQLite nudge dedup store. */
  nudgeStorePath?: string;
  /** Check cadence ms; default 10 min. */
  cadenceMs?: number;
  /** Time in intake before first nudge ms; default 1h. */
  thresholdMs?: number;
  /** Min time between nudges ms; default 30 min. */
  cooldownMs?: number;
}

export interface IntakeAckWatchdogResult {
  /** Total governed tickets scanned. */
  scanned: number;
  /** Tickets in 'intake' state delegated to an AI agent. */
  candidatesFound: number;
  /** Tickets exceeding threshold before dedup. */
  staleDetected: number;
  /** Nudge comments posted in this sweep. */
  nudgesPosted: number;
  /** Agent wakes dispatched. */
  wakesDispatched: number;
  /** Non-fatal errors. */
  errors: unknown[];
}

// ── SQLite nudge dedup store ──────────────────────────────────────────────────

class IntakeAckStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    if (dbPath) {
      const dir = path.dirname(path.resolve(dbPath));
      if (dir) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intake_ack_nudge (
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
   */
  acquireNudgeSlot(
    ticketId: string,
    stateEnteredAtMs: number,
    cooldownMs: number,
  ): { nudgeDue: boolean; lastNudgeAgeMs: number | null } {
    const acquire = this.db.transaction((): { nudgeDue: boolean; lastNudgeAgeMs: number | null } => {
      const row = this.db
        .prepare(
          "SELECT last_nudge_at, nudge_count FROM intake_ack_nudge WHERE ticket_id = ? AND state_entered_at_ms = ?",
        )
        .get(ticketId, stateEnteredAtMs) as { last_nudge_at: string; nudge_count: number } | undefined;

      if (!row) {
        this.db
          .prepare(
            "INSERT INTO intake_ack_nudge (ticket_id, state_entered_at_ms, last_nudge_at, nudge_count) VALUES (?, ?, ?, 1)",
          )
          .run(ticketId, stateEnteredAtMs, new Date().toISOString());
        return { nudgeDue: true, lastNudgeAgeMs: null };
      }

      const lastNudgeMs = new Date(row.last_nudge_at).getTime();
      const ageMs = Date.now() - lastNudgeMs;

      if (ageMs < cooldownMs) {
        return { nudgeDue: false, lastNudgeAgeMs: ageMs };
      }

      this.db
        .prepare(
          "UPDATE intake_ack_nudge SET last_nudge_at = ?, nudge_count = nudge_count + 1 WHERE ticket_id = ? AND state_entered_at_ms = ?",
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

const GOVERNED_TICKETS_QUERY = `
  query IntakeAckWatchdogGoverned {
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

const CREATE_COMMENT_MUTATION = `
  mutation CreateIntakeAckNudge($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

// ── Internal Helpers ─────────────────────────────────────────────────────────

function getStateEntryTimestamp(
  historyNodes: Array<{ createdAt: string }>,
): number | null {
  if (historyNodes.length === 0) return null;
  const latest = historyNodes[0];
  const ts = new Date(latest.createdAt).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function getCurrentStateFromLabels(labelNames: string[]): string | null {
  for (const name of labelNames) {
    if (name.startsWith("state:")) {
      return name.slice("state:".length);
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runIntakeAckWatchdog(
  opts: IntakeAckWatchdogOptions,
): Promise<IntakeAckWatchdogResult> {
  const {
    authToken: authTokenOpt,
    agentLinearUserIds,
    wakeAgent,
    now = () => Date.now(),
    nudgeStorePath,
    thresholdMs = DEFAULT_THRESHOLD_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
  } = opts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const authToken = typeof authTokenOpt === "function" ? authTokenOpt() : authTokenOpt;

  const result: IntakeAckWatchdogResult = {
    scanned: 0,
    candidatesFound: 0,
    staleDetected: 0,
    nudgesPosted: 0,
    wakesDispatched: 0,
    errors: [],
  };

  const store = new IntakeAckStore(nudgeStorePath);

  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: GOVERNED_TICKETS_QUERY }),
    });

    type Resp = {
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

    const json = (await res.json()) as Resp;
    if (json.errors?.length) {
      throw new Error(`Linear API errors: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    const nodes = json.data?.issues?.nodes ?? [];
    result.scanned = nodes.length;

    for (const node of nodes) {
      try {
        const labelNames = node.labels.nodes.map((l) => l.name);
        const currentState = getCurrentStateFromLabels(labelNames);

        // Only care about 'intake' state
        if (currentState !== WATCHED_STATE) continue;

        // Must have an AI delegate
        if (!node.delegate || !agentLinearUserIds.has(node.delegate.id)) continue;
        result.candidatesFound++;

        const stateEnteredAtMs = getStateEntryTimestamp(node.history.nodes);
        if (stateEnteredAtMs === null) continue;

        const nowMs = now();
        const timeInStateMs = nowMs - stateEnteredAtMs;

        if (timeInStateMs < thresholdMs) continue;
        result.staleDetected++;

        const { nudgeDue } = store.acquireNudgeSlot(
          node.identifier,
          stateEnteredAtMs,
          cooldownMs,
        );
        if (!nudgeDue) continue;

        const waitMinutes = Math.round(timeInStateMs / 60000);
        const nudgeBody = [
          `⏰ **Intake-ack timeout**`,
          ``,
          `Ticket \`${node.identifier}\` has stalled in **\`state:intake\`** for ${waitMinutes} minutes while delegated to **${node.delegate.name}**.`,
          ``,
          `Expected: The delegate should acknowledge this ticket by running the transition verb (e.g. \`accept\` or \`continue-workflow\`).`,
          ``,
          `This is an automated re-dispatch from the Intake-ack watchdog (INF-473).`,
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
          result.errors.push(new Error(`Failed to post comment on ${node.identifier}`));
          continue;
        }

        result.nudgesPosted++;
        log.info(`INF-473: posted intake-ack nudge on ${node.identifier} (waited=${waitMinutes}min)`);

        try {
          // Re-dispatch the agent
          await wakeAgent(node.identifier, node.delegate.name);
          result.wakesDispatched++;
        } catch (wakeErr) {
          result.errors.push(wakeErr);
        }
      } catch (err) {
        result.errors.push(err);
      }
    }
  } catch (err) {
    result.errors.push(err);
    log.error(`INF-473: watchdog sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    store.close();
  }

  return result;
}

export function registerIntakeAckWatchdogCron(
  opts: IntakeAckWatchdogOptions,
): ReturnType<typeof setInterval> {
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  registerCron("intake-ack-watchdog", `every ${formatIntervalMs(cadenceMs)}`);

  log.info(
    `INF-473: Intake-ack watchdog registered — ` +
    `cadence=${cadenceMs}ms threshold=${opts.thresholdMs ?? DEFAULT_THRESHOLD_MS}ms`,
  );

  const timer = setInterval(() => {
    runIntakeAckWatchdog(opts).catch((err) => {
      console.error(`[intake-ack-watchdog] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
        markCronRun("intake-ack-watchdog");
    });
  }, cadenceMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
