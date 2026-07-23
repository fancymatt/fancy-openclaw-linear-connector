/**
 * Done ticket detector cron registration.
 *
 * Registers the DoneTicketDetector as a periodic background job alongside the
 * existing dispatch watchdog and rescue sweep. Runs on the host's periodic
 * task scheduler alongside linear-connector-watchdog.py.
 *
 * AC10: Bootstrap registration — the scheduler configuration explicitly
 * references the script path, proven by the cron registration call.
 * AC11: Liveness observability — start() logs a startup confirmation.
 */

import { createLogger, componentLogger } from "../logger.js";
import { execSync } from "node:child_process";
import { getAccessToken } from "../agents.js";
import { formatIntervalMs, registerCron } from "./registry.js";
import {
  DoneTicketDetector,
  type DoneTicketDetectorConfig,
  type LinearApi,
  type LinearIssue,
  type LinearCreateIssueInput,
  type GitApi,
} from "../bag/done-ticket-detector.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "done-ticket-detector-cron");
const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Options ──────────────────────────────────────────────────────────────────

export interface DoneDetectorCronOptions {
  /** Path to the git repository to check. Default: process.env.DONE_DETECTOR_REPO_PATH */
  repoPath?: string;
  /** Lookback days for Done tickets. Default: 14 or process.env.DONE_DETECTOR_LOOKBACK_DAYS */
  lookbackDays?: number;
  /** Grace hours after Done before flagging. Default: 4 or process.env.DONE_DETECTOR_GRACE_HOURS */
  graceHours?: number;
  /** Poll interval in ms. Default: 1 hour or process.env.DONE_DETECTOR_POLL_INTERVAL_MS */
  pollIntervalMs?: number;
  /**
   * Token for Linear API calls. Default: getAccessToken("ai") or
   * process.env.LINEAR_OAUTH_TOKEN or process.env.LINEAR_API_KEY.
   */
  linearToken?: string;
}

// ── Real Linear API implementation ───────────────────────────────────────────

function resolveToken(token?: string): string | undefined {
  return token ?? getAccessToken("ai") ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
}

/** Create a real LinearApi implementation backed by fetch to api.linear.app. */
export function createLinearApi(linearToken?: string): LinearApi {
  const getToken = () => {
    const t = resolveToken(linearToken);
    if (!t) {
      throw new Error("No Linear API token available for done-ticket-detector");
    }
    return t;
  };

  const authHeaders = () => ({
    "content-type": "application/json",
    authorization: /^Bearer\s+/i.test(getToken()) ? getToken() : `Bearer ${getToken()}`,
  });

  async function graphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`Linear API returned ${res.status}`);
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(`Linear API errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data as T;
  }

  return {
    async fetchDoneTickets(lookbackDays: number): Promise<LinearIssue[]> {
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
      const data = await graphQL<{
        issues: {
          nodes: Array<{
            id: string;
            identifier: string;
            createdAt: string;
            team?: { key: string };
            labels: { nodes: Array<{ name: string }> };
            branchName?: string | null;
            state?: { name: string };
            completedAt?: string | null;
            comments?: { nodes: Array<{ id: string; body: string; createdAt: string }> };
          }>;
        };
      }>(
        `query DoneTickets($since: DateTime!) {
          issues(
            filter: {
              state: { type: { eq: "completed" } }
              completedAt: { gte: $since }
            }
            first: 100
            orderBy: completedAt
          ) {
            nodes {
              id
              identifier
              createdAt
              team { key }
              labels { nodes { name } }
              branchName
              state { name }
              completedAt
              comments(first: 5) { nodes { id body createdAt } }
            }
          }
        }`,
        { since },
      );

      return (data.issues?.nodes ?? []).map((n) => ({
        id: n.id,
        identifier: n.identifier,
        createdAt: n.createdAt,
        teamKey: n.team?.key,
        labels: n.labels?.nodes?.map((l) => l.name) ?? [],
        branchName: n.branchName,
        hasBranch: n.branchName != null && n.branchName.length > 0,
        doneAt: n.completedAt ?? null,
        comments: n.comments?.nodes?.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt,
        })) ?? [],
      }));
    },

    async applyLabel(issueId: string, label: string): Promise<boolean> {
      // First, find or create the label ID
      // We need the team from the issue to scope label lookup
      const issueData = await graphQL<{
        issue: { team: { id: string } };
      }>(
        `query LabelTeam($id: String!) {
          issue(id: $id) {
            team { id }
          }
        }`,
        { id: issueId },
      );

      const teamId = issueData.issue.team.id;

      const labelData = await graphQL<{
        issueLabels: { nodes: Array<{ id: string, name: string }> };
      }>(
        `query FindLabel($teamId: ID!) {
          issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 50) {
            nodes { id name }
          }
        }`,
        { teamId },
      );

      const labelId = labelData.issueLabels?.nodes?.find(
        (l) => l.name === label,
      )?.id;

      if (!labelId) {
        log.warn(`Label "${label}" not found for team ${teamId}`);
        return false;
      }

      const result = await graphQL<{
        issueUpdate: { success: boolean };
      }>(
        `mutation AddLabel($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }`,
        { id: issueId, labelIds: [labelId] },
      );

      return result.issueUpdate?.success ?? false;
    },

    async postComment(issueId: string, body: string): Promise<boolean> {
      const result = await graphQL<{
        commentCreate: { success: boolean };
      }>(
        `mutation PostComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        { issueId, body },
      );
      return result.commentCreate?.success ?? false;
    },

    async createIssue(input: LinearCreateIssueInput): Promise<{ id: string; identifier: string } | null> {
      // We need a team ID — use a lookup if teamId is empty
      let teamId = input.teamId;
      if (!teamId) {
        // Try to resolve from any accessible team
        log.warn("No teamId provided for re-land issue creation — skipping");
        return null;
      }

      const result = await graphQL<{
        issueCreate: {
          success: boolean;
          issue: { id: string; identifier: string };
        };
      }>(
        `mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $labelIds: [String!], $parentId: String!) {
          issueCreate(
            input: {
              teamId: $teamId
              title: $title
              description: $description
              labelIds: $labelIds
              parentId: $parentId
            }
          ) {
            success
            issue { id identifier }
          }
        }`,
        {
          teamId,
          title: input.title,
          description: input.description,
          labelIds: input.labels ?? null,
          parentId: input.parentId ?? "",
        },
      );

      if (!result.issueCreate?.success || !result.issueCreate?.issue) {
        return null;
      }

      return result.issueCreate.issue;
    },

    async hasExistingComment(issueId: string, bodyPrefix: string): Promise<boolean> {
      const data = await graphQL<{
        issue: {
          comments: { nodes: Array<{ body: string }> };
        };
      }>(
        `query HasComment($id: String!) {
          issue(id: $id) {
            comments(first: 50) { nodes { body } }
          }
        }`,
        { id: issueId },
      );

      return (data.issue?.comments?.nodes ?? []).some((c) =>
        c.body.startsWith(bodyPrefix),
      );
    },
  };
}

