/**
 * AI-2569 — Tactical: verify all ~/.claude and ~/.codex container mounts are :ro
 *
 * These mounts were changed from :rw to :ro to close the credential-overwrite
 * blast radius (ea008af5d, pushed to origin/main 2026-07-17). This test acts
 * as a regression guard: if anyone reverts a mount to :rw, this test fails.
 *
 * Design: shells out to `docker inspect` on live containers to read actual
 * mount permissions. This tests the deployed state regardless of config format
 * evolution (Gateway config → docker-compose → direct Docker).
 *
 * AC1: Every container with ~/.claude mount has it as :ro (not :rw).
 * AC2: Every container with ~/.codex mount has it as :ro (not :rw).
 * AC3: No container exposes these paths with write permission.
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, it, expect } from "@jest/globals";

function hasDockerAccess(): boolean {
  try {
    execSync("docker ps -q", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the full Docker inspect JSON for every running container.
 * Uses `--format json` (Docker 25+) for structured output.
 */
function inspectAllContainers(): unknown[] {
  const raw = execSync(
    "docker ps -q | xargs -r docker inspect --format json 2>/dev/null || docker ps -q | xargs -r docker inspect 2>/dev/null",
    { encoding: "utf-8", stdio: "pipe", timeout: 30000 },
  );
  // Each container's JSON is on its own line when --format json is used;
  // fallback: try to parse as a JSON array.
  const lines = raw.trim().split("\n").filter(Boolean);
  if (lines.length === 1) {
    return JSON.parse(lines[0]) as unknown[];
  }
  return lines.map((l) => JSON.parse(l));
}

interface MountPoint {
  Source: string;
  Destination: string;
  Mode: string;
  RW: boolean;
  Type: string;
}

interface DockerContainer {
  Name?: string;
  name?: string;
  Image?: string;
  image?: string;
  Mounts?: MountPoint[];
  mounts?: MountPoint[];
  HostConfig?: { Mounts?: MountPoint[] };
}

function toContainer(c: unknown): DockerContainer {
  const r = c as Record<string, unknown>;
  return {
    Name: typeof r.Name === "string" ? r.Name : undefined,
    name: typeof r.name === "string" ? r.name : undefined,
    Image: typeof r.Image === "string" ? r.Image : undefined,
    image: typeof r.image === "string" ? r.image : undefined,
    Mounts: Array.isArray(r.Mounts) ? (r.Mounts as MountPoint[]) : undefined,
    mounts: Array.isArray(r.mounts) ? (r.mounts as MountPoint[]) : undefined,
    HostConfig: (r.HostConfig as { Mounts?: MountPoint[] } | undefined),
  };
}

function getMounts(c: DockerContainer): MountPoint[] {
  return c.Mounts ?? c.mounts ?? c.HostConfig?.Mounts ?? [];
}

