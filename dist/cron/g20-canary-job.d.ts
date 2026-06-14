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
export declare function runG20Canary(config: G20CanaryConfig): Promise<G20CanaryResult>;
//# sourceMappingURL=g20-canary-job.d.ts.map