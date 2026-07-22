/**
 * DoneTicketDetector — cron-based detector for Done dev-impl tickets
 * whose fix hasn't landed on main.
 *
 * STUB: Tests are written against this interface. Implementation is pending.
 */

import { createLogger, componentLogger } from "../logger.js";
import { markCronRun } from "../cron/registry.js";

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
      }).finally(() => {
        markCronRun("done-ticket-detector");
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
   *
   * 1. Fetch Done tickets from the last N days
   * 2. For each ticket: skip if already flagged, skip if no branch
   * 3. Check if the ticket ID appears in git log origin/main --oneline
   * 4. If absent: apply needs-merge-verify label, post comment, create re-land
   *
   * Advisory only — all errors are caught and recorded, never thrown.
   */
  async runCycle(): Promise<DoneTicketCycleResult> {
    const result: DoneTicketCycleResult = {
      scanned: 0,
      flagged: 0,
      skippedLabeled: 0,
      skippedUnbranched: 0,
      reLandCreated: 0,
      errors: [],
    };

    let tickets: LinearIssue[];
    try {
      tickets = await this.deps.linear.fetchDoneTickets(this.deps.config.lookbackDays);
    } catch (err) {
      result.errors.push(
        `fetchDoneTickets failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    result.scanned = tickets.length;

    for (const ticket of tickets) {
      try {
        await this.processTicket(ticket, result);
      } catch (err) {
        result.errors.push(
          `Error processing ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }

  /**
   * Process a single Done ticket.
   * Returns true if a flag was raised (newly flagged), false otherwise.
   */
  private async processTicket(
    ticket: LinearIssue,
    result: DoneTicketCycleResult,
  ): Promise<boolean> {
    // AC4: Skip if already has needs-merge-verify label
    if (ticket.labels.includes("needs-merge-verify")) {
      result.skippedLabeled++;
      return false;
    }

    // AC5: Skip if no branch (can't determine code presence)
    if (ticket.hasBranch === false) {
      result.skippedUnbranched++;
      return false;
    }

    // AC7: Simple string-match ticketId in git log — no ancestry matching
    const doneDate = ticket.doneAt ? new Date(ticket.doneAt) : new Date(ticket.createdAt);
    const found = await this.deps.git.ticketIdInMainLog(ticket.identifier, doneDate);

    if (found) {
      // Ticket is present in main — no action needed
      return false;
    }

    // AC9: Check if we've already commented on this ticket (in-memory set)
    if (this.commentedTickets.has(ticket.id)) {
      return false;
    }

    // AC3: Apply label and post comment
    await this.deps.linear.applyLabel(ticket.id, "needs-merge-verify");

    const commentBody = this.buildFlagComment(ticket.identifier, doneDate);
    await this.deps.linear.postComment(ticket.id, commentBody);
    this.commentedTickets.add(ticket.id);

    result.flagged++;

    // AC6: Create re-land ticket
    try {
      const reLand = await this.deps.linear.createIssue({
        teamId: ticket.teamKey ?? "",
        title: `re-land: ${ticket.identifier} — ${ticket.identifier}`,
        description: `Re-land fix for ${ticket.identifier} that was marked Done but not found on main.\n\nOriginal ticket: ${ticket.identifier}`,
        parentId: ticket.id,
      });

      if (reLand) {
        result.reLandCreated++;
      }
    } catch {
      // AC8: Re-land creation failure is advisory — don't fail the cycle
      // Flag was still applied, just note the error
    }

    return true;
  }

  /**
   * Build the flagging comment body.
   * Includes the ticket identifier and Done timestamp.
   */
  private buildFlagComment(identifier: string, doneAt: Date): string {
    return (
      `## Done but not on main\n\n` +
      `**${identifier}** was marked Done at ${doneAt.toISOString()} but its fix ` +
      `was not found in \`origin/main\` commit history. A re-land ticket has ` +
      `been created to track re-applying this fix.\n\n` +
      `_This is an automated advisory from the Done-ticket detector._`
    );
  }
}
