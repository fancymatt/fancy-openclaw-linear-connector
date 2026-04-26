/**
 * Simple structured logger for the connector service.
 * Replaces the missing ../logger import that was blocking the build.
 */
export function createLogger(level = "info") {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const minLevel = levels[level] ?? 1;
    function log(lvl, msg, args) {
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
export function componentLogger(base, component) {
    return {
        info: (msg, ...args) => base.info(`[${component}] ${msg}`, ...args),
        error: (msg, ...args) => base.error(`[${component}] ${msg}`, ...args),
        warn: (msg, ...args) => base.warn(`[${component}] ${msg}`, ...args),
        debug: (msg, ...args) => base.debug(`[${component}] ${msg}`, ...args),
    };
}
//# sourceMappingURL=logger.js.map