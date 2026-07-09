import { useState } from "react";

export interface WebhookRow {
  id: string;
  url: string;
  teamLabel: string;
  secretPreview: string;
  lastSeen: string | null;
}

export interface WebhookAddInput {
  url: string;
  secret: string;
  teamLabel: string;
}

interface WebhooksPageProps {
  webhooks: WebhookRow[];
  onAdd: (input: WebhookAddInput) => void;
  onDelete: (id: string) => void;
}

function formatLastSeen(lastSeen: string | null): string {
  if (!lastSeen) return "never";
  const d = new Date(lastSeen);
  return Number.isNaN(d.getTime()) ? lastSeen : d.toLocaleString();
}

/**
 * AI-1986 — self-service webhook management page. Pure/presentational: data
 * fetching and auth wiring live in App.tsx (behind the LoginGate), mirroring the
 * StallsPage convention. Client-side guards block the two easy-to-catch invalid
 * inputs (empty secret, non-HTTPS URL); the backend re-validates authoritatively.
 */
export function WebhooksPage({ webhooks, onAdd, onDelete }: WebhooksPageProps) {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [teamLabel, setTeamLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUrl = url.trim();
    const trimmedSecret = secret.trim();
    if (!trimmedSecret) {
      setError("A signing secret is required.");
      return;
    }
    let isHttps = false;
    try {
      isHttps = new URL(trimmedUrl).protocol === "https:";
    } catch {
      isHttps = false;
    }
    if (!isHttps) {
      setError("The webhook URL must be a valid HTTPS URL.");
      return;
    }
    setError(null);
    onAdd({ url: trimmedUrl, secret: trimmedSecret, teamLabel: teamLabel.trim() });
    setUrl("");
    setSecret("");
    setTeamLabel("");
  }

  function handleDelete(id: string, label: string) {
    if (window.confirm(`Remove the webhook for ${label}? This deletes its signing secret.`)) {
      onDelete(id);
    }
  }

  return (
    <div className="page-content">
      <form className="webhook-form" onSubmit={handleSubmit}>
        <div className="webhook-form-fields">
          <label>
            Webhook URL
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://linear-webhook.fancymatt.com/webhook"
            />
          </label>
          <label>
            Signing Secret
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="lin_wh_…"
            />
          </label>
          <label>
            Team Label
            <input
              type="text"
              value={teamLabel}
              onChange={(e) => setTeamLabel(e.target.value)}
              placeholder="(optional — defaults to extracted team)"
            />
          </label>
        </div>
        {error && <div className="webhook-form-error" role="alert">{error}</div>}
        <button type="submit">Add Webhook</button>
      </form>

      {webhooks.length === 0 ? (
        <div data-testid="webhooks-empty-state" className="empty-state">
          No webhooks registered yet — add one above to start receiving Linear events.
        </div>
      ) : (
        <table className="webhooks-table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Team</th>
              <th>Secret</th>
              <th>Last Seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {webhooks.map((wh) => (
              <tr key={wh.id} data-testid="webhook-row">
                <td>{wh.url}</td>
                <td>{wh.teamLabel}</td>
                <td><code>{wh.secretPreview}</code></td>
                <td>{formatLastSeen(wh.lastSeen)}</td>
                <td>
                  <button
                    type="button"
                    data-testid={`webhook-delete-${wh.id}`}
                    onClick={() => handleDelete(wh.id, wh.teamLabel || wh.url)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
