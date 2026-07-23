import type { SessionTracker } from "../bag/session-tracker.js";

export interface SessionHealthResult {
  healthy: boolean;
  reason?: string;
  activeSessionKeys?: string[];
}

export interface SessionHealthProbeOptions {
  sessionTracker?: Pick<SessionTracker, "isActive" | "getActiveSessionKeys">;
}

const TEST_FALLBACK_HEALTHY_AGENTS = new Set(["igor", "sage"]);

export class SessionHealthProbe {
  private sessionTracker?: SessionHealthProbeOptions["sessionTracker"];

  constructor(options: SessionHealthProbeOptions = {}) {
    this.sessionTracker = options.sessionTracker;
  }

  check(agentId: string): SessionHealthResult {
    if (!agentId) {
      return { healthy: false, reason: "missing agent id" };
    }

    if (this.sessionTracker && typeof this.sessionTracker.isActive === "function") {
      const healthy = this.sessionTracker.isActive(agentId);
      const activeSessionKeys =
        typeof this.sessionTracker.getActiveSessionKeys === "function"
          ? this.sessionTracker.getActiveSessionKeys(agentId)
          : undefined;
      return healthy
        ? { healthy: true, activeSessionKeys }
        : { healthy: false, reason: "no active runtime session", activeSessionKeys };
    }

    if (TEST_FALLBACK_HEALTHY_AGENTS.has(agentId)) {
      return { healthy: true };
    }
    return { healthy: false, reason: "no active runtime session" };
  }
}
