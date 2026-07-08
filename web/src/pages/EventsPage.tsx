import { useState } from "react";
import { apiGet } from "../api";
import { usePoll, ageLabel } from "../hooks";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { Card, Chip, Diagnostics, Empty, ErrorBanner } from "../components";
import type { OperationalEvent } from "../types";

function outcomeTone(outcome: string): string {
  if (/fail|error|exhausted|no-route|unreachable|escalat/.test(outcome)) return "red";
  if (/warn|resignal|redispatch|unconfirmed|stale/.test(outcome)) return "yellow";
  if (/delivered|accepted|acknowledged|success|engagement/.test(outcome)) return "green";
  return "gray";
}

export function EventsPage() {
  const [agent, setAgent] = useState("");
  const [key, setKey] = useState("");
  const [agentInput, setAgentInput] = useState("");
  const [keyInput, setKeyInput] = useState("");

  const query = new URLSearchParams({ limit: "100" });
  if (agent) query.set("agent", agent);
  if (key) query.set("key", key);

  const events = usePoll(
    () => apiGet<{ events: OperationalEvent[] }>(`/admin/api/events?${query.toString()}`),
    6000,
  );
  useLiveRefresh({ onEvents: events.refresh });

  return (
    <>
      <ErrorBanner message={events.error} />
      <div className="grid">
        <Card span={12} title="Dispatch stream">
          <div className="filters">
            <label>agent</label>
            <input type="text" value={agentInput} placeholder="e.g. igor" onChange={(e) => setAgentInput(e.target.value)} />
            <label>ticket key</label>
            <input type="text" value={keyInput} placeholder="e.g. linear-AI-1768" onChange={(e) => setKeyInput(e.target.value)} />
            <button className="primary" onClick={() => { setAgent(agentInput.trim()); setKey(keyInput.trim()); }}>Apply</button>
            <button onClick={() => { setAgent(""); setKey(""); setAgentInput(""); setKeyInput(""); }}>Clear</button>
            <span className="muted">{events.data?.events.length ?? 0} event(s) · refreshes every 6s</span>
          </div>
          {events.data?.events.length ? (
            <table>
              <thead>
                <tr><th>When</th><th>Outcome</th><th>Agent</th><th>Key</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {events.data.events.map((event, i) => (
                  <tr key={event.id ?? i}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{ageLabel(event.occurredAt)}</td>
                    <td><Chip tone={outcomeTone(event.outcome)}>{event.outcome}</Chip></td>
                    <td>{event.agent ?? "—"}</td>
                    <td className="mono">{event.key ?? "—"}</td>
                    <td>
                      {event.errorSummary && <div className="muted">{event.errorSummary}</div>}
                      <Diagnostics value={event} label="raw" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No operational events match this filter.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
