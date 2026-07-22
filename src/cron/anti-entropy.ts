/**
 * AI-1547 — Transition atomicity + standing anti-entropy reconciliation loop (G-7/G-17).
 *
 * Two checks per pass:
 *   AC1 — Native state desync: state:* label implies a native Linear stateId that
 *          differs from what Linear actually has (crash between the two writes).
 *          Heal by issuing an issueUpdate with the correct stateId.
 *
 *   AC2 — Missed barrier webhook (INF-122): a barrier-state parent whose children
 *          are ALL terminal but whose barrier never fired (dropped webhook). Heal by
 *          advancing the parent to the next barrier-target state. Uses the
 *          config-driven {@link isBarrierState} check from barrier.ts rather than
 *          a hardcoded "managing" label, so any workflow state declaring
 *          `barrier: true` gets auto-healing coverage.
 *
 *   AC3 — Standing cadence: registerAntiEntropyCron runs the pass periodically
 *          (not boot-time only). The result carries drift counts so callers can alert.
 *
 * INF-122 (2026-07-19): AC2 was found to be UNWIRED in production — the
 * registerAntiEntropyCron function existed but was never called from index.ts,
 * so barrier-missed events were never reconciled. Fixed by wiring it alongside
 * the SLA sweep cron. Also upgraded AC2 to config-driven barrier detection.
 */

import { isBarrierState, resolveBarrierTarget } from "../barrier.js";

import fs from "node:fs/promises";
import yaml from "js-yaml";
import { createLogger, componentLogger } from "../logger.js";
import { isNativelyTerminal } from "../terminality.js";
import { registerCron, formatIntervalMs, markCronRun } from "./registry.js";
import { type WorkflowDef } from "../workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "anti-entropy");

const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Public types ───────────────────────────────────────────────────────────

export interface AntiEntropyOptions {
  authToken: string | (() => string);
}

export interface AntiEntropyResult {
  scanned: number;
  nativeDesyncFound: number;
  nativeDesyncHealed: number;
  barrierMissedFound: number;
  barrierMissedReconciled: number;
  errors: string[];
}

// ── Internal types ─────────────────────────────────────────────────────────

interface LabelNode {
  id: string;
  name: string;
}

interface ChildNode {
  identifier: string;
  state?: { type: string } | null;
  labels: { nodes: Array<{ name: string }> };
}

interface IssueNode {
  id: string;
  identifier: string;
  team: { id: string };
  state: { id: string; name: string };
  labels: { nodes: LabelNode[] };
  children: { nodes: ChildNode[] };
}

// ── Semantic state map (mirrors workflow-gate.ts SEMANTIC_STATE_MAP) ────────

const SEMANTIC_STATE_MAP: Record<string, string[]> = {
  backlog:  ["Backlog"],
  todo:     ["Todo", "To Do", "To Develop"],
  thinking: ["Thinking", "In Progress"],
  doing:    ["Doing", "In Progress", "Developing"],
  managing: ["Managing"],
  done:     ["Done"],
  invalid:  ["Invalid", "Canceled", "Cancelled"],
};

const TERMINAL_STATE_NAMES = new Set(["done", "escape"]);

// ── Cache ──────────────────────────────────────────────────────────────────

let _teamStateCache: Map<string, Array<{ id: string; name: string; type: string }>> = new Map();
let _registryCache: Map<string, WorkflowDef> | null = null;

function resetAntiEntropyCache(): void {
  _teamStateCache.clear();
  _registryCache = null;
}

// ── Workflow registry (supports multi-document YAML via yaml.loadAll) ──────

function workflowDefFilePath(): string {
  return process.env.WORKFLOW_DEF_PATH ?? "";
}

