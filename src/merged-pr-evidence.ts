/**
 * INF-440 — Merged PR/branch evidence recognition.
 *
 * A ticket can bounce back to `intake`/`write-tests` even after the real work
 * landed — a merged GitHub PR attachment or a branch already merged into
 * `main` is direct evidence that implementation happened. This module
 * gathers that evidence from Linear + git and decides whether it should
 * override a bounce transition.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { LINEAR_API_URL } from "./linear-helpers.js";

export interface MergedEvidenceResult {
  hasMergedPR: boolean;
  hasMergedBranch: boolean;
}

export interface MergedEvidenceOptions {
  /** Local path to the git repository to check branch ancestry against. */
  repoDir: string;
  /** Ticket's associated branch name, if any. */
  branchName: string | null;
}

interface LinearAttachmentNode {
  url?: string;
  sourceType?: string;
  metadata?: { status?: string } | null;
}

const ISSUE_ATTACHMENTS_QUERY = `query IssueAttachments($id: String!) {
  issue(id: $id) {
    attachments {
      nodes {
        url
        sourceType
        metadata
      }
    }
  }
}`;

async function fetchGithubPrAttachments(issueId: string, token: string): Promise<LinearAttachmentNode[]> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token,
    },
    body: JSON.stringify({ query: ISSUE_ATTACHMENTS_QUERY, variables: { id: issueId } }),
  });
  const body = (await res.json()) as {
    data?: { issue?: { attachments?: { nodes?: LinearAttachmentNode[] } } };
  };
  return body.data?.issue?.attachments?.nodes ?? [];
}

function isBranchMergedIntoMain(repoDir: string, branchName: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branchName, "main"], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gather merged-PR and merged-branch evidence for a ticket.
 */
export async function detectMergedEvidence(
  issueId: string,
  token: string,
  options: MergedEvidenceOptions,
): Promise<MergedEvidenceResult> {
  const attachments = await fetchGithubPrAttachments(issueId, token);
  const hasMergedPR = attachments.some(
    (node) => node.sourceType === "github" && node.metadata?.status === "merged",
  );

  let hasMergedBranch = false;
  if (options.branchName && fs.existsSync(options.repoDir)) {
    hasMergedBranch = isBranchMergedIntoMain(options.repoDir, options.branchName);
  }

  return { hasMergedPR, hasMergedBranch };
}

/**
 * Decide whether merged-PR/branch evidence should override a bounce
 * transition (to `intake` or `write-tests`) and advance the ticket to
 * `ac-validate` instead.
 */
export function resolveEvidenceTransition(
  currentState: string,
  evidence: MergedEvidenceResult,
): string | null {
  const isBounceState = currentState === "intake" || currentState === "write-tests";
  const hasEvidence = evidence.hasMergedPR || evidence.hasMergedBranch;
  return isBounceState && hasEvidence ? "ac-validate" : null;
}
