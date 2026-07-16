/**
 * AI-2479 — code-artifact disclosure records.
 *
 * The connector-side twin of the CLI's `src/artifact.ts`. Kept as a copy rather
 * than shared: the two packages ship independently, and the parse here reads an
 * UNTRUSTED header, so it returns null where the CLI's throws on a bad operand.
 *
 * A record names only a branch and sha — never the declaring agent. Identity is
 * resolved from the OAuth token, which the caller cannot forge; a self-reported
 * author would be an honour system with extra steps.
 */
export interface CodeArtifact {
  branch: string;
  sha: string;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Parse a `<branch>@<sha>` header value, or null if it is not one.
 *
 * Splits on the LAST `@` so branch names containing `@` survive. Trimmed
 * because this reads a header rather than an argv entry.
 */
export function parseCodeArtifact(operand: string): CodeArtifact | null {
  const trimmed = operand.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;

  const branch = trimmed.slice(0, at).trim();
  const sha = trimmed.slice(at + 1).trim();
  if (!branch) return null;
  if (!SHA_RE.test(sha)) return null;

  return { branch, sha: sha.toLowerCase() };
}

export function parseArtifactMarkers(body: string): CodeArtifact[] {
  const out: CodeArtifact[] = [];
  const markerRe = /<!--\s*artifact-disclosure:\s*(\{.*?\})\s*-->/g;

  for (const match of body.matchAll(markerRe)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.branch !== "string" || typeof rec.sha !== "string") continue;
      if (!rec.branch || !rec.sha) continue;
      out.push({ branch: rec.branch, sha: rec.sha.toLowerCase() });
    } catch {
      // Historical corrupt markers must not make a ticket permanently ungateable.
    }
  }

  return out;
}

/**
 * Compare two shas allowing for abbreviation: `c81dfe0` and its 40-char form
 * name the same commit. Prefix-compare on the shorter, which is what git does.
 * Deliberately a PREFIX match, not a substring match — a sha that merely
 * contains another is a different commit.
 */
export function shasMatch(a: string, b: string): boolean {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  const len = Math.min(aa.length, bb.length);
  return aa.slice(0, len) === bb.slice(0, len);
}

export function sameArtifact(a: CodeArtifact, b: CodeArtifact): boolean {
  return a.branch === b.branch && shasMatch(a.sha, b.sha);
}

export function formatCodeArtifact(a: CodeArtifact): string {
  return `${a.branch}@${a.sha}`;
}
