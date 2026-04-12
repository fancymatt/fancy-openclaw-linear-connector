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
export declare function createLogger(level?: string): Logger;
export declare function componentLogger(base: Logger, component: string): Logger;
//# sourceMappingURL=logger.d.ts.map