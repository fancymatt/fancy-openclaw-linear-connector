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
import { ProposalsPage, isPendingQueue, type Proposal, type ProposalDiff } from "./pages/ProposalsPage";
import { apiGet, apiPost, apiDelete } from "./api";

type AuthState = "checking" | "authenticated" | "anonymous";

/**
 * AI-2040 — the C3 proposal record (AI-2038) as it arrives on the wire. Two fields
 * are looser than the view model, and the adapter below closes both gaps:
 *
 *  - `diff` is a single patch string with no surface discriminator, but AC5.3 needs
 *    to pick a renderer per surface (and stack two blocks when a proposal touches
 *    both). We recover the path from the patch's own `+++ b/<path>` header and key
 *    the renderer off its extension. A proposal that touches guidance *and* YAML
 *    still cannot be represented this way — C3 owes us `diffs[]`; until then it
 *    renders as whichever surface the header names.
 *  - `confidenceScore` is specified in [0,1] while the brief displays "N / 100".
 *    A value above 1 is read as already-percentage rather than silently shown as
 *    8700 / 100.
 */
interface WireProposal extends Omit<Partial<Proposal>, "diffs"> {
  id: string;
  diffs?: ProposalDiff[];
  diff?: string;
}

const PATCH_TARGET = /^\+\+\+ b\/(.+)$/m;

function diffsFromWire(raw: WireProposal): ProposalDiff[] {
  if (Array.isArray(raw.diffs)) return raw.diffs;
  if (typeof raw.diff !== "string" || raw.diff.trim() === "") return [];
  const path = PATCH_TARGET.exec(raw.diff)?.[1] ?? "(unknown path)";
  return [{ kind: /\.ya?ml$/.test(path) ? "yaml" : "guidance", path, patch: raw.diff }];
}

function toProposal(raw: WireProposal): Proposal {
  const confidence = raw.confidenceScore ?? 0;
  return {
    id: raw.id,
    title: raw.title ?? "(untitled proposal)",
    workflowId: raw.workflowId ?? "",
    stateId: raw.stateId ?? "",
    status: raw.status ?? "pending",
    severity: raw.severity ?? "LOW",
    confidenceScore: confidence > 1 ? confidence / 100 : confidence,
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    diffStat: raw.diffStat ?? { added: 0, removed: 0 },
    diffs: diffsFromWire(raw),
    evidence: raw.evidence ?? [],
    failureCount: raw.failureCount ?? 0,
    version: raw.version ?? 1,
    revisions: raw.revisions ?? [],
    rejectionReason: raw.rejectionReason ?? null,
    applyError: raw.applyError ?? null,
    deferredUntil: raw.deferredUntil ?? null,
  };
}

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

/**
 * AI-2040 — apply/retry endpoint paths are provisional: C4 (AI-2039) had not published
 * its contract when this landed. The page itself stays pure and prop-driven, so a
 * contract change is confined to this component.
 */
const PROPOSALS_URL = "/admin/api/proposals";
const proposalAction = (id: string, action: string) => `${PROPOSALS_URL}/${encodeURIComponent(id)}/${action}`;

export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [secretConfigured, setSecretConfigured] = useState(true);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  const loadProposals = useCallback(async () => {
    try {
      const res = await apiGet<{ proposals: WireProposal[] }>(PROPOSALS_URL);
      setProposals((res.proposals ?? []).map(toProposal));
    } catch {
      setProposals([]);
    }
  }, []);

  useEffect(() => {
    if (auth === "authenticated") void loadProposals();
  }, [auth, loadProposals]);

  /** Mutations refetch so the queue reflects the server's authoritative status. */
  const proposalAct = useCallback(
    async (id: string, action: string, body?: unknown) => {
      try {
        await apiPost(proposalAction(id, action), body);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : `Failed to ${action} the proposal.`);
      } finally {
        await loadProposals();
      }
    },
    [loadProposals],
  );

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
        <Tabs pendingProposals={proposals.filter((p) => isPendingQueue(p, Date.now())).length} />
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/fleet" element={<FleetPage />} />
          <Route path="/ticket/:ticketId" element={<TicketDetailRoute />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route
            path="/proposals"
            element={
              <ProposalsPage
                proposals={proposals}
                now={Date.now()}
                onApprove={(id) => void proposalAct(id, "approve")}
                onReject={(id, reason) => void proposalAct(id, "reject", { reason })}
                onRevise={(id, feedback) => void proposalAct(id, "revise", { feedback })}
                onDefer={(id, intervalMs) => void proposalAct(id, "defer", { intervalMs })}
                onRetryApply={(id) => void proposalAct(id, "retry-apply")}
              />
            }
          />
          <Route path="/dead-letters" element={<DeadLettersPage />} />
          <Route path="/stalls" element={<StallsPage />} />
          <Route path="/webhooks" element={<WebhooksRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
