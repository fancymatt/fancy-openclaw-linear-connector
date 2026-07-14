import path from "node:path";
import {
  STATE_DIR_ENV,
  computeStateDefaults,
  resolveStatePath,
  stateDir,
} from "./state-dir.js";

describe("state-dir (AI-2263)", () => {
  const prev = process.env[STATE_DIR_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = prev;
  });

  describe("backward compat: state dir unset", () => {
    beforeEach(() => {
      delete process.env[STATE_DIR_ENV];
    });

    it("stateDir() is undefined", () => {
      expect(stateDir()).toBeUndefined();
    });

    it("resolveStatePath resolves against cwd", () => {
      expect(resolveStatePath("agents.json")).toBe(
        path.resolve(process.cwd(), "agents.json"),
      );
    });

    it("computeStateDefaults returns no overrides (strict no-op)", () => {
      expect(computeStateDefaults(process.env)).toEqual({});
    });

    it("treats a blank value as unset", () => {
      expect(computeStateDefaults({ [STATE_DIR_ENV]: "   " })).toEqual({});
      expect(stateDir({ [STATE_DIR_ENV]: "" })).toBeUndefined();
    });
  });

  describe("state dir set", () => {
    const dir = "/srv/openclaw/linear-connector";

    it("computeStateDefaults derives .env, DATA_DIR and AGENTS_FILE", () => {
      expect(computeStateDefaults({ [STATE_DIR_ENV]: dir })).toEqual({
        dotenvPath: path.resolve(dir, ".env"),
        DATA_DIR: path.resolve(dir, "data"),
        AGENTS_FILE: path.resolve(dir, "agents.json"),
      });
    });

    it("resolveStatePath resolves against the state dir", () => {
      process.env[STATE_DIR_ENV] = dir;
      expect(resolveStatePath("config", "workflows.yaml")).toBe(
        path.resolve(dir, "config", "workflows.yaml"),
      );
    });
  });
});
