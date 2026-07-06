/**
 * AI-1849 (Pillar 2 D2) — Connector docs endpoint.
 *
 * Serves instance-config docs (policy/, capability renderings) read-only to
 * authenticated agents using their lpx proxy token. The `linear guidance`
 * CLI verb fetches docs through this endpoint.
 *
 * Routes:
 *   GET /docs           — topic list
 *   GET /docs/:topic    — doc body (or per-agent capability rendering)
 *
 * Auth: Bearer lpx_* proxy token (NOT admin secret).
 */

import { Router, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { getAgentByProxyToken, type AgentConfig } from "../agents.js";
import { instanceConfigRoot } from "../instance-config.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface PolicyCapability {
  id: string;
  description?: string;
  exclusive?: boolean;
}
interface PolicyContainer {
  id: string;
  grants: string[];
}
interface PolicyBody {
  id: string;
  container: string;
  fills_roles?: string[];
  openclaw_agent?: string;
}
interface CapabilityPolicy {
  capabilities?: PolicyCapability[];
  containers: PolicyContainer[];
  bodies: PolicyBody[];
}

export interface GuidanceTopic {
  id: string;
  description: string;
}

// ── Path helpers ───────────────────────────────────────────────────────────

function policyDir(): string {
  return path.join(instanceConfigRoot(), "policy");
}

function capabilityPolicyPath(): string {
  return (
    process.env.CAPABILITY_POLICY_PATH ??
    path.join(instanceConfigRoot(), "config", "capability-policy.yaml")
  );
}

// special-case filename aliases: topic id → filename in policy/
const TOPIC_TO_FILE: Record<string, string> = {
  canon: "universal.md",
};
// reverse: filename → topic id
const FILE_TO_TOPIC: Record<string, string> = Object.fromEntries(
  Object.entries(TOPIC_TO_FILE).map(([id, fn]) => [fn, id]),
);

function topicToFilename(topicId: string): string {
  return TOPIC_TO_FILE[topicId] ?? `${topicId}.md`;
}

function filenameToTopicId(filename: string): string {
  return FILE_TO_TOPIC[filename] ?? path.basename(filename, ".md");
}

// ── Topic discovery ────────────────────────────────────────────────────────

function discoverPolicyTopics(): GuidanceTopic[] {
  const topics: GuidanceTopic[] = [];
  const dir = policyDir();
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const id = filenameToTopicId(file);
      const descriptions: Record<string, string> = {
        canon: "Universal task-handling canon",
        deploy: "Deployment playbook",
      };
      topics.push({ id, description: descriptions[id] ?? `${id} document` });
    }
  } catch {
    // policy dir may not exist
  }
  return topics;
}

function listTopics(): GuidanceTopic[] {
  return [
    { id: "capabilities", description: "Your agent's capability set from capability-policy.yaml" },
    ...discoverPolicyTopics(),
  ];
}

// ── Capability policy loading ──────────────────────────────────────────────

function loadCapabilityPolicy(): CapabilityPolicy | null {
  const policyPath = capabilityPolicyPath();
  try {
    const raw = fs.readFileSync(policyPath, "utf8");
    return yaml.load(raw) as CapabilityPolicy;
  } catch {
    return null;
  }
}

function renderCapabilitiesForAgent(
  agentName: string,
  policy: CapabilityPolicy,
): { container: string; capabilities: PolicyCapability[] } | null {
  const capMap = new Map<string, PolicyCapability>(
    (policy.capabilities ?? []).map((c) => [c.id, c]),
  );

  const body = policy.bodies.find(
    (b) => b.id === agentName || b.openclaw_agent === agentName,
  );
  if (!body) return null;

  const container = policy.containers.find((c) => c.id === body.container);
  if (!container) return null;

  const capabilities = container.grants.map((grantId) =>
    capMap.get(grantId) ?? { id: grantId },
  );

  return { container: container.id, capabilities };
}

// ── Auth helper ────────────────────────────────────────────────────────────

function authenticateProxyToken(req: Request, res: Response): AgentConfig | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header. Use Bearer <lpx_token>." });
    return null;
  }
  const token = auth.slice("Bearer ".length).trim();
  const agent = getAgentByProxyToken(token);
  if (!agent) {
    res.status(401).json({ error: "Unknown proxy token." });
    return null;
  }
  return agent;
}

// ── Router ─────────────────────────────────────────────────────────────────

export function createGuidanceRouter(): Router {
  const router = Router();

  // GET /docs — topic list
  router.get("/", (req: Request, res: Response) => {
    if (!authenticateProxyToken(req, res)) return;
    res.json({ topics: listTopics() });
  });

  // GET /docs/:topic — doc body
  router.get("/:topic", (req: Request, res: Response) => {
    const agent = authenticateProxyToken(req, res);
    if (!agent) return;

    const { topic } = req.params;
    const agentName = agent.openclawAgent ?? agent.name;

    // Special case: per-agent capability rendering
    if (topic === "capabilities") {
      const policy = loadCapabilityPolicy();
      if (!policy) {
        res.json({
          topic: "capabilities",
          agent: agentName,
          container: null,
          capabilities: [],
          body: `${agentName} capabilities: (capability-policy.yaml not found)`,
        });
        return;
      }

      const rendered = renderCapabilitiesForAgent(agentName, policy);
      if (!rendered) {
        // Agent not in policy — return empty set (not a 500)
        res.json({
          topic: "capabilities",
          agent: agentName,
          container: null,
          capabilities: [],
          body: `${agentName} capabilities: (agent not found in capability-policy.yaml)`,
        });
        return;
      }

      const capList = rendered.capabilities.map((c) => `  - ${c.id}`).join("\n");
      const body =
        `${agentName} (${rendered.container}) capabilities:\n${capList}`;

      res.json({
        topic: "capabilities",
        agent: agentName,
        container: rendered.container,
        capabilities: rendered.capabilities,
        body,
      });
      return;
    }

    // File-backed topics
    const validTopics = listTopics();
    const knownIds = validTopics.map((t) => t.id);

    if (!knownIds.includes(topic)) {
      res.status(404).json({
        error: `Unknown topic: '${topic}'`,
        validTopics: knownIds,
      });
      return;
    }

    const filename = topicToFilename(topic);
    const filePath = path.join(policyDir(), filename);
    try {
      const body = fs.readFileSync(filePath, "utf8");
      res.json({ topic, body });
    } catch {
      res.status(404).json({
        error: `Topic '${topic}' is listed but the file could not be read.`,
        validTopics: knownIds,
      });
    }
  });

  return router;
}

/** Liveness snapshot for /health. */
export function getDocsLiveness(): { registered: true } {
  return { registered: true };
}
