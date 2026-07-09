import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { fetchMe, logout, setUnauthorizedHandler } from "./api";
import { Tabs } from "./components";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { FleetPage } from "./pages/FleetPage";
import { BoardPage } from "./pages/BoardPage";
import { TasksPage } from "./pages/TasksPage";
import { EventsPage } from "./pages/EventsPage";
import { AlertsPage } from "./pages/AlertsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { DeadLettersPage } from "./pages/DeadLettersPage";
import { StallsPage } from "./pages/StallsPage";
import { TicketDetailView } from "./pages/TicketDetailView";
import { WebhooksPage, type WebhookRow, type WebhookAddInput } from "./pages/WebhooksPage";
import { apiGet, apiPost, apiDelete } from "./api";

type AuthState = "checking" | "authenticated" | "anonymous";

/** Reads :ticketId from the route and renders the ticket-detail view (with ops actions). */
function TicketDetailRoute() {
  const { ticketId } = useParams<{ ticketId: string }>();
  return <TicketDetailView ticketId={ticketId} />;
}

/**
 * AI-1986 — data + auth wiring for the pure WebhooksPage. Fetches the list from
 * the admin API and threads add/delete mutations back through it, refetching on
 * success so the new/removed row reflects immediately.
 */
function WebhooksRoute() {
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ webhooks: WebhookRow[] }>("/admin/api/webhooks");
      setWebhooks(res.webhooks);
    } catch {
      setWebhooks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = useCallback(
    async (input: WebhookAddInput) => {
      try {
        await apiPost("/admin/api/webhooks", input);
        await load();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Failed to add webhook.");
      }
    },
    [load],
  );

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await apiDelete(`/admin/api/webhooks/${encodeURIComponent(id)}`);
        await load();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Failed to remove webhook.");
      }
    },
    [load],
  );

  return <WebhooksPage webhooks={webhooks} onAdd={(i) => void onAdd(i)} onDelete={(id) => void onDelete(id)} />;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [secretConfigured, setSecretConfigured] = useState(true);

  const check = useCallback(async () => {
    try {
      const me = await fetchMe();
      setSecretConfigured(me.secretConfigured);
      setAuth(me.authenticated ? "authenticated" : "anonymous");
    } catch {
      setAuth("anonymous");
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth("anonymous"));
    void check();
  }, [check]);

  if (auth === "checking") {
    return <div className="login-screen"><div className="muted">Connecting…</div></div>;
  }

  if (auth === "anonymous") {
    return <LoginPage secretConfigured={secretConfigured} onLoggedIn={() => setAuth("authenticated")} />;
  }

  return (
    <BrowserRouter basename="/admin">
      <div className="wrap">
        <div className="topbar">
          <div>
            <h1>Linear Connector Console</h1>
            <div className="sub">Workflow engine · fleet routing · operational health</div>
          </div>
          <button
            onClick={() => {
              void logout().finally(() => setAuth("anonymous"));
            }}
          >
            Sign out
          </button>
        </div>
        <Tabs />
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/fleet" element={<FleetPage />} />
          <Route path="/ticket/:ticketId" element={<TicketDetailRoute />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/dead-letters" element={<DeadLettersPage />} />
          <Route path="/stalls" element={<StallsPage />} />
          <Route path="/webhooks" element={<WebhooksRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