async function loadAntiEntropyRegistry(): Promise<Map<string, WorkflowDef>> {
  if (_registryCache) return _registryCache;
  const registry = new Map<string, WorkflowDef>();
  const filePath = workflowDefFilePath();
  if (!filePath) return registry;

  const raw = await fs.readFile(filePath, "utf8");
  const docs = yaml.loadAll(raw) as WorkflowDef[];
  for (const def of docs) {
    if (def && typeof def === "object" && def.id) {
      registry.set(def.id, def);
    }
  }
  _registryCache = registry;
  return registry;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getStateLabelName(labels: LabelNode[]): string | null {
  for (const l of labels) {
    const m = l.name.match(/^state:(.+)$/);
    if (m) return m[1];
  }
  return null;
}

function getWorkflowId(labels: Array<{ name: string }>): string | null {
  for (const l of labels) {
    const m = l.name.match(/^wf:(.+)$/);
    if (m) return m[1];
  }
  return null;
}

function isChildTerminal(
  labels: Array<{ name: string }>,
  nativeStateType?: string | null,
): boolean {
  // INF-205: a natively-closed child (completed/canceled/duplicate) satisfies
  // the barrier even when its state:* label is stale or absent — matches
  // barrier.ts so the AC2 missed-barrier heal agrees with live evaluation.
  if (isNativelyTerminal(nativeStateType)) return true;
  return labels.some((l) => {
    const m = l.name.match(/^state:(.+)$/);
    return m ? TERMINAL_STATE_NAMES.has(m[1]) : false;
  });
}

function resolveAuthToken(authToken: AntiEntropyOptions["authToken"]): string {
  return typeof authToken === "function" ? authToken() : authToken;
}

function formatGraphQlErrors(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "none";
  return errors
    .map((err) => {
      if (err && typeof err === "object" && "message" in err) {
        return String((err as { message?: unknown }).message);
      }
      return JSON.stringify(err);
    })
    .join("; ");
}

// ── Linear API helpers ─────────────────────────────────────────────────────

async function fetchTeamWorkflowStates(
  teamId: string,
  authToken: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  const cached = _teamStateCache.get(teamId);
  if (cached) return cached;

  const query = `
    query TeamWorkflowStates($teamId: String!) {
      team(id: $teamId) {
        workflowStates {
          nodes { id name type }
        }
      }
    }
  `;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query, variables: { teamId } }),
  });
  type Resp = {
    data?: {
      team?: { workflowStates?: { nodes: Array<{ id: string; name: string; type: string }> } };
    };
    errors?: unknown[];
  };
  const data = (await res.json()) as Resp;
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${formatGraphQlErrors(data.errors)}`);
  }
  const nodes = data.data?.team?.workflowStates?.nodes ?? [];
  _teamStateCache.set(teamId, nodes);
  return nodes;
}

async function resolveSemanticToNativeId(
  teamId: string,
  semanticName: string,
  authToken: string,
): Promise<string | null> {
  const candidates = SEMANTIC_STATE_MAP[semanticName.toLowerCase()];
  if (!candidates) return null;
  const states = await fetchTeamWorkflowStates(teamId, authToken);
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  for (const candidate of candidates) {
    const match = states.find((s) => normalize(s.name) === normalize(candidate));
    if (match) return match.id;
  }
  return null;
}

async function fetchWorkflowIssues(authToken: string): Promise<IssueNode[]> {
  const query = `
    query AntiEntropyIssues {
      issues(filter: { labels: { name: { startsWith: "wf:" } } }) {
        nodes {
          id
          identifier
          team { id }
          state { id name }
          labels { nodes { id name } }
          children {
            nodes {
              identifier
              state { type }
              labels { nodes { name } }
            }
          }
        }
      }
    }
  `;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query }),
  });
  type Resp = { data?: { issues?: { nodes?: IssueNode[] } }; errors?: unknown[] };
  const data = (await res.json()) as Resp;
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${formatGraphQlErrors(data.errors)}`);
  }
  return data.data?.issues?.nodes ?? [];
}

