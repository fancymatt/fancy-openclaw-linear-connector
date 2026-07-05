import { useState } from "react";
import { apiGet } from "../api";
import { usePoll, ageLabel } from "../hooks";
import { Card, Chip, Diagnostics, Empty, ErrorBanner } from "../components";

interface DeadLetterItem {
  id: number;
  firstAt: string;
  lastAt: string;
  kind: string;
  title: string;
  agent: string | null;
  ticket: string | null;
  dedupCount: number;
  detail: unknown;
}

const KINDS = ["all", "dispatch", "routing"] as const;

export function DeadLettersPage() {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  const query = new URLSearchParams({ limit: "100" });
  if (kind !== "all") query.set("kind", kind);

  const result = usePoll(
    () => apiGet<{ items: DeadLetterItem[] }>(`/admin/api/dead-letters?${query.toString()}`),
    15000,
  );

  return (
    <>
      <ErrorBanner message={result.error} />
      <div className="grid">
        <Card span={12} title="Dead letters — failed dispatch &amp; routing events">
          <div className="filters">
            {KINDS.map((k) => (
              <button key={k} className={kind === k ? "primary" : ""} onClick={() => setKind(k)}>
                {k}
              </button>
            ))}
            <span className="muted">
              {result.data?.items.length ?? 0} row(s) · dispatch-exhausted, no-route, delegate-unreachable
            </span>
          </div>
          {result.data?.items.length ? (
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Event</th>
                  <th>Scope</th>
                  <th>Last seen</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Chip tone={item.kind === "dispatch" ? "red" : "yellow"}>{item.kind}</Chip>
                    </td>
                    <td>
                      <div className="row-title">{item.title}</div>
                      {item.detail != null && <Diagnostics value={item.detail} label="detail" />}
                    </td>
                    <td className="muted">
                      {item.agent && <div>agent: {item.agent}</div>}
                      {item.ticket && <div className="mono">{item.ticket}</div>}
                      {!item.agent && !item.ticket && "—"}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {ageLabel(item.lastAt)}
                      {item.dedupCount > 1 && <div>first {ageLabel(item.firstAt)}</div>}
                    </td>
                    <td className="muted">
                      {item.dedupCount > 1 ? (
                        <Chip tone="yellow">×{item.dedupCount}</Chip>
                      ) : (
                        <Chip tone="gray">×1</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No dead-letter events. Failed dispatches and routing errors will appear here.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
