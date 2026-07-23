import { useEffect, useState } from "react";
import { Heading, Text } from "@fancyfleet/components";
import { apiGet } from "../api";

interface HealthSnapshotTask {
  ticket_id: string;
  title?: string;
  workflow?: string | null;
  delegate?: string | null;
  gate: string;
  health: string;
  failure_class?: string | null;
  remediation?: {
    action?: string | null;
    class?: string | null;
    status?: string | null;
  };
}

interface HealthSnapshot {
  generatedAt: string;
  status: "healthy" | "degraded" | "empty" | "pipeline-error";
  trackedTaskCount: number | null;
  pipeline?: {
    producing: boolean;
    source: string;
    error: string | null;
  };
  tasks: HealthSnapshotTask[];
}

export function ConnectorHealthPage() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<HealthSnapshot>("/health/snapshot")
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load health snapshot");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pipelineError = snapshot?.pipeline?.producing === false
    ? snapshot.pipeline.error ?? "Health pipeline is not producing"
    : error;

  if (!snapshot && !pipelineError) {
    return (
      <section className="page-stack">
        <Text className="muted">Loading snapshot</Text>
      </section>
    );
  }

  return (
    <section className="page-stack">
      <div>
        <Heading as="h2">Connector Health</Heading>
        <Text variant="small" className="muted">
          {snapshot?.generatedAt ? `Updated ${new Date(snapshot.generatedAt).toLocaleString()}` : "Loading snapshot"}
        </Text>
      </div>

      {pipelineError ? (
        <div className="surface-panel">
          <Heading as="h3">Pipeline not producing</Heading>
          <Text>{pipelineError}</Text>
        </div>
      ) : null}

      {!pipelineError && snapshot?.tasks.length === 0 ? (
        <div className="surface-panel">
          <Heading as="h3">No tracked tasks</Heading>
          <Text>No delegated connector tasks are currently tracked by the live health pipeline.</Text>
        </div>
      ) : null}

      {!pipelineError && snapshot?.tasks.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Gate</th>
                <th>Health</th>
                <th>Failure class</th>
                <th>Remediation</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.tasks.map((task) => (
                <tr key={`${task.ticket_id}-${task.gate}`}>
                  <td>
                    <strong>{task.ticket_id}</strong>
                    {task.title ? <Text variant="small">{task.title}</Text> : null}
                  </td>
                  <td>{task.gate}</td>
                  <td>{task.health}</td>
                  <td>{task.failure_class ?? "none"}</td>
                  <td>
                    {task.remediation?.action ?? "none"}
                    {task.remediation?.status ? <Text variant="small">{task.remediation.status}</Text> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
