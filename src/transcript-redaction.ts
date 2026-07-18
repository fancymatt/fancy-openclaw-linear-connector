/**
 * AI-2582 — Transcript redaction sweep.
 *
 * Scheduled component that scans all `.trajectory.jsonl` session transcript
 * files fleet-wide and applies the configured redact patterns (matching
 * `logging.redactPatterns` from gateway configs) to redact credential-shaped
 * tokens, reusing the shared `lib/secret_patterns.py` scanner.
 *
 * Stub — implementation pending.
 *
 * The sweep runs on a configurable interval (default: hourly) and exposes
 * liveness info for the /health endpoint so ac-validate can confirm the
 * component is scheduled without waiting for a trigger.
 */

export interface RedactionHealth {
  enabled: boolean;
  intervalMs: number;
  lastRun: number | null;
  status: "idle" | "running" | "error";
  filesScannedTotal: number;
  filesRedactedTotal: number;
}

export interface RedactionResult {
  filesScanned: number;
  filesRedacted: number;
  errors: string[];
}

export interface TranscriptRedactionConfig {
  /** Interval between sweep runs in milliseconds. Default: 1 hour. */
  intervalMs: number;
  /** Absolute path to the secret_patterns.py scanner script. */
  secretPatternsPath: string;
  /** Glob patterns or directory roots for .trajectory.jsonl files to scan. */
  scanRoots: string[];
}

/** Default interval: 1 hour. */
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Run a single redaction sweep across all configured scan roots.
 * Returns stats about what was found and redacted.
 */
export async function runTranscriptRedaction(
  config: TranscriptRedactionConfig,
): Promise<RedactionResult> {
  // TODO (AI-2582): implement — walk scan roots, call secret_patterns.py,
  // apply redactPatterns to matching lines in .trajectory.jsonl files.
  throw new Error("Not implemented: runTranscriptRedaction");
}

/**
 * Create and start the scheduled transcript redaction sweep.
 * Returns a handle with health info and a stop function.
 */
export function registerTranscriptRedaction(
  config?: Partial<TranscriptRedactionConfig>,
): { health: RedactionHealth; stop: () => void } {
  // TODO (AI-2582): implement — start setInterval, attach health to registry
  throw new Error("Not implemented: registerTranscriptRedaction");
}
