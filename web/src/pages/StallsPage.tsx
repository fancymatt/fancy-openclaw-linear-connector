import { usePoll } from "../hooks";
import { apiGet } from "../api";

export interface EnrichedStallEntry {
  ticket: string;
  agent: string;
  state: string | null;
  delegate: string | null;
  age_seconds: number | null;
  threshold_ms: number | null;
  last_comment_at: string | null;
  classification: string;
  classificationName: string;
}

interface StallsResponse {
  entries: EnrichedStallEntry[];
}

interface StallsPageProps {
  entries?: EnrichedStallEntry[];
}

function formatSeconds(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
}

function formatMs(ms: number): string {
  return formatSeconds(ms / 1000);
}

export function StallsPage({ entries: propEntries }: StallsPageProps) {
  const live = usePoll(() => apiGet<StallsResponse>("/admin/api/stale-digest"), 15000);
  const entries = propEntries ?? live.data?.entries ?? [];

  if (entries.length === 0) {
    return (
      <div className="page-content">
        <div data-testid="stalls-empty-state" className="empty-state">
          No stalled tickets — all workflows within SLA.
        </div>
      </div>
    );
  }

  return (
    <div className="page-content">
      <table className="stalls-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>State</th>
            <th>Delegate</th>
            <th>Age</th>
            <th>Threshold</th>
            <th>Classification</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.ticket} data-testid="stall-row">
              <td>
                <a href={`/board?ticket=${entry.ticket}`}>{entry.ticket}</a>
                {" "}
                <a
                  href={`https://linear.app/fancymatt/issue/${entry.ticket}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ↗
                </a>
              </td>
              <td>{entry.state ?? "—"}</td>
              <td>{entry.delegate ?? "—"}</td>
              <td>{entry.age_seconds != null ? formatSeconds(entry.age_seconds) : "—"}</td>
              <td>{entry.threshold_ms != null ? formatMs(entry.threshold_ms) : "—"}</td>
              <td>{entry.classificationName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
