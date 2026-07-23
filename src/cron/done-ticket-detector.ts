/**
 * AI-2468 — Done-ticket unshipped detector.
 *
 * AC2: A periodic cron that scans Done tickets whose fix hallmark symbol is absent
 *      from origin/main (code-presence check, not SHA ancestry). Advisory only —
 *      must never block a transition.
 *
 * AC3: Backfill report enumerating current violations across open Done tickets
 *      using the same code-presence method.
 *
 * Registration follows the rescue-sweep precedent: registerDoneTicketDetectorCron
 * registers in the cron registry and /health enumerates the entry.
 *
 * The hallmark symbol is a named export or function that the ticket's fix introduces.
 * Detection: `git grep <symbol> <ref> --` — a squash-merge-safe check that
 * verifies the code is present in the tree, not that a particular commit is an ancestor.
 * Uses `origin/main` when it exists (production clones), falling back to `HEAD`
 * for local/test repos with no remote.
 */

import { execFileSync } from "node:child_process";
import { createLogger, componentLogger } from "../logger.js";
import { registerCron, formatIntervalMs, markCronRun } from "./registry.js";
import {
  recordDetectorRun,
  recordDetectorSkip,
  recordDetectorFail,
} from "../done-ticket-detector-state.js";

// ── Constants ──────────────────────────────────────────────────────────────

const LINEAR_API_URL = "https://api.linear.app/graphql";
const HALLMARK_LABEL_PREFIX = "hallmark:";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "done-ticket-detector");

// ── Types ──────────────────────────────────────────────────────────────────

export interface DoneTicketScanResult {
  identifier: string;
  title: string;
  /** The hallmark symbol (exported function/constant) that the fix introduces. */
  hallmarkSymbol: string;
  /** Optional branch name associated with the ticket (for diagnostics). */
  branchName: string | null;
  /** Labels on the ticket. */
  labels: string[];
}

export interface DoneTicketViolation {
  identifier: string;
  title: string;
  hallmarkSymbol: string;
  /** True when the symbol is absent from `origin/main`. */
  absentFromMain: boolean;
  /** True when the symbol is absent from the deployed /health commit (if available). */
  absentFromHealthCommit: boolean;
  /** Optional branch name for diagnostics. */
  branchName: string | null;
}

export interface DoneTicketScanConfig {
  /** Linear API auth token (Bearer). */
  authToken: string;
  /** Path to the git repo to check (e.g. the connector clone). */
  repoDir: string;
  /** Linear API URL. */
  linearApiUrl?: string;
  /** Optional SHA of the deployed /health commit — checked in addition to main. */
  healthCommitSha?: string;
  /** Filter by team ID (optional — defaults to all teams). */
  teamId?: string;
}

export interface DoneTicketScanResultSet {
  /** Number of Done tickets scanned. */
  scanned: number;
  /** Tickets whose hallmark is absent from main (violations). */
  violations: DoneTicketViolation[];
  /** Errors encountered during the scan (non-fatal). */
  errors: string[];
  /** ISO timestamp of the scan. */
  timestamp: string;
}

export type BackfillReport = DoneTicketScanResultSet;

// ── Default interval ───────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Parse a duration string like "1h", "30m", "3600s" or raw milliseconds. */
function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return DEFAULT_INTERVAL_MS;
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    case "d":  return n * 86_400_000;
    default:   return DEFAULT_INTERVAL_MS;
  }
}

// ── Core scanning logic ────────────────────────────────────────────────────

/**
 * Extract the hallmark symbol from a ticket's labels.
 * Looks for a label matching `hallmark:<symbol>` and returns the symbol portion.
 * Returns null if no hallmark label is found.
 */
function extractHallmarkSymbol(labels: string[]): string | null {
  for (const label of labels) {
    if (label.startsWith(HALLMARK_LABEL_PREFIX)) {
      return label.slice(HALLMARK_LABEL_PREFIX.length);
    }
  }
  return null;
}

/**
 * Resolve the ref to check for code presence — production clones use
 * `origin/main` (canonical shipped state); test repos with no remote fall
 * back to the current `HEAD` (typically the default branch).
 */
function resolveShippedRef(repoDir: string): string {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "-q", "origin/main"],
      { cwd: repoDir, stdio: "pipe", timeout: 5_000 },
    );
    return "origin/main";
  } catch {
    return "HEAD";
  }
}

/**
 * Check if a hallmark symbol exists in the shipped repo tree via `git grep`.
 * Checks `origin/main` when it exists (production clones), falling back to
 * `HEAD` for local/test repos with no remote.
 *
 * The definitive check is code presence (git grep), not SHA ancestry —
 * squash-merge rewrites commits, so ancestry checks produce false positives.
 */
