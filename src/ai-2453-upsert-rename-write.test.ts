/**
 * AI-2453: upsertAgent's write path must agree with its lookup.
 *
 * The lookup resolves an existing entry by name, falling back to linearUserId.
 * The write path re-derived the name predicate, so an entry resolved via the
 * fallback matched nothing: the update was a silent no-op that still reported
 * { isNew: false } — "updated successfully".
 *
 * The two halves are pinned separately on purpose. Keying the write off the
 * resolved `existing` entry (AC1/AC2) is unsafe alone: the fallback lookup is
 * unguarded against a falsy linearUserId, and both partial-entry callers write
 * linearUserId: "" (admin.ts:1512, onboard-wizard.ts:198). The no-op bug was
 * masking that bad lookup; fixing only the write converts a silent drop into a
 * silent clobber of an unrelated agent. AC5 pins that down.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgent,
  getAgents,
  reloadAgents,
  upsertAgent,
  type AgentConfig,
} from "./agents.js";

let dir: string;

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "igor",
    linearUserId: "u-igor",
    clientId: "c",
    clientSecret: "s",
    accessToken: "tok",
    refreshToken: "r",
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2453-"));
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
  reloadAgents();
});

afterEach(() => {
  delete process.env.AGENTS_FILE;
  reloadAgents();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Names as persisted. reloadAgents() re-reads from disk first, so this asserts
 * the write actually landed rather than trusting the in-memory list — the whole
 * defect is a save() that persists an unchanged list.
 */
function persistedNames(): string[] {
  reloadAgents();
  return getAgents().map((a) => a.name).sort();
}

function persisted(name: string): AgentConfig | undefined {
  reloadAgents();
  return getAgent(name);
}

describe("AC1: a rename resolved via the linearUserId fallback persists", () => {
  test("the stored entry is renamed, not duplicated or dropped", () => {
    upsertAgent(agent({ name: "oldname", linearUserId: "user-1", secretsPath: path.join(dir, "l.env") }));
    upsertAgent(agent({ name: "newname", linearUserId: "user-1", secretsPath: path.join(dir, "l.env") }));

    expect(persistedNames()).toEqual(["newname"]);
  });

  test("the incoming patch merges onto the stored entry", () => {
    upsertAgent(agent({
      name: "oldname",
      linearUserId: "user-1",
      clientId: "c-stored",
      accessToken: "tok-v1",
      secretsPath: path.join(dir, "l.env"),
    }));
    upsertAgent(agent({
      name: "newname",
      linearUserId: "user-1",
      clientId: "c-stored",
      accessToken: "tok-v2",
      secretsPath: path.join(dir, "l.env"),
    }));

    const entry = persisted("newname");
    expect(entry).toBeDefined();
    expect(entry?.accessToken).toBe("tok-v2");
    expect(entry?.clientId).toBe("c-stored");
    expect(persisted("oldname")).toBeUndefined();
  });
});

describe("AC2: isNew=false is returned only when a write genuinely occurred", () => {
  test("a fallback rename reports isNew=false and the rename is observable", () => {
    upsertAgent(agent({ name: "oldname", linearUserId: "user-1", secretsPath: path.join(dir, "l.env") }));
    const { isNew } = upsertAgent(agent({
      name: "newname",
      linearUserId: "user-1",
      accessToken: "tok-v2",
      secretsPath: path.join(dir, "l.env"),
    }));

    expect(isNew).toBe(false);
    expect(persisted("newname")).toBeDefined();
    expect(persisted("oldname")).toBeUndefined();
  });
});

describe("AC5: the fallback must not fire on a falsy linearUserId", () => {
  test("onboarding a new agent beside an unrelated partial creates it and leaves the partial intact", () => {
    // A partial entry mid-onboard, exactly as admin.ts:1512 writes it.
    upsertAgent(agent({
      name: "alpha",
      linearUserId: "",
      clientId: "c-alpha",
      accessToken: "",
      refreshToken: "",
      secretsPath: path.join(dir, "a.env"),
    }));

    const { isNew } = upsertAgent(agent({
      name: "beta",
      linearUserId: "",
      clientId: "c-beta",
      accessToken: "",
      refreshToken: "",
      secretsPath: path.join(dir, "b.env"),
    }));

    expect(isNew).toBe(true);
    expect(persistedNames()).toEqual(["alpha", "beta"]);
    // alpha must be untouched — not renamed to beta, not re-credentialed.
    expect(persisted("alpha")?.clientId).toBe("c-alpha");
    expect(persisted("beta")?.clientId).toBe("c-beta");
  });

  test("repeated partial onboards each register instead of overwriting one slot", () => {
    upsertAgent(agent({ name: "alpha", linearUserId: "", accessToken: "", refreshToken: "", secretsPath: path.join(dir, "a.env") }));
    upsertAgent(agent({ name: "beta", linearUserId: "", accessToken: "", refreshToken: "", secretsPath: path.join(dir, "b.env") }));
    upsertAgent(agent({ name: "gamma", linearUserId: "", accessToken: "", refreshToken: "", secretsPath: path.join(dir, "g.env") }));

    expect(persistedNames()).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("existing behaviour must not regress", () => {
  test("the name-match path still updates in place", () => {
    upsertAgent(agent({ name: "igor", linearUserId: "u-igor", accessToken: "tok-v1", secretsPath: path.join(dir, "l.env") }));
    const { isNew } = upsertAgent(agent({ name: "igor", linearUserId: "u-igor", accessToken: "tok-v2", secretsPath: path.join(dir, "l.env") }));

    expect(isNew).toBe(false);
    expect(persistedNames()).toEqual(["igor"]);
    expect(persisted("igor")?.accessToken).toBe("tok-v2");
  });

  test("a genuinely new agent with a distinct linearUserId still inserts", () => {
    upsertAgent(agent({ name: "igor", linearUserId: "u-igor", secretsPath: path.join(dir, "l.env") }));
    const { isNew } = upsertAgent(agent({ name: "sage", linearUserId: "u-sage", secretsPath: path.join(dir, "s.env") }));

    expect(isNew).toBe(true);
    expect(persistedNames()).toEqual(["igor", "sage"]);
  });

  test("a token refresh matched by linearUserId under the same name still lands", () => {
    upsertAgent(agent({ name: "igor", linearUserId: "u-igor", accessToken: "tok-v1", secretsPath: path.join(dir, "l.env") }));
    upsertAgent(agent({ name: "igor", linearUserId: "u-igor", accessToken: "tok-v2", refreshToken: "r2", secretsPath: path.join(dir, "l.env") }));

    expect(persisted("igor")?.refreshToken).toBe("r2");
  });
});
