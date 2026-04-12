/**
 * Simple structured logger for the connector service.
 * Replaces the missing ../logger import that was blocking the build.
 */

export interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  debug: (msg: string, ...args: unknown[]) => void;
}

export function createLogger(level: string = "info"): Logger {
  const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLevel = levels[level] ?? 1;

  function log(lvl: keyof typeof levels, msg: string, args: unknown[]) {
    if (levels[lvl] >= minLevel) {
      const ts = new Date().toISOString();
      const payload = args.length > 0 ? ` ${JSON.stringify(args)}` : "";
      console.error(`[${ts}] [${lvl.toUpperCase()}] [connector] ${msg}${payload}`);
    }
  }

  return {
    info: (msg, ...args) => log("info", msg, args),
    error: (msg, ...args) => log("error", msg, args),
    warn: (msg, ...args) => log("warn", msg, args),
    debug: (msg, ...args) => log("debug", msg, args),
  };
}

export function componentLogger(base: Logger, component: string): Logger {
  return {
    info: (msg, ...args) => base.info(`[${component}] ${msg}`, ...args),
    error: (msg, ...args) => base.error(`[${component}] ${msg}`, ...args),
    warn: (msg, ...args) => base.warn(`[${component}] ${msg}`, ...args),
    debug: (msg, ...args) => base.debug(`[${component}] ${msg}`, ...args),
  };
}
