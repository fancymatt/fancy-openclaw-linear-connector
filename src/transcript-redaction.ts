/**
 * AI-2582 — Transcript redaction sweep.
 *
 * Scheduled component that scans all `.trajectory.jsonl` session transcript
 * files fleet-wide and applies the configured redact patterns (matching
 * `logging.redactPatterns` from gateway configs) to redact credential-shaped
 * tokens, reusing the shared `lib/secret_patterns.py` scanner.
 *
 * The sweep runs on a configurable interval (default: hourly) and exposes
 * liveness info for the /health endpoint so ac-validate can confirm the
 * component is scheduled without waiting for a trigger.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";
import { componentLogger, createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "transcript-redaction");

/** Registry key for the cron registry. */
const CRON_NAME = "transcript-redaction";

/** Relative path from this script to the redaction CLI (in repo root scripts/). */
const REDACT_SCRIPT = "scripts/redact-trajectory.py";

// ── Types ──────────────────────────────────────────────────────────────────

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
  /** Directory roots for .trajectory.jsonl files to scan. */
  scanRoots: string[];
}

/** Default interval: 1 hour. */
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;

/** Singleton health state. */
let _health: RedactionHealth = {
  enabled: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  lastRun: null,
  status: "idle",
  filesScannedTotal: 0,
  filesRedactedTotal: 0,
};

// ── Scan helpers ───────────────────────────────────────────────────────────

/**
 * Walk a directory tree and yield paths to all `.trajectory.jsonl` files.
 */
async function* walkTrajectoryFiles(root: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // Unreadable root — skip silently, the caller reports it as an error.
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    let stat: Stats;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkTrajectoryFiles(fullPath);
    } else if (entry === ".trajectory.jsonl" && stat.isFile()) {
      yield fullPath;
    }
  }
}

/**
 * Resolve the absolute path to the redact-trajectory.py script.
 * Resolved relative to the repo root (two levels up from src/).
 */
function resolveScriptPath(): string {
  // In production: repoRoot/src/transcript-redaction.ts
  // repoRoot = dirname(dirname(module path))
  return path.resolve(
    new URL(".", import.meta.url).pathname,
    "..",
    REDACT_SCRIPT,
  );
}

/** Per-file result from the Python CLI (parsed from JSON stdout). */
interface ScriptFileResult {
  path: string;
  modified: boolean;
  lines_scanned: number;
  total_redactions: number;
  labels_found: string[];
  error: string | null;
}

interface ScriptSummary {
  files: ScriptFileResult[];
  total_files: number;
  modified_files: number;
  errors: string[];
  total_redactions: number;
}

/**
 * Run a single redaction sweep across all configured scan roots.
 * Returns stats about what was found and redacted.
 */
