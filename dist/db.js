import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "events.db");
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    agent_target TEXT,
    payload_json TEXT,
    routed INTEGER DEFAULT 0,
    routing_result TEXT,
    created_at TEXT DEFAULT current_timestamp
  )
`);
const insertEventStatement = db.prepare(`
  INSERT INTO webhook_events (event_type, agent_target, payload_json)
  VALUES (?, ?, ?)
`);
const markRoutedStatement = db.prepare(`
  UPDATE webhook_events
  SET routed = 1, routing_result = ?
  WHERE id = ?
`);
export function insertEvent(eventType, agentTarget, payloadJson) {
    const result = insertEventStatement.run(eventType, agentTarget, payloadJson);
    return Number(result.lastInsertRowid);
}
export function markRouted(id, result) {
    markRoutedStatement.run(result, id);
}
const getUnroutedStatement = db.prepare(`
  SELECT id, event_type, agent_target, payload_json
  FROM webhook_events
  WHERE routed = 0 AND agent_target IS NOT NULL
  ORDER BY created_at ASC
`);
export function getUnroutedEvents() {
    return getUnroutedStatement.all();
}
//# sourceMappingURL=db.js.map