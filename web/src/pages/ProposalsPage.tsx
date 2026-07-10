import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "apply-failed" | "in-revision";
export type ProposalSeverity = "HIGH" | "MEDIUM" | "LOW";
export type DiffKind = "guidance" | "yaml";

export interface ProposalDiff {
  kind: DiffKind;
  path: string;
  patch: string;
}

export interface EvidenceCluster {
  failureType: string;
  occurrences: number;
  timeRange: string;
  ticketIds: string[];
}

export interface ProposalRevision {
  version: number;
  feedback: string;
  createdAt: string;
}

export interface Proposal {
  id: string;
  title: string;
  workflowId: string;
  stateId: string;
  status: ProposalStatus;
  severity: ProposalSeverity;
  /** Deterministic rule output in [0,1] (C3 contract, AI-2038). Rendered as N / 100. */
  confidenceScore: number;
  createdAt: string;
  diffStat: { added: number; removed: number };
  diffs: ProposalDiff[];
  evidence: EvidenceCluster[];
  failureCount: number;
  version: number;
  revisions: ProposalRevision[];
  rejectionReason?: string | null;
  applyError?: string | null;
  deferredUntil?: string | null;
}

interface ProposalsPageProps {
  proposals: Proposal[];
  /** Epoch ms. Injected so relative ages and deferral expiry are deterministic. */
  now: number;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  onRevise: (id: string, feedback: string) => void;
  onDefer: (id: string, intervalMs: number) => void;
  onRetryApply: (id: string) => void;
}

const LIST_WIDTH_PX = 340;
const NARROW_VIEWPORT = "(max-width: 900px)";
const LINEAR_ISSUE_BASE = "https://linear.app/fancymatt/issue";

const SEVERITY_RANK: Record<ProposalSeverity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * `label` is what the operator reads; `description` is the badge's accessible name.
 * `applied` and `apply-failed` both spell out the approval that preceded them so
 * History never collapses "approved, applied" into "approved, apply failed" (AC5.4).
 */
const STATUS_META: Record<ProposalStatus, { label: string; tone: string; description: string }> = {
  pending: { label: "Pending", tone: "amber", description: "Pending — awaiting review" },
  "in-revision": { label: "In revision", tone: "blue", description: "In revision — awaiting a new draft" },
  approved: { label: "Approved", tone: "green", description: "Approved — apply in progress" },
  applied: { label: "Approved, applied", tone: "green-solid", description: "Approved, applied" },
  "apply-failed": { label: "Approved, apply failed", tone: "orange", description: "Approved, apply failed" },
  rejected: { label: "Rejected", tone: "red", description: "Rejected" },
};

const SEVERITY_TONE: Record<ProposalSeverity, string> = { HIGH: "red", MEDIUM: "amber", LOW: "gray" };

const PENDING_STATUSES: ProposalStatus[] = ["pending", "in-revision"];
const HISTORY_STATUSES: ProposalStatus[] = ["approved", "applied", "apply-failed", "rejected"];

const DEFER_PRESETS: Array<{ label: string; ms: number }> = [
  { label: "1 day", ms: 86_400_000 },
  { label: "3 days", ms: 3 * 86_400_000 },
  { label: "1 week", ms: 7 * 86_400_000 },
];

const REJECT_QUICK_PICKS = [
  "Too aggressive — exceeds the ticket SLA",
  "Evidence cluster is too small to act on",
  "Guidance already covers this case",
  "Wrong workflow state targeted",
];

// ── Formatting ──────────────────────────────────────────────────────────────

function relativeAge(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isDeferred(p: Proposal, now: number): boolean {
  if (!p.deferredUntil) return false;
  const until = Date.parse(p.deferredUntil);
  return !Number.isNaN(until) && until > now;
}

/** An elapsed deferral returns the card to the queue flagged as New (AC5.7). */
function returnedFromDeferral(p: Proposal, now: number): boolean {
  if (!p.deferredUntil) return false;
  const until = Date.parse(p.deferredUntil);
  return !Number.isNaN(until) && until <= now;
}

/** Membership rule for the Pending queue — shared with the nav badge in App.tsx. */
export function isPendingQueue(p: Proposal, now: number): boolean {
  return PENDING_STATUSES.includes(p.status) && !isDeferred(p, now);
}

// ── Diff parsing ────────────────────────────────────────────────────────────

type DiffLineKind = "added" | "removed" | "context" | "hunk";
interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

function isFileHeader(line: string): boolean {
  return line.startsWith("--- ") || line.startsWith("+++ ");
}

/** Unified patch → renderable lines. File headers are dropped; the path is shown separately. */
function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (isFileHeader(raw)) continue;
    if (raw.startsWith("@@")) lines.push({ kind: "hunk", text: raw });
    else if (raw.startsWith("+")) lines.push({ kind: "added", text: raw.slice(1) });
    else if (raw.startsWith("-")) lines.push({ kind: "removed", text: raw.slice(1) });
    else lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return lines;
}

