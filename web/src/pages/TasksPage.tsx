import { useState } from "react";
import { apiGet } from "../api";
import { usePoll, ageLabel } from "../hooks";
import { Card, Chip, Diagnostics, Empty, ErrorBanner } from "../components";
import type { DashboardResponse } from "../types";

const FILTERS = ["all", "active", "pending", "queued", "failed"] as const;

export function TasksPage() {
  const dashboard = usePoll(() => apiGet<DashboardResponse>("/admin/api/dashboard"), 8000);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");

  const tasks = (dashboard.data?.tasks ?? []).filter((t) => filter === "all" || t.state === filter);

  return (
    <>
      <ErrorBanner message={dashboard.error} />
      <div className="grid">
        <Card span={12} title="Work in motion">
          <div className="filters">
            {FILTERS.map((f) => (
              <button key={f} className={filter === f ? "primary" : ""} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
            <span className="muted">{tasks.length} item(s)</span>
          </div>
          {tasks.length ? (
            <table>
              <thead>
                <tr><th>Task</th><th>Owner</th><th>State</th><th>Lifecycle</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {tasks.map((task, i) => (
                  <tr key={`${task.sessionKey}-${i}`}>
                    <td>
                      <div className="row-title">{task.relatedUrl ? <a href={task.relatedUrl}>{task.related}</a> : task.related}</div>
                      <div className="muted mono">{task.eventType} · {task.sessionKey} · {task.age}</div>
                      <Diagnostics value={task.diagnostics} />
                    </td>
                    <td>{task.owner}</td>
                    <td>
                      <Chip tone={task.severity}>{task.state}</Chip>
                      {task.safeError && <div className="muted">{task.safeError}</div>}
                    </td>
                    <td className="muted">{task.lifecycle}</td>
                    <td className="muted">{ageLabel(task.updated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No work in this state.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