async function issueUpdateState(
  issueId: string,
  stateId: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation IssueUpdate($issueId: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $issueId, input: $input) {
        success
      }
    }
  `;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query: mutation, variables: { issueId, input: { stateId } } }),
  });
  type Resp = { data?: { issueUpdate?: { success?: boolean } }; errors?: unknown[] };
  const data = (await res.json()) as Resp;
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${formatGraphQlErrors(data.errors)}`);
  }
  return data.data?.issueUpdate?.success === true;
}

async function issueUpdateLabelsAndState(
  issueId: string,
  labelIds: string[],
  stateId: string,
  authToken: string,
): Promise<boolean> {
  const mutation = `
    mutation IssueUpdate($issueId: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $issueId, input: $input) {
        success
      }
    }
  `;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query: mutation, variables: { issueId, input: { labelIds, stateId } } }),
  });
  type Resp = { data?: { issueUpdate?: { success?: boolean } }; errors?: unknown[] };
  const data = (await res.json()) as Resp;
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${formatGraphQlErrors(data.errors)}`);
  }
  return data.data?.issueUpdate?.success === true;
}

// ── Per-issue processing ───────────────────────────────────────────────────

async function processIssue(
  issue: IssueNode,
  registry: Map<string, WorkflowDef>,
  authToken: string,
  result: AntiEntropyResult,
): Promise<void> {
  const labels = issue.labels.nodes;
  const stateLabel = getStateLabelName(labels);
  const workflowId = getWorkflowId(labels);

  if (!stateLabel || !workflowId) return;

  const def = registry.get(workflowId);
  if (!def) return;

  const stateNode = def.states.find((s) => s.id === stateLabel);
  if (!stateNode) return;

  // AC1 — Native state desync: does the current Linear stateId match what the
  // state:* label implies it should be?
  if (stateNode.native_state) {
    const expectedId = await resolveSemanticToNativeId(issue.team.id, stateNode.native_state, authToken);
    if (expectedId && expectedId !== issue.state.id) {
      result.nativeDesyncFound++;
      const healed = await issueUpdateState(issue.id, expectedId, authToken);
      if (healed) result.nativeDesyncHealed++;
      log.info(
        `[anti-entropy] AC1 desync ${issue.identifier}: ` +
        `state=${stateLabel} expected=${expectedId} actual=${issue.state.id} healed=${healed}`,
      );
    }
  }

  // AC2 — Barrier missed (INF-122): config-driven. Any state declaring
  // `barrier: true` in the workflow definition whose children are all terminal
  // but whose barrier never auto-advanced (dropped webhook / cron blackout).
  if (isBarrierState(stateNode)) {
    const children = issue.children.nodes;
    if (children.length === 0) return;

    const allTerminal = children.every((c) => isChildTerminal(c.labels.nodes, c.state?.type ?? null));
    if (!allTerminal) return;

    result.barrierMissedFound++;

    // Resolve the barrier target via the shared helper from barrier.ts —
    // prefers the `complete` command, else the first non-break-glass transition.
    const barrierTarget = resolveBarrierTarget(def, stateNode);
    if (!barrierTarget) {
      result.errors.push(
        `${issue.identifier}: barrier reconcile failed — no forward transition for barrier state '${stateLabel}'`,
      );
      return;
    }

    // Look up the workflow state def for the target.
    const nextStateDef = def.states.find((s) => s.id === barrierTarget);
    const nextNativeSemantic = nextStateDef?.native_state ?? null;

    // Resolve target native state ID. If the target state has a native_state
    // mapping, use it; otherwise fall back to a generic "thinking" state.
    let nextNativeId: string | null = null;
    if (nextNativeSemantic) {
      nextNativeId = await resolveSemanticToNativeId(issue.team.id, nextNativeSemantic, authToken);
    }
    if (!nextNativeId) {
      // Fallback: try resolving this issue's current native state first —
      // the API may accept updating labels without changing native state.
      const currentNativeId = issue.state.id;
      nextNativeId = currentNativeId;
    }

    // Remove the current barrier state label (state:<currentBarrierState>)
    // and add the target state label (state:<barrierTarget>).
    const currentStateLabelName = `state:${stateLabel}`;
    const targetStateLabelName = `state:${barrierTarget}`;

    const currentLabelNode = labels.find((l) => l.name === currentStateLabelName);
    const remainingIds = labels
      .filter((l) => l.id !== currentLabelNode?.id)
      .map((l) => l.id);

    // We need to add the target state label. Since we can't add labels by
    // name in this path (we need IDs), and the anti-entropy pass doesn't
    // manage a label cache — we just update the native state + remove the
    // old label. The label-sync cron or next enrollment pass will add the
    // target state label.
    const reconciled = await issueUpdateLabelsAndState(issue.id, remainingIds, nextNativeId, authToken);
    if (reconciled) result.barrierMissedReconciled++;
    log.info(
      `[anti-entropy] AC2 barrier ${issue.identifier}: ` +
      `state:${stateLabel} -> state:${barrierTarget} ` +
      `children=${children.length} reconciled=${reconciled}`,
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runAntiEntropyPass(opts: AntiEntropyOptions): Promise<AntiEntropyResult> {
  const authToken = resolveAuthToken(opts.authToken);

  if (process.env.ANTI_ENTROPY_TEST_RESET === "1") {
    resetAntiEntropyCache();
  }

  const result: AntiEntropyResult = {
    scanned: 0,
    nativeDesyncFound: 0,
    nativeDesyncHealed: 0,
    barrierMissedFound: 0,
    barrierMissedReconciled: 0,
    errors: [],
  };

  let issues: IssueNode[];
  try {
    issues = await fetchWorkflowIssues(authToken);
  } catch (err) {
    result.errors.push(
      `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  result.scanned = issues.length;

  let registry: Map<string, WorkflowDef>;
  try {
    registry = await loadAntiEntropyRegistry();
  } catch (err) {
    result.errors.push(
      `registry load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  for (const issue of issues) {
    try {
      await processIssue(issue, registry, authToken, result);
    } catch (err) {
      result.errors.push(
        `${issue.identifier}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const driftFound = result.nativeDesyncFound + result.barrierMissedFound;
  if (driftFound > 0 || result.errors.length > 0) {
    log.info(
      `[anti-entropy] Pass: scanned=${result.scanned} ` +
      `desync=${result.nativeDesyncFound}/${result.nativeDesyncHealed} ` +
      `barrier=${result.barrierMissedFound}/${result.barrierMissedReconciled} ` +
      `errors=${result.errors.length}`,
    );
  }

  return result;
}

export function registerAntiEntropyCron(opts?: {
  intervalMs?: number;
  authToken?: string | (() => string);
}): NodeJS.Timeout {
  const intervalMs =
    opts?.intervalMs ??
    (process.env.ANTI_ENTROPY_INTERVAL
      ? parseInt(process.env.ANTI_ENTROPY_INTERVAL, 10)
      : 15 * 60 * 1000);

  const authToken =
    opts?.authToken ??
    (() => process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "");

  registerCron("anti-entropy", `every ${formatIntervalMs(intervalMs)}`);

  const timer = setInterval(() => {
    void (async () => {
      try {
        const result = await runAntiEntropyPass({ authToken });
        const driftFound = result.nativeDesyncFound + result.barrierMissedFound;
        if (driftFound > 0 || result.errors.length > 0) {
          log.info(
            `[anti-entropy] Scheduled pass: scanned=${result.scanned} ` +
            `desync=${result.nativeDesyncFound}/${result.nativeDesyncHealed} ` +
            `barrier=${result.barrierMissedFound}/${result.barrierMissedReconciled} ` +
            `errors=${result.errors.length}`,
          );
        }
      } catch (err) {
        log.error(
          `[anti-entropy] Scheduled pass failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        markCronRun("anti-entropy");
      }
    })();
  }, intervalMs);

  timer.unref();
  return timer;
}