interface YamlRow {
  key: string;
  before?: string;
  after?: string;
  changed: boolean;
}

const YAML_KEY = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

/**
 * Structured YAML diff: collapse the patch into one row per key carrying its
 * before/after values, so a changed key is addressable rather than being two
 * unrelated text lines.
 */
function parseYamlDiff(patch: string): YamlRow[] {
  const rows: YamlRow[] = [];
  const byKey = new Map<string, YamlRow>();

  for (const raw of patch.split("\n")) {
    if (isFileHeader(raw) || raw.startsWith("@@")) continue;

    let side: "before" | "after" | "both";
    let body: string;
    if (raw.startsWith("+")) {
      side = "after";
      body = raw.slice(1);
    } else if (raw.startsWith("-")) {
      side = "before";
      body = raw.slice(1);
    } else {
      side = "both";
      body = raw.startsWith(" ") ? raw.slice(1) : raw;
    }

    const match = YAML_KEY.exec(body);
    if (!match) continue;
    const [, key, value] = match;

    let row = byKey.get(key);
    if (!row) {
      row = { key, changed: false };
      byKey.set(key, row);
      rows.push(row);
    }
    if (side === "both") {
      row.before = value;
      row.after = value;
    } else if (side === "before") {
      row.before = value;
      row.changed = true;
    } else {
      row.after = value;
      row.changed = true;
    }
  }
  return rows;
}

// ── Layout ──────────────────────────────────────────────────────────────────

function useStackedLayout(): boolean {
  const read = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_VIEWPORT).matches
      : false;

  const [stacked, setStacked] = useState(read);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(NARROW_VIEWPORT);
    const sync = () => setStacked(mql.matches);
    sync();
    mql.addEventListener?.("change", sync);
    return () => mql.removeEventListener?.("change", sync);
  }, []);

  return stacked;
}