// ── Real Git API implementation ──────────────────────────────────────────────

/** Create a real GitApi implementation backed by execSync git commands. */
export function createGitApi(repoPath: string): GitApi {
  return {
    async ticketIdInMainLog(ticketId: string, afterDate: Date): Promise<boolean> {
      try {
        // AC7: Simple string match in git log --oneline. No ancestry matching.
        // Search commit messages on origin/main for the ticket ID as a word.
        // The --after filter reduces the search window but is not authoritative.
        const after = afterDate.toISOString().replace("T", " ").replace(/\..*$/, "");
        const cmd = [
          "git",
          "-C",
          repoPath,
          "log",
          "origin/main",
          `--after="${after}"`,
          "--oneline",
          "--grep",
          ticketId,
          "-1",
        ].join(" ");
        const output = execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();
        return output.length > 0;
      } catch {
        // AC8: Git errors are advisory — log and return false
        return false;
      }
    },

    async hasBranchForTicket(ticketId: string): Promise<boolean> {
      try {
        // Check if any remote branch matches the ticket ID pattern
        const cmd = [
          "git",
          "-C",
          repoPath,
          "ls-remote",
          "--heads",
          "origin",
          `*${ticketId}*`,
        ].join(" ");
        const output = execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();
        return output.length > 0;
      } catch {
        // Git errors are advisory
        return false;
      }
    },
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the DoneTicketDetector as an in-process recurring job.
 *
 * The timer is unref'd so it won't prevent graceful shutdown.
 * Registration happens alongside linear-connector-watchdog.py in index.ts.
 */
export function registerDoneDetectorCron(options?: DoneDetectorCronOptions): void {
  const repoPath =
    options?.repoPath ??
    process.env.DONE_DETECTOR_REPO_PATH;
  if (!repoPath) {
    log.warn(
      "[done-ticket-detector] DONE_DETECTOR_REPO_PATH not set — detector will not run. " +
      "Set this env var to the repo path where tickets are tracked.",
    );
    // Don't throw — advisory only. The detector is not configured; log and continue.
    return;
  }

  const lookbackDays = options?.lookbackDays ?? parseInt(process.env.DONE_DETECTOR_LOOKBACK_DAYS ?? "14", 10);
  const graceHours = options?.graceHours ?? parseInt(process.env.DONE_DETECTOR_GRACE_HOURS ?? "4", 10);
  const pollIntervalMs = options?.pollIntervalMs ?? parseInt(process.env.DONE_DETECTOR_POLL_INTERVAL_MS ?? String(60 * 60 * 1000), 10);
  registerCron("done-ticket-detector", `every ${formatIntervalMs(pollIntervalMs)}`);

  // Build real dependencies
  const deps = {
    linear: createLinearApi(options?.linearToken),
    git: createGitApi(repoPath),
    config: {
      lookbackDays,
      graceHours,
      pollIntervalMs,
      repoPath,
    },
  };

  const detector = new DoneTicketDetector(deps);
  detector.start();

  log.info(
    `[done-ticket-detector] Done ticket detector scheduled — ` +
    `lookbackDays=${lookbackDays} graceHours=${graceHours} ` +
    `pollInterval=${pollIntervalMs}ms repoPath=${repoPath}`,
  );
}
