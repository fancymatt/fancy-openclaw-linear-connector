import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { fetchMe, logout, setUnauthorizedHandler } from "./api";
import { Tabs } from "./components";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { FleetPage } from "./pages/FleetPage";
import { TasksPage } from "./pages/TasksPage";
import { EventsPage } from "./pages/EventsPage";
import { AlertsPage } from "./pages/AlertsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { DeadLettersPage } from "./pages/DeadLettersPage";

type AuthState = "checking" | "authenticated" | "anonymous";

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
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/dead-letters" element={<DeadLettersPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