// ── Focus-trapped dialog ────────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function Modal({
  titleId,
  title,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const focusables = useCallback(
    () => (ref.current ? Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : []),
    [],
  );

  useEffect(() => {
    focusables()[0]?.focus();
  }, [focusables]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;

    const items = focusables();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = ref.current?.contains(active) ?? false;

    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="proposal-modal-backdrop">
      <div className="proposal-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} onKeyDown={handleKeyDown}>
        <h3 id={titleId} className="proposal-modal-title">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

// ── Diff blocks ─────────────────────────────────────────────────────────────

function GuidanceDiff({ diff }: { diff: ProposalDiff }) {
  const lines = parseUnifiedDiff(diff.patch);
  return (
    <section className="diff-block" data-testid="diff-block-guidance">
      <header className="diff-block-header">
        <span className="diff-kind-label">Guidance file</span>
        <code className="mono muted">{diff.path}</code>
      </header>
      <div className="diff-lines mono">
        {lines.map((line, i) => {
          if (line.kind === "hunk") {
            return (
              <div key={i} className="diff-line diff-hunk" data-testid="diff-hunk">
                {line.text}
              </div>
            );
          }
          const gutter = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
          const testid = line.kind === "context" ? "diff-line-context" : `diff-line-${line.kind}`;
          return (
            <div key={i} className={`diff-line diff-${line.kind}`} data-testid={testid}>
              <span className="diff-gutter">{gutter}</span>
              <span className="diff-content">{line.text}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function YamlDiff({ diff }: { diff: ProposalDiff }) {
  const rows = parseYamlDiff(diff.patch);
  return (
    <section className="diff-block" data-testid="diff-block-yaml">
      <header className="diff-block-header">
        <span className="diff-kind-label">Schema YAML</span>
        <code className="mono muted">{diff.path}</code>
      </header>
      <dl className="yaml-diff mono">
        {rows.map((row) => (
          <div key={row.key} className={`yaml-row${row.changed ? " changed" : ""}`} data-testid={`yaml-key-${row.key}`}>
            <dt className="yaml-key">{row.key}</dt>
            <dd className="yaml-values">
              {row.changed ? (
                <>
                  {row.before !== undefined && (
                    <span className="yaml-before">
                      <span className="diff-gutter">-</span>
                      {row.before}
                    </span>
                  )}
                  {row.after !== undefined && (
                    <span className="yaml-after">
                      <span className="diff-gutter">+</span>
                      {row.after}
                    </span>
                  )}
                </>
              ) : (
                <span className="yaml-unchanged muted">{row.after}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ── List card ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ProposalStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className="chip status-badge" data-testid="status-badge" data-tone={meta.tone} aria-label={meta.description}>
      {meta.label}
    </span>
  );
}

function ProposalCard({
  proposal,
  status,
  selected,
  tabIndex,
  isNew,
  now,
  onSelect,
}: {
  proposal: Proposal;
  status: ProposalStatus;
  selected: boolean;
  tabIndex: number;
  isNew: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={tabIndex}
      data-testid={`proposal-card-${proposal.id}`}
      data-proposal-id={proposal.id}
      {...(isNew ? { "data-new": "true" } : {})}
      className={`proposal-card${selected ? " selected" : ""}`}
      onClick={onSelect}
    >
      <div className="proposal-card-row">
        <StatusBadge status={status} />
        {isNew && <span className="chip blue">New</span>}
        <span className="relative-age muted" data-testid="relative-age">
          {relativeAge(proposal.createdAt, now)}
        </span>
      </div>
      <div className="workflow-state-pill mono" data-testid="workflow-state-pill">
        {`${proposal.workflowId} / ${proposal.stateId}`}
      </div>
      <div className="proposal-card-title">{proposal.title}</div>
      <div className="proposal-card-row">
        <span className="diff-stat mono" data-testid="diff-stat">
          {`+${proposal.diffStat.added} / -${proposal.diffStat.removed}`}
        </span>
        <span className="chip severity-badge" data-testid="severity-badge" data-tone={SEVERITY_TONE[proposal.severity]}>
          {proposal.severity}
        </span>
      </div>
      {status === "rejected" && proposal.rejectionReason && (
        <div className="proposal-card-reason muted">{proposal.rejectionReason}</div>
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

type TabKey = "pending" | "history";
type ModalKind = "approve" | "reject" | "revise";

export function ProposalsPage({ proposals, now, onApprove, onReject, onRevise, onDefer, onRetryApply }: ProposalsPageProps) {
  const stacked = useStackedLayout();

  const [tab, setTab] = useState<TabKey>("pending");
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [deferOpen, setDeferOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /**
   * Approve/reject/revise land here before the server confirms, so the operator sees
   * their action immediately (AC5.4). Tab membership deliberately still keys off the
   * *prop* status: re-partitioning on an unconfirmed action would yank the card out
   * from under the cursor. The card settles into History when fresh props arrive.
   *
   * `base` is the server status the guess was made against. The guess only stands
   * while the server still reports it; the moment the server moves the proposal
   * anywhere (applied, apply-failed, …) the real status wins. Without this the
   * overlay would shadow `status` forever, and the operator who approved would be
   * the one operator who never sees the apply fail or gets the retry button.
   */
  const [optimisticStatus, setOptimisticStatus] = useState<
    Record<string, { guess: ProposalStatus; base: ProposalStatus }>
  >({});

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const effectiveStatus = useCallback(
    (p: Proposal): ProposalStatus => {
      const entry = optimisticStatus[p.id];
      return entry && entry.base === p.status ? entry.guess : p.status;
    },
    [optimisticStatus],
  );

  const workflows = useMemo(
    () => Array.from(new Set(proposals.map((p) => p.workflowId))).sort(),
    [proposals],
  );

  const visible = useMemo(() => {
    const inTab = proposals.filter((p) =>
      tab === "pending" ? isPendingQueue(p, now) : HISTORY_STATUSES.includes(p.status),
    );
    const filtered = inTab.filter(
      (p) => (!workflowFilter || p.workflowId === workflowFilter) && (!statusFilter || p.status === statusFilter),
    );
    return [...filtered].sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (bySeverity !== 0) return bySeverity;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt); // oldest first within tier
    });
  }, [proposals, tab, workflowFilter, statusFilter, now]);

  const selected = visible.find((p) => p.id === selectedId) ?? null;
  const selectedStatus = selected ? effectiveStatus(selected) : null;

  function switchTab(next: TabKey) {
    setTab(next);
    setStatusFilter("");
    setSelectedId(null);
    setModal(null);
    setDeferOpen(false);
  }

  function openModal(kind: ModalKind, e: React.MouseEvent<HTMLButtonElement>) {
    triggerRef.current = e.currentTarget;
    setDeferOpen(false);
    setModal(kind);
  }

  /** Returns focus to the control that opened the dialog (AC5.8). */
  function closeModal() {
    setModal(null);
    triggerRef.current?.focus();
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
    const options = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (options.length === 0) return;
    const index = options.indexOf(document.activeElement as HTMLElement);

    if (e.key === "Enter") {
      if (index < 0) return;
      e.preventDefault();
      setSelectedId(options[index].dataset.proposalId ?? null);
      return;
    }
    e.preventDefault();
    const next = e.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
    options[index < 0 ? 0 : next]?.focus();
  }

  function confirmApprove() {
    if (!selected) return;
    setOptimisticStatus((prev) => ({ ...prev, [selected.id]: { guess: "approved", base: selected.status } }));
    setToast(`Proposal approved — applying “${selected.title}”.`);
    onApprove(selected.id);
    closeModal();
  }

  function submitReject(reason: string) {
    if (!selected) return;
    setOptimisticStatus((prev) => ({ ...prev, [selected.id]: { guess: "rejected", base: selected.status } }));
    setToast("Proposal rejected.");
    onReject(selected.id, reason);
    closeModal();
  }

  function submitRevise(feedback: string) {
    if (!selected) return;
    setOptimisticStatus((prev) => ({ ...prev, [selected.id]: { guess: "in-revision", base: selected.status } }));
    setToast("Revision requested.");
    onRevise(selected.id, feedback);
    closeModal();
  }

  function chooseDefer(ms: number) {
    if (!selected) return;
    onDefer(selected.id, ms);
    setDeferOpen(false);
    setToast("Proposal deferred.");
  }

  const statusOptions = tab === "pending" ? PENDING_STATUSES : HISTORY_STATUSES;
  const pendingCount = proposals.filter((p) => isPendingQueue(p, now)).length;

  return (
    <div className="page-content proposals-page">
      <div className="proposals-toolbar">
        <div className="tablist" role="tablist" aria-label="Proposal queue">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pending"}
            className={tab === "pending" ? "active" : ""}
            onClick={() => switchTab("pending")}
          >
            Pending <span className="muted">{pendingCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={tab === "history" ? "active" : ""}
            onClick={() => switchTab("history")}
          >
            History
          </button>
        </div>

        <div className="proposals-filters">
          <label>
            Workflow
            <select value={workflowFilter} onChange={(e) => setWorkflowFilter(e.target.value)}>
              <option value="">All workflows</option>
              {workflows.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div
        className="proposals-layout"
        data-testid="proposals-layout"
        data-layout={stacked ? "stacked" : "split"}
        style={{ "--proposal-list-width": `${LIST_WIDTH_PX}px` } as React.CSSProperties}
      >
        <div className="proposal-list-pane" data-testid="proposal-list-pane">
          <div
            role="listbox"
            aria-label="Proposals"
            className="proposal-listbox"
            ref={listRef}
            onKeyDown={handleListKeyDown}
          >
            {visible.map((p, i) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                status={effectiveStatus(p)}
                selected={p.id === selectedId}
                tabIndex={p.id === selectedId || (!selectedId && i === 0) ? 0 : -1}
                isNew={tab === "pending" && returnedFromDeferral(p, now)}
                now={now}
                onSelect={() => setSelectedId(p.id)}
              />
            ))}
          </div>
        </div>

        <div className="proposal-detail-pane" data-testid="proposal-detail-pane">
          {!selected || !selectedStatus ? (
            <div className="empty">
              {visible.length === 0
                ? tab === "pending"
                  ? "No proposals pending review"
                  : "No archived proposals yet"
                : "Select a proposal to review its diff"}
            </div>
          ) : (
            <>
              <header className="proposal-detail-header">
                <h2>{selected.title}</h2>
                <div className="strip">
                  <StatusBadge status={selectedStatus} />
                  <span className="workflow-state-pill mono">{`${selected.workflowId} / ${selected.stateId}`}</span>
                  <span className="muted">{relativeAge(selected.createdAt, now)}</span>
                </div>
                <div
                  className="confidence"
                  data-testid="confidence"
                  title="Based on failure frequency and pattern consistency."
                >
                  <span className="muted">Confidence</span>
                  <strong>{`${Math.round(selected.confidenceScore * 100)} / 100`}</strong>
                </div>
              </header>

              {selectedStatus === "apply-failed" && selected.applyError && (
                <div className="error-banner" role="alert">
                  {selected.applyError}
                </div>
              )}

              <div className="proposal-diffs">
                {selected.diffs.map((diff) =>
                  diff.kind === "yaml" ? (
                    <YamlDiff key={diff.path} diff={diff} />
                  ) : (
                    <GuidanceDiff key={diff.path} diff={diff} />
                  ),
                )}
              </div>

              <section className="evidence-cluster" data-testid="evidence-cluster">
                <h3>Evidence</h3>
                {selected.evidence.map((cluster) => (
                  <div key={cluster.failureType} className="evidence-entry">
                    <div>
                      <strong>{cluster.failureType}</strong>
                      <span className="muted">{` · ${cluster.occurrences} occurrences · ${cluster.timeRange}`}</span>
                    </div>
                    <div className="strip evidence-tickets">
                      {cluster.ticketIds.map((id) => (
                        <a key={id} href={`${LINEAR_ISSUE_BASE}/${id}`} target="_blank" rel="noreferrer">
                          {id}
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </section>

              {selected.revisions.length > 0 && (
                <section className="revision-history" data-testid="revision-history">
                  <h3>Revision history</h3>
                  <ol>
                    {selected.revisions.map((rev) => (
                      <li key={rev.version} data-testid="revision-entry">
                        <span className="muted">{`v${rev.version} · ${relativeAge(rev.createdAt, now)}`}</span>
                        <div>{rev.feedback}</div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {selectedStatus === "rejected" && selected.rejectionReason && (
                <section className="rejection-reason">
                  <h3>Rejection reason</h3>
                  <div>{selected.rejectionReason}</div>
                </section>
              )}

              {deferOpen && (
                <div className="defer-presets" data-testid="defer-presets">
                  <span className="muted">Defer for</span>
                  {DEFER_PRESETS.map((preset) => (
                    <button key={preset.label} type="button" onClick={() => chooseDefer(preset.ms)}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="action-bar" data-testid="action-bar" data-sticky="true">
                {PENDING_STATUSES.includes(selectedStatus) && (
                  <>
                    <button type="button" className="primary" onClick={(e) => openModal("approve", e)}>
                      Approve
                    </button>
                    <button type="button" className="danger" onClick={(e) => openModal("reject", e)}>
                      Reject
                    </button>
                    <button type="button" onClick={(e) => openModal("revise", e)}>
                      Revise
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeferOpen((open) => !open);
                      }}
                    >
                      Defer
                    </button>
                  </>
                )}
                {selectedStatus === "apply-failed" && (
                  <button type="button" onClick={() => onRetryApply(selected.id)}>
                    Retry apply
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {toast && (
        <div className="proposal-toast" role="status" aria-live="polite">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      )}

      {modal === "approve" && selected && (
        <Modal titleId="approve-proposal-title" title="Approve proposal?" onClose={closeModal}>
          <p>
            {`This applies the change to `}
            <code className="mono">{`${selected.workflowId} / ${selected.stateId}`}</code>
            {` immediately.`}
          </p>
          <div className="proposal-modal-actions">
            <button type="button" onClick={closeModal}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={confirmApprove}>
              Confirm approve
            </button>
          </div>
        </Modal>
      )}

      {modal === "reject" && selected && <RejectModal onCancel={closeModal} onSubmit={submitReject} />}
      {modal === "revise" && selected && <ReviseModal onCancel={closeModal} onSubmit={submitRevise} />}
    </div>
  );
}

// ── Reject / Revise forms ───────────────────────────────────────────────────

/** Reason is required; there is deliberately no character minimum (AC5.5). */
function RejectModal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("A reason is required — it is the signal the proposal generator learns from.");
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <Modal titleId="reject-proposal-title" title="Reject proposal" onClose={onCancel}>
      <div className="quick-picks">
        {REJECT_QUICK_PICKS.map((pick) => (
          <button key={pick} type="button" data-testid="reject-quick-pick" onClick={() => setReason(pick)}>
            {pick}
          </button>
        ))}
      </div>
      <label className="proposal-modal-field">
        Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} />
      </label>
      {error && (
        <div className="proposal-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="proposal-modal-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={submit}>
          Reject proposal
        </button>
      </div>
    </Modal>
  );
}

/** Feedback is required; the proposal revises in place rather than being replaced (AC5.6). */
function ReviseModal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (feedback: string) => void }) {
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = feedback.trim();
    if (!trimmed) {
      setError("Feedback is required so the generator knows what to change.");
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <Modal titleId="revise-proposal-title" title="Revise proposal" onClose={onCancel}>
      <label className="proposal-modal-field">
        Feedback
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={4} />
      </label>
      {error && (
        <div className="proposal-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="proposal-modal-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={submit}>
          Send feedback
        </button>
      </div>
    </Modal>
  );
}
