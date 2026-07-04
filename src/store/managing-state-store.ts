import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite-backed bookkeeping for Managing-state stewardship wakes.
 *
 * For each (agent, ticket) pair in the Managing state, tracks when the agent
 * was last woken to review it. The ManagingPoller uses this to decide whether
 * the next wake is due, given the ticket's configured interval.
 *
 * This is purely operational state. Wiping it causes a one-time burst of
 * stewardship wakes (everything looks "never dispatched"), which is recoverable.
 */
export interface ManagingEntry {
  agentId: string;
  ticketId: string;
  lastDispatchedAt: number | null;
}

export class ManagingStateStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "managing-state.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS managing_state (
        agent_id           TEXT NOT NULL,
        ticket_id          TEXT NOT NULL,
        last_dispatched_at INTEGER,
        PRIMARY KEY (agent_id, ticket_id)
      );
      CREATE INDEX IF NOT EXISTS idx_managing_state_agent
        ON managing_state (agent_id);
    `);
  }

  /** Read the last-dispatched timestamp for one (agent, ticket). null if never dispatched. */
  getLastDispatched(agentId: string, ticketId: string): number | null {
    const row = this.db
      .prepare("SELECT last_dispatched_at FROM managing_state WHERE agent_id = ? AND ticket_id = ?")
      .get(agentId, ticketId) as { last_dispatched_at: number | null } | undefined;
    if (!row) return null;
    return row.last_dispatched_at;
  }

  /** Record a stewardship wake dispatch for a (agent, ticket) at the given epoch ms. */
  recordDispatch(agentId: string, ticketId: string, atMs: number): void {
    this.db
      .prepare(
        `INSERT INTO managing_state (agent_id, ticket_id, last_dispatched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id, ticket_id) DO UPDATE SET last_dispatched_at = excluded.last_dispatched_at`,
      )
      .run(agentId, ticketId, atMs);
  }

  /** Ensure a (agent, ticket) row exists. Leaves last_dispatched_at as null when freshly inserted. */
  ensure(agentId: string, ticketId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO managing_state (agent_id, ticket_id, last_dispatched_at)
         VALUES (?, ?, NULL)`,
      )
      .run(agentId, ticketId);
  }

  /** Remove the row when a ticket leaves Managing or is no longer delegated to the agent. */
  remove(agentId: string, ticketId: string): void {
    this.db
      .prepare("DELETE FROM managing_state WHERE agent_id = ? AND ticket_id = ?")
      .run(agentId, ticketId);
  }

  /** Drop entries that aren't in the current set of (agent, ticket) pairs returned from Linear. */
  pruneAgent(agentId: string, currentTicketIds: string[]): number {
    if (currentTicketIds.length === 0) {
      const r = this.db.prepare("DELETE FROM managing_state WHERE agent_id = ?").run(agentId);
      return r.changes;
    }
    const placeholders = currentTicketIds.map(() => "?").join(",");
    const params = [agentId, ...currentTicketIds];
    const r = this.db
      .prepare(`DELETE FROM managing_state WHERE agent_id = ? AND ticket_id NOT IN (${placeholders})`)
      .run(...params);
    return r.changes;
  }

  /** All rows for an agent. Useful for diagnostics. */
  listByAgent(agentId: string): ManagingEntry[] {
    const rows = this.db
      .prepare("SELECT agent_id, ticket_id, last_dispatched_at FROM managing_state WHERE agent_id = ?")
      .all(agentId) as Array<{ agent_id: string; ticket_id: string; last_dispatched_at: number | null }>;
    return rows.map((r) => ({
      agentId: r.agent_id,
      ticketId: r.ticket_id,
      lastDispatchedAt: r.last_dispatched_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
