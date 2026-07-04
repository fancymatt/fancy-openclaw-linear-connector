export type Severity = "green" | "yellow" | "red" | "gray";

export interface AttentionItem {
  severity: Exclude<Severity, "green">;
  title: string;
  message: string;
  href?: string;
}

export interface AgentRow {
  name: string;
  openclawAgent: string;
  linearUserId: string;
  host: string;
  identityMapped: boolean;
  credentialState: string;
  oauthConfigured: boolean;
  activity: string;
  pendingCount: number;
  active: boolean;
  queueDepth: number;
  activeSessionKey?: string | null;
  lastSuccess: string;
  lastError: string;
  nextExpectedTask: string;
  severity: Severity;
  diagnostics: Record<string, unknown>;
}

export interface TaskRow {
  owner: string;
  agent: string;
  state: string;
  severity: Severity;
  sessionKey: string;
  priority: number;
  related: string;
  relatedUrl?: string;
  eventType: string;
  action: string;
  lifecycle: string;
  age: string;
  updated?: string;
  safeError?: string;
  diagnostics: Record<string, unknown>;
}

export interface DashboardResponse {
  generatedAt: string;
  deployment: string;
  attention: AttentionItem[];
  status: {
    service: string;
    severity: Severity;
    agentsConfigured: number;
    activeSessions: number;
    pendingBagSize: number;
    eventsReceived: number;
    signalsSent: number;
  };
  agents: AgentRow[];
  tasks: TaskRow[];
  events: OperationalEvent[];
  settings: {
    effectiveConfig: Record<string, unknown>;
    workspaceTeamMappings: Array<Record<string, unknown>>;
    agentMappings: Array<Record<string, unknown>>;
    oauthSetup: Array<{ agent: string; state: string; safeNote: string }>;
    restartRequiredFlags: Array<{ name: string; required: boolean; note: string }>;
  };
}

export interface OperationalEvent {
  id?: number;
  occurredAt: string;
  outcome: string;
  type?: string;
  agent?: string;
  key?: string;
  errorSummary?: string | null;
  detail?: unknown;
}

export interface DispatchAckEntry {
  id: number;
  agentId: string;
  ticketId: string;
  dispatchedAt: string;
  lastSignalAt: string;
  ackStatus: "pending" | "acknowledged" | "unconfirmed" | "escalated" | "deferred";
  attemptCount: number;
}

export interface RegistryPolicyStatus {
  lastCheck: string | null;
  violations: string[];
  notes: string[];
}

export interface ConfigHealthStatus {
  healthy?: boolean;
  artifacts?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FleetResponse {
  generatedAt: string;
  agents: AgentRow[];
  dispatches: DispatchAckEntry[];
  registryPolicy: RegistryPolicyStatus;
  configHealth: ConfigHealthStatus;
}

export interface AlertRow {
  id: number;
  firstAt: string;
  lastAt: string;
  severity: "info" | "warning" | "critical";
  source: string;
  title: string;
  detail: unknown;
  agent: string | null;
  ticket: string | null;
  dedupKey: string;
  count: number;
  pushedAt: string | null;
  pushedVia: string | null;
  ackedAt: string | null;
}

export interface StructureResponse {
  configHealth: ConfigHealthStatus;
  workflows: Array<{ id: string; version?: number | string; states: number }>;
  workflowError: string | null;
  registryPolicy: RegistryPolicyStatus;
}

export interface WorkflowTransition {
  to?: string;
  verb?: string;
  generic?: string;
  [key: string]: unknown;
}

export interface WorkflowState {
  id: string;
  role?: string;
  native_state?: string;
  sla?: unknown;
  transitions?: WorkflowTransition[] | Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkflowDef {
  id: string;
  version?: number | string;
  states?: WorkflowState[];
  roles?: Record<string, unknown>;
  [key: string]: unknown;
}
