/**
 * DoneTicketDetector — cron-based detector for Done dev-impl tickets
 * whose fix hasn't landed on main.
 *
 * STUB: Tests are written against this interface. Implementation is pending.
 */

import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(), "done-ticket-detector");

// ── Types ──────────────────────────────────────────────────────────────────

export interface DoneTicketDetectorConfig {
  lookbackDays: number;
  graceHours: number;
  pollIntervalMs: number;
  repoPath: string;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  userId?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  createdAt: string;
  teamKey?: string;
  labels: string[];
  branchName?: string | null;
  hasBranch?: boolean;
  doneAt?: string | null;
  comments?: LinearComment[];
}

export interface LinearCreateIssueInput {
  teamId: string;
  title: string;
  description: string;
  labels?: string[];
  parentId?: string;
}

export interface LinearApi {
  fetchDoneTickets(lookbackDays: number): Promise<LinearIssue[]>;
  applyLabel(issueId: string, label: string): Promise<boolean>;
  postComment(issueId: string, body: string): Promise<boolean>;
  createIssue(input: LinearCreateIssueInput): Promise<{ id: string; identifier: string } | null>;
  hasExistingComment(issueId: string, bodyPrefix: string): Promise<boolean>;
}

export interface GitApi {
  ticketIdInMainLog(ticketId: string, afterDate: Date): Promise<boolean>;
  hasBranchForTicket(ticketId: string): Promise<boolean>;
}

export interface DoneTicketDetectorDeps {
  linear: LinearApi;
  git: GitApi;
  config: DoneTicketDetectorConfig;
}

export interface DoneTicketCycleResult {
  scanned: number;
  flagged: number;
  skippedLabeled: number;
  skippedUnbranched: number;
  reLandCreated: number;
  errors: string[];
}

// ── Detector ───────────────────────────────────────────────────────────────

export class DoneTicketDetector {
  private deps: DoneTicketDetectorDeps;
  private timer?: ReturnType<typeof setInterval>;
  private commentedTickets: Set<string> = new Set();

  constructor(deps: DoneTicketDetectorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    const { config } = this.deps;
    log.info(
      `Done ticket detector started — lookbackDays=${config.lookbackDays} ` +
      `graceHours=${config.graceHours} pollInterval=${config.pollIntervalMs}ms ` +
      `repoPath=${config.repoPath}`,
    );
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        log.error(
          `Done ticket detector cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, config.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one detection cycle.
   * STUB: Not yet implemented.
   */
  async runCycle(): Promise<DoneTicketCycleResult> {
    // TODO: implement — see spec at
    // https://linear.app/fancymatt/issue/AI-2576
    return {
      scanned: 0,
      flagged: 0,
      skippedLabeled: 0,
      skippedUnbranched: 0,
      reLandCreated: 0,
      errors: [],
    };
  }
}
