/**
 * G-20 scheduled gate-silently-off canary (AI-1552, §5.1).
 *
 * Fires a known-illegal command at a canary ticket and alerts unless the proxy
 * rejects it — the only check that catches "enforcement is quietly off" in the
 * running system (the AI-1361 failure pattern).
 */

export interface G20CanaryConfig {
  proxyUrl: string;
  authToken: string;
  agentId: string;
  canaryTicketId: string;
  illegalIntent?: string;
  onAlert: (result: G20CanaryResult) => void;
}

export interface G20CanaryResult {
  passed: boolean;
  error?: string;
  timestamp: string;
}

export async function runG20Canary(config: G20CanaryConfig): Promise<G20CanaryResult> {
  const timestamp = new Date().toISOString();
  const illegalIntent = config.illegalIntent ?? "deploy";

  try {
    const response = await fetch(`${config.proxyUrl}/proxy/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": config.authToken,
        "X-Openclaw-Agent": config.agentId,
        "X-Openclaw-Linear-Intent": illegalIntent,
      },
      body: JSON.stringify({
        query: "mutation G20Canary($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: config.canaryTicketId },
      }),
    });

    const data = await response.json() as { errors?: Array<{ message: string }>; data?: unknown };

    if (data.errors && data.errors.length > 0) {
      return { passed: true, timestamp };
    }

    const result: G20CanaryResult = {
      passed: false,
      error: `enforcement failure: illegal intent '${illegalIntent}' was NOT rejected on canary ticket ${config.canaryTicketId}. Gate may be silently off.`,
      timestamp,
    };
    config.onAlert(result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: G20CanaryResult = {
      passed: false,
      error: msg,
      timestamp,
    };
    config.onAlert(result);
    return result;
  }
}