function symbolExistsOnMain(symbol: string, repoDir: string): boolean {
  const ref = resolveShippedRef(repoDir);
  try {
    execFileSync(
      "git",
      ["grep", "-q", "--fixed-strings", "--", symbol, ref],
      { cwd: repoDir, stdio: "pipe", timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a hallmark symbol exists at a specific commit.
 */
function symbolExistsAtCommit(symbol: string, commit: string, repoDir: string): boolean {
  try {
    execFileSync(
      "git",
      ["grep", "-q", "--fixed-strings", "--", symbol, commit],
      { cwd: repoDir, stdio: "pipe", timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Query Linear for Done tickets with wf:* labels (code-touching tickets in Done state).
 */
async function queryDoneTickets(
  authToken: string,
  linearApiUrl: string,
): Promise<Array<{ identifier: string; title: string; branchName: string | null; labels: string[] }>> {
  const graphqlQuery = `
    query {
      issues(filter: {
        labels: { some: { name: { startsWith: "wf:" } } }
        state: { name: { eq: "Done" } }
      }) {
        nodes {
          identifier
          title
          branchName
          labels {
            nodes {
              name
            }
          }
        }
      }
    }
  `;

  const res = await fetch(linearApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authToken,
    },
    body: JSON.stringify({ query: graphqlQuery }),
  });

  type LinearResp = {
    data?: {
      issues?: {
        nodes?: Array<{
          identifier: string;
          title: string;
          branchName: string | null;
          labels?: { nodes?: Array<{ name: string }> };
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  const json = (await res.json()) as LinearResp;

  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear API error: ${messages}`);
  }

  const nodes = json.data?.issues?.nodes ?? [];
  return nodes.map((node) => ({
    identifier: node.identifier,
    title: node.title,
    branchName: node.branchName ?? null,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
  }));
}

/**
 * Scan Done tickets and check if their hallmark symbols are present in the repo tree.
 * The definitive check is code presence (git grep), not SHA ancestry — squash-merge
 * rewrites commits, so ancestry checks produce false positives.
 *
 * Workflow:
 * 1. Query Linear for Done tickets with wf:* labels
 * 2. Extract hallmark symbol from each ticket's labels (hallmark:<symbol> label)
 * 3. Run git grep <symbol> on origin/main for each ticket
 * 4. If no hallmark label, skip the git check but still count as scanned
 */
export async function scanDoneTickets(
  config: DoneTicketScanConfig,
): Promise<DoneTicketScanResultSet> {
  const timestamp = new Date().toISOString();
  const errors: string[] = [];
  const violations: DoneTicketViolation[] = [];

  const linearApiUrl = config.linearApiUrl ?? LINEAR_API_URL;

  let tickets: Array<{ identifier: string; title: string; branchName: string | null; labels: string[] }>;
  try {
    tickets = await queryDoneTickets(config.authToken, linearApiUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    log.error(`[done-ticket-detector] Linear query failed: ${msg}`);
    return { scanned: 0, violations, errors, timestamp };
  }

  for (const ticket of tickets) {
    const hallmarkSymbol = extractHallmarkSymbol(ticket.labels);

    let absentFromMain = false;
    let absentFromHealthCommit = false;

    if (hallmarkSymbol) {
      try {
        absentFromMain = !symbolExistsOnMain(hallmarkSymbol, config.repoDir);

        // Also check against the deployed health commit if provided
        if (config.healthCommitSha) {
          absentFromHealthCommit = !symbolExistsAtCommit(
            hallmarkSymbol,
            config.healthCommitSha,
            config.repoDir,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${ticket.identifier}: git grep failed: ${msg}`);
        absentFromMain = true;
      }

      if (absentFromMain || absentFromHealthCommit) {
        violations.push({
          identifier: ticket.identifier,
          title: ticket.title,
          hallmarkSymbol,
          absentFromMain,
          absentFromHealthCommit,
          branchName: ticket.branchName,
        });
      }
    }
    // Ticket without hallmark label is still counted as scanned but no grep check
  }

  return {
    scanned: tickets.length,
    violations,
    errors,
    timestamp,
  };
}

/**
 * Run one scan iteration: resolve auth token, query Linear, check each ticket's
 * hallmark symbol via git grep, record state.
 */
async function runScanIteration(): Promise<void> {
  try {
    const authToken =
      process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
    if (!authToken) {
      const reason = "No LINEAR_OAUTH_TOKEN or LINEAR_API_KEY configured";
      log.warn(`[done-ticket-detector] ${reason} — skipping`);
      recordDetectorSkip(reason);
      return;
    }

    const repoDir = process.env.CONNECTOR_REPO_DIR ?? process.cwd();
    const result = await scanDoneTickets({
      authToken,
      repoDir,
    });
    recordDetectorRun({
      scanned: result.scanned,
      violations: result.violations.length,
      errors: result.errors.length,
    });
    if (result.violations.length > 0) {
      const ids = result.violations.map((v) => v.identifier).join(", ");
      log.warn(
        `[done-ticket-detector] Found ${result.violations.length} unshipped Done ticket(s): ${ids}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[done-ticket-detector] Scan failed: ${msg}`);
    recordDetectorFail(msg);
  } finally {
    markCronRun("done-ticket-detector");
  }
}

/**
 * Register the Done-ticket detector as an in-process recurring job.
 * Interval is controlled by DONE_DETECTOR_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 *
 * A first run fires shortly after registration (also unref'd).
 */
export function registerDoneTicketDetectorCron(): void {
  const intervalMs = parseIntervalMs(
    process.env.DONE_DETECTOR_INTERVAL ?? `${DEFAULT_INTERVAL_MS}`,
  );
  registerCron("done-ticket-detector", `every ${formatIntervalMs(intervalMs)}`);

  const firstRunTimer = setTimeout(() => {
    void runScanIteration();
  }, 0);
  firstRunTimer.unref();

  const timer = setInterval(() => {
    void runScanIteration();
  }, intervalMs);
  timer.unref();

  log.info(
    `[done-ticket-detector] Scheduled every ${intervalMs}ms (DONE_DETECTOR_INTERVAL=${process.env.DONE_DETECTOR_INTERVAL ?? "1h"})` +
      " — first run queued immediately",
  );
}
