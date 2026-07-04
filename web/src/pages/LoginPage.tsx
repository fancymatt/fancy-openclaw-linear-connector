import { useState, type FormEvent } from "react";
import { login } from "../api";

export function LoginPage({ onLoggedIn, secretConfigured }: { onLoggedIn: () => void; secretConfigured: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={submit}>
        <h1>Linear Connector</h1>
        <div className="muted">Management console. Sign in with the admin password.</div>
        {!secretConfigured && <div className="error-banner">ADMIN_SECRET is not configured on the connector.</div>}
        {error && <div className="error-banner">{error}</div>}
        <input
          type="password"
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          disabled={busy || !secretConfigured}
        />
        <button className="primary" type="submit" disabled={busy || !secretConfigured || password.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
