import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "deploy-probe");

export type ProbeResult =
  | { success: true; detail?: string }
  | { success: false; reason: "timeout" | "mismatch" | "unreachable" | "error"; detail: string };

export interface ProbeConfig {
  /**
   * The live service URL to probe (e.g. "https://api.fancymatt.com/health").
   */
  url: string;
  /**
   * The expected value/symbol to find in the response.
   * If it's a hex string (>= 7 chars), it's treated as a commit hash.
   */
  expected: string;
  /**
   * Timeout in milliseconds.
   */
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/**
 * AI-2515: Automated live-service probe to verify a deploy's outcome.
 *
 * Fetches the URL and checks the response for the expected symbol.
 * If the response is JSON, it checks the 'commit' field first (case-insensitive).
 * Otherwise, it performs a raw text grep for the expected string.
 */
export async function probeDeployOutcome(config: ProbeConfig): Promise<ProbeResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(config.url, {
      method: "GET",
      headers: { "Accept": "application/json, text/plain, */*" },
      signal: controller.signal,
    });

    clearTimeout(timer);

    const bodyText = await res.text();
    if (!res.ok) {
      return {
        success: false,
        reason: "unreachable",
        detail: `HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
      };
    }

    // Try JSON parsing to check specific fields (commit)
    try {
      const json = JSON.parse(bodyText);
      const commit = json.commit;
      if (typeof commit === "string" && isSymbolMatch(commit, config.expected)) {
        return { success: true, detail: `Matched 'commit' field: ${commit}` };
      }
    } catch {
      // Not JSON or missing commit field — fall through to raw text check
    }

    if (bodyText.includes(config.expected)) {
      return { success: true, detail: "Matched expected symbol in response body" };
    }

    // If expected looks like a commit hash, check for a partial match (at least 7 chars)
    if (isCommitHash(config.expected) && bodyText.match(new RegExp(config.expected.slice(0, 7), "i"))) {
        return { success: true, detail: `Matched partial commit hash: ${config.expected.slice(0, 7)}` };
    }

    return {
      success: false,
      reason: "mismatch",
      detail: `Running service did not reflect the expected change (expected symbol '${config.expected}' not found in response from ${config.url})`,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { success: false, reason: "timeout", detail: `Probe timed out after ${timeoutMs}ms` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, reason: "error", detail: msg };
  }
}

function isSymbolMatch(actual: string, expected: string): boolean {
  if (actual.toLowerCase() === expected.toLowerCase()) return true;
  // Partial match for commit hashes (long vs short)
  if (isCommitHash(actual) && isCommitHash(expected)) {
    return actual.toLowerCase().startsWith(expected.toLowerCase()) || expected.toLowerCase().startsWith(actual.toLowerCase());
  }
  return false;
}

function isCommitHash(str: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(str);
}