export async function runTranscriptRedaction(
  config: TranscriptRedactionConfig,
): Promise<RedactionResult> {
  _health.status = "running";

  try {
    // Phase 1: discover .trajectory.jsonl files in all scan roots.
    const trajectoryFiles: string[] = [];
    const walkErrors: string[] = [];

    for (const root of config.scanRoots) {
      try {
        await fs.access(root);
      } catch {
        walkErrors.push(`scan root not accessible: ${root}`);
        continue;
      }
      try {
        for await (const filePath of walkTrajectoryFiles(root)) {
          trajectoryFiles.push(filePath);
        }
      } catch (err) {
        walkErrors.push(
          `error walking ${root}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (trajectoryFiles.length === 0) {
      _health.status = "idle";
      return { filesScanned: 0, filesRedacted: 0, errors: walkErrors };
    }

    // Phase 2: invoke the Python redaction script.
    const scriptPath = resolveScriptPath();
    const pythonBin = process.env.PYTHON_BIN ?? "python3";
    const args = [
      scriptPath,
      "--secret-patterns-path",
      config.secretPatternsPath,
      ...trajectoryFiles,
    ];

    let stdout: string;
    let stderr: string;
    try {
      const result = await execFileAsync(pythonBin, args, {
        timeout: 120_000, // 2 minute timeout for large scans
        maxBuffer: 10 * 1024 * 1024, // 10 MB stdout
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      _health.status = "error";
      // Report the actual files discovered even if Python failed —
      // returning 0 would hide evidence of what was found (AI-2582).
      return {
        filesScanned: trajectoryFiles.length,
        filesRedacted: 0,
        errors: [...walkErrors, `python redaction script failed: ${msg}`],
      };
    }

    if (stderr) {
      log.warn(`redact-trajectory stderr: ${stderr}`);
    }

    // Phase 3: parse results.
    let summary: ScriptSummary;
    try {
      summary = JSON.parse(stdout) as ScriptSummary;
    } catch {
      _health.status = "error";
      return {
        filesScanned: 0,
        filesRedacted: 0,
        errors: [...walkErrors, `failed to parse redaction script output: ${stdout.slice(0, 500)}`],
      };
    }

    const filesRedacted = summary.modified_files;
    const errors = [...walkErrors, ...summary.errors];

    _health.filesScannedTotal += trajectoryFiles.length;
    _health.filesRedactedTotal += filesRedacted;
    _health.status = errors.length > 0 ? "error" : "idle";

    return {
      filesScanned: trajectoryFiles.length,
      filesRedacted,
      errors,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    _health.status = "error";
    return { filesScanned: 0, filesRedacted: 0, errors: [msg] };
  }
}

// ── Cron registration ──────────────────────────────────────────────────────

/**
 * Create and start the scheduled transcript redaction sweep.
 * Returns a handle with health info and a stop function.
 */
export function registerTranscriptRedaction(
  config?: Partial<TranscriptRedactionConfig>,
): { health: RedactionHealth; stop: () => void } {
  const intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const secretPatternsPath =
    config?.secretPatternsPath ??
    process.env.SECRET_PATTERNS_PATH ??
    "/home/node/ai-repo/scripts/lib/secret_patterns.py";
  const scanRoots = config?.scanRoots ?? resolveDefaultScanRoots();

  const effectiveConfig: TranscriptRedactionConfig = {
    intervalMs,
    secretPatternsPath,
    scanRoots,
  };

  _health.enabled = true;
  _health.intervalMs = intervalMs;

  // Register with the cron registry for AI-1808 /health observability.
  registerCron(CRON_NAME, `every ${formatIntervalMs(intervalMs)}`);

  const timer = setInterval(async () => {
    _health.lastRun = Date.now();
    log.info(`transcript-redaction sweep starting (${scanRoots.length} scan roots)`);
    const result = await runTranscriptRedaction(effectiveConfig);
    markCronRun(CRON_NAME);
    log.info(
      `transcript-redaction sweep complete: ${result.filesScanned} files scanned, ` +
      `${result.filesRedacted} redacted, ${result.errors.length} errors`,
    );
    if (result.errors.length > 0) {
      log.error(`transcript-redaction errors: ${result.errors.join("; ")}`);
    }
  }, intervalMs);

  // Allow the Node.js process to exit even if the timer is still active.
  timer.unref();

  return {
    health: _health,
    stop: () => {
      clearInterval(timer);
      _health.enabled = false;
      log.info("transcript-redaction sweep stopped");
    },
  };
}

// ── Default scan root resolution ───────────────────────────────────────────

/**
 * Resolve the default set of scan roots from environment variables.
 * TRANSCRIPT_SCAN_ROOTS (colon-separated) overrides the hardcoded defaults.
 */
function resolveDefaultScanRoots(): string[] {
  const fromEnv = process.env.TRANSCRIPT_SCAN_ROOTS;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.split(":").map((s) => s.trim()).filter(Boolean);
  }
  return [
    "/home/node/.openclaw",
    "/tmp/agent-sessions",
  ];
}

/**
 * Get the current redaction health snapshot (no side effects).
 * Exposed at /health.transcriptRedaction for ac-validate.
 */
export function getTranscriptRedactionHealth(): RedactionHealth {
  return { ..._health };
}