function getName(c: DockerContainer): string {
  return (c.Name ?? c.name ?? "").replace(/^\//, "");
}

function collectProblematicMounts(
  containers: unknown[],
  pathPatterns: RegExp[],
): Array<{ container: string; image: string; mount: MountPoint }> {
  const results: Array<{ container: string; image: string; mount: MountPoint }> = [];

  for (const raw of containers) {
    const c = toContainer(raw);
    const name = getName(c);
    const image = String(c.Image ?? c.image ?? "unknown");
    const mounts = getMounts(c);
    for (const m of mounts) {
      const bindPath = m.Source ?? "";
      if (pathPatterns.some((pat) => pat.test(bindPath))) {
        if (m.RW !== false || (m.Mode ?? "").includes("rw")) {
          results.push({ container: name, image, mount: m });
        }
      }
    }
  }

  return results;
}

const CLAUDE_PATTERNS = [
  /\.claude$/,
  /\.claude[/\\]/,
  /claude\s*$/i, // bare "claude" at end of path
];

const CODEX_PATTERNS = [
  /\.codex$/,
  /\.codex[/\\]/,
  /codex\s*$/i,
];

// ── Known containers with .claude mounts (from ea008af5d manifest) ─────────
// These are the ~25 containers that had ~/.claude:rw changed to :ro.
// The list is captured at deployment time to detect drift in subsequent deploys.
const EXPECTED_CLAUDE_CONTAINERS = [
  /^dev[_-]/i,
  /^code[_-]review/i,
  /^merge[_-]gate/i,
  /^steward/i,
  /^doc[_-]steward/i,
  /^utility/i,
  /^design/i,
  /^3d[_-]art/i,
  /^image[_-]gen/i,
  /^media[_-]ops/i,
  /^financial/i,
  /^marketing/i,
  /^learning/i,
  /^personal[_-]style/i,
  /^games/i,
  /^living[_-]spaces/i,
  /^input/i,
  /^writing/i,
  /^travel[_-]advisory/i,
  /^yoshi/i,
  /^infra[_-]admin/i,
];

// ── Known containers with .codex mounts (from ea008af5d manifest) ──────────
// These are the ~4 containers that had ~/.codex:rw changed to :ro.
const EXPECTED_CODEX_CONTAINERS = [
  /^code[_-]review/i,
  /^dev[_-]/i,
  /^merge[_-]gate/i,
  /^writing/i,
];

// ── Unit tests for the detection logic (no Docker needed) ──────────────────

describe("AI-2569: detection logic (unit)", () => {
  it("detects a .claude :rw mount as problematic", () => {
    const containers = [
      toContainer({
        Name: "/test-dev",
        Image: "test-image",
        Mounts: [
          { Source: "/home/user/.claude", Destination: "/home/node/.claude", Mode: "rw", RW: true, Type: "bind" },
        ],
      }),
    ];
    const problems = collectProblematicMounts(containers, CLAUDE_PATTERNS);
    expect(problems).toHaveLength(1);
    expect(problems[0].container).toBe("test-dev");
    expect(problems[0].mount.RW).toBe(true);
  });

  it("allows a .claude :ro mount", () => {
    const containers = [
      toContainer({
        Name: "/test-dev",
        Image: "test-image",
        Mounts: [
          { Source: "/home/user/.claude", Destination: "/home/node/.claude", Mode: "ro", RW: false, Type: "bind" },
        ],
      }),
    ];
    const problems = collectProblematicMounts(containers, CLAUDE_PATTERNS);
    expect(problems).toHaveLength(0);
  });

  it("detects a .codex :rw mount as problematic", () => {
    const containers = [
      toContainer({
        Name: "/test-review",
        Image: "test-image",
        Mounts: [
          { Source: "/home/user/.codex", Destination: "/home/node/.codex", Mode: "rw", RW: true, Type: "bind" },
        ],
      }),
    ];
    const problems = collectProblematicMounts(containers, CODEX_PATTERNS);
    expect(problems).toHaveLength(1);
  });

  it("ignores non-claude/codex mounts", () => {
    const containers = [
      toContainer({
        Name: "/test-dev",
        Image: "test-image",
        Mounts: [
          { Source: "/home/user/Code", Destination: "/home/node/Code", Mode: "rw", RW: true, Type: "bind" },
          { Source: "/home/user/.ssh", Destination: "/home/node/.ssh", Mode: "ro", RW: false, Type: "bind" },
        ],
      }),
    ];
    const problems = collectProblematicMounts(containers, [...CLAUDE_PATTERNS, ...CODEX_PATTERNS]);
    expect(problems).toHaveLength(0);
  });
});

describe("AI-2569: ~/.claude and ~/.codex mounts are :ro (live check)", () => {
  let allContainers: unknown[];
  let skipReason: string | null = null;

  beforeAll(() => {
    if (!hasDockerAccess()) {
      skipReason = "no Docker access — must run on host (Nakazawa)";
      return;
    }
    allContainers = inspectAllContainers();
  });

  it("AC1: no running container has ~/.claude mounted :rw", () => {
    if (skipReason) return;
    const problems = collectProblematicMounts(allContainers, CLAUDE_PATTERNS);
    const violations = problems.map(
      (p) => `${p.container} (${p.image}): ${p.mount.Source} → ${p.mount.Destination} (RW=${p.mount.RW}, mode=${p.mount.Mode})`,
    );
    expect(violations).toEqual([]);
  });

  it("AC2: no running container has ~/.codex mounted :rw", () => {
    if (skipReason) return;
    const problems = collectProblematicMounts(allContainers, CODEX_PATTERNS);
    const violations = problems.map(
      (p) => `${p.container} (${p.image}): ${p.mount.Source} → ${p.mount.Destination} (RW=${p.mount.RW}, mode=${p.mount.Mode})`,
    );
    expect(violations).toEqual([]);
  });

  it("AC3: every renamed tank container still has .claude mounted", () => {
    // This test verifies that a container that existed at deploy time hasn't
    // silently lost its .claude mount entirely (which would also close the
    // blast radius but would likely break the agent's Claude Max auth).
    if (skipReason) return;
    if (!allContainers) return;
    const containers = allContainers!.map(toContainer);
    const names = containers.map(getName);
    const missing: string[] = [];

    for (const pattern of EXPECTED_CLAUDE_CONTAINERS) {
      const matching = names.filter((n) => pattern.test(n));
      for (const m of matching) {
        const c = containers.find((x) => getName(x) === m);
        if (!c) continue;
        const mounts = getMounts(c);
        const hasClaude = mounts.some(
          (mnt) => CLAUDE_PATTERNS.some((pat) => pat.test(mnt.Source ?? "")),
        );
        if (!hasClaude) missing.push(m);
      }
    }

    expect(missing).toEqual([]);
  });

  it("AC4: every codex-equipped container still has .codex mounted", () => {
    if (skipReason) return;
    if (!allContainers) return;
    const containers = allContainers!.map(toContainer);
    const names = containers.map(getName);
    const missing: string[] = [];

    for (const pattern of EXPECTED_CODEX_CONTAINERS) {
      const matching = names.filter((n) => pattern.test(n));
      for (const m of matching) {
        const c = containers.find((x) => getName(x) === m);
        if (!c) continue;
        const mounts = getMounts(c);
        const hasCodex = mounts.some(
          (mnt) => CODEX_PATTERNS.some((pat) => pat.test(mnt.Source ?? "")),
        );
        if (!hasCodex) missing.push(m);
      }
    }

    expect(missing).toEqual([]);
  });
});
