import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeSessionKey } from "../session-key.js";
import type { GatewayDispatchAck } from "./gateway-ack-types.js";
import { checkWrongTarget, type WrongTargetFlag } from "./wrong-target-detector.js";

export type DispatchRecordStatus = "pending" | "acknowledged" | "timed_out";

export interface DispatchRecord {
  dispatchId: string;
  agentId: string;
  ticketId: string;
  sessionKey: string;
  status: DispatchRecordStatus;
  createdAt: string;
  ackedAt?: string;
  ack: GatewayDispatchAck | null;
  wrongTarget?: WrongTargetFlag;
}

export interface DispatchRecordStoreConfig {
  probeCadenceMs?: number;
  ackTimeoutMs?: number;
}

export interface RecordDispatchInput {
  agentId: string;
  ticketId: string;
  sessionKey: string;
  delegateAtDispatch?: string;
}

type DispatchRecordRow = {
  dispatch_id: string;
  agent_id: string;
  ticket_id: string;
  session_key: string;
  status: string;
  created_at: string;
  acked_at: string | null;
  ack_json: string | null;
  wrong_target_json: string | null;
  delegate_at_dispatch: string | null;
};

export class DispatchRecordStore {
  private db: Database.Database;
  public readonly config: Required<DispatchRecordStoreConfig>;

  constructor(dbPath: string, config: DispatchRecordStoreConfig = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.config = {
      probeCadenceMs: config.probeCadenceMs ?? 30_000,
      ackTimeoutMs: config.ackTimeoutMs ?? 60_000,
    };
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS liveness_dispatch_records (
        dispatch_id          TEXT PRIMARY KEY,
        agent_id             TEXT NOT NULL,
        ticket_id            TEXT NOT NULL,
        session_key          TEXT NOT NULL,
        status               TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        acked_at             TEXT,
        ack_json             TEXT,
        wrong_target_json    TEXT,
        delegate_at_dispatch TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_liveness_dispatch_ticket
        ON liveness_dispatch_records(ticket_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_liveness_dispatch_status
        ON liveness_dispatch_records(status, created_at);
    `);
  }

  recordDispatch(input: RecordDispatchInput): DispatchRecord {
    const ticketId = normalizeSessionKey(input.ticketId);
    const sessionKey = normalizeSessionKey(input.sessionKey);
    const dispatchId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO liveness_dispatch_records
           (dispatch_id, agent_id, ticket_id, session_key, status, created_at, delegate_at_dispatch)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        dispatchId,
        input.agentId,
        ticketId,
        sessionKey,
        createdAt,
        input.delegateAtDispatch ?? input.agentId,
      );

    return {
      dispatchId,
      agentId: input.agentId,
      ticketId,
      sessionKey,
      status: "pending",
      createdAt,
      ack: null,
    };
  }

  recordAck(dispatchId: string, ack: GatewayDispatchAck): DispatchRecord {
    const existing = this.getDispatch(dispatchId);
    if (!existing) {
      throw new Error(`Unknown dispatchId: ${dispatchId}`);
    }

    const wrongTarget = checkWrongTarget({
      ackTarget: ack.target_identity,
      resolvedDelegate: existing.agentId,
      delegateAtDispatch: existing.agentId,
    });
    const ackedAt = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE liveness_dispatch_records
         SET status = 'acknowledged',
             acked_at = ?,
             ack_json = ?,
             wrong_target_json = ?
         WHERE dispatch_id = ?`,
      )
      .run(
        ackedAt,
        JSON.stringify(ack),
        wrongTarget.flagged ? JSON.stringify(wrongTarget) : null,
        dispatchId,
      );

    const updated = this.getDispatch(dispatchId);
    if (!updated) {
      throw new Error(`Failed to read updated dispatchId: ${dispatchId}`);
    }
    return updated;
  }

  getDispatch(dispatchIdOrTicketId: string): DispatchRecord | null {
    const byDispatchId = this.db
      .prepare(
        `SELECT dispatch_id, agent_id, ticket_id, session_key, status, created_at,
                acked_at, ack_json, wrong_target_json, delegate_at_dispatch
         FROM liveness_dispatch_records
         WHERE dispatch_id = ?`,
      )
      .get(dispatchIdOrTicketId) as DispatchRecordRow | undefined;
    if (byDispatchId) return this.rowToRecord(byDispatchId);

    let normalizedTicketId: string;
    try {
      normalizedTicketId = normalizeSessionKey(dispatchIdOrTicketId);
    } catch {
      return null;
    }

    const byTicket = this.db
      .prepare(
        `SELECT dispatch_id, agent_id, ticket_id, session_key, status, created_at,
                acked_at, ack_json, wrong_target_json, delegate_at_dispatch
         FROM liveness_dispatch_records
         WHERE ticket_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(normalizedTicketId) as DispatchRecordRow | undefined;
    return byTicket ? this.rowToRecord(byTicket) : null;
  }

  getDispatchesForTicket(ticketId: string): DispatchRecord[] {
    let normalizedTicketId: string;
    try {
      normalizedTicketId = normalizeSessionKey(ticketId);
    } catch {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT dispatch_id, agent_id, ticket_id, session_key, status, created_at,
                acked_at, ack_json, wrong_target_json, delegate_at_dispatch
         FROM liveness_dispatch_records
         WHERE ticket_id = ?
         ORDER BY created_at DESC`,
      )
      .all(normalizedTicketId) as DispatchRecordRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  getOverdueDispatches(timeoutMs: number): DispatchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT dispatch_id, agent_id, ticket_id, session_key, status, created_at,
                acked_at, ack_json, wrong_target_json, delegate_at_dispatch
         FROM liveness_dispatch_records
         WHERE status = 'pending'
           AND created_at <= ?
         ORDER BY created_at ASC`,
      )
      .all(new Date(Date.now() - timeoutMs).toISOString()) as DispatchRecordRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: DispatchRecordRow): DispatchRecord {
    return {
      dispatchId: row.dispatch_id,
      agentId: row.agent_id,
      ticketId: row.ticket_id,
      sessionKey: row.session_key,
      status: row.status as DispatchRecordStatus,
      createdAt: row.created_at,
      ackedAt: row.acked_at ?? undefined,
      ack: row.ack_json ? (JSON.parse(row.ack_json) as GatewayDispatchAck) : null,
      wrongTarget: row.wrong_target_json
        ? (JSON.parse(row.wrong_target_json) as WrongTargetFlag)
        : undefined,
    };
  }
}
