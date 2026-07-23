/**
 * AI-2479 — code-artifact disclosure records.
 *
 * The connector-side twin of the CLI's `src/artifact.ts`. Kept as a copy rather
 * than shared: the two packages ship independently, and the parse here reads an
 * UNTRUSTED header, so it returns null where the CLI's throws on a bad operand.
 *
 * A record names a branch, a sha, and the RECIPIENT it was handed to — never the
 * declaring agent. Author identity is resolved from the OAuth token, which the
 * caller cannot forge; a self-reported author would be an honour system with
 * extra steps.
 *
 * `to` is what makes the guard targetable: a declaration obliges the agent it
 * was handed to, and nobody else. Keying on "a declaration exists on this
 * ticket" instead fires on third parties who were handed nothing (Ai's AI-2479
 * refusal).
 */
export interface CodeArtifact {
  branch: string;
  sha: string;
}

/** A declaration read back off the ticket, addressed to a specific agent. */
export interface ArtifactRecord extends CodeArtifact {
  to: string;
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

/**
 * Parse every artifact record out of a comment body.
 *
 * The sha is validated with the SAME `SHA_RE` the CLI enforces on write. Reading
 * laxer than the writer is how a comparison quietly stops comparing: bodies here
 * are agent-writable untrusted input, and `shasMatch` prefix-compares on the
 * shorter operand — so a recorded sha of `"9"` matched EVERY declared sha
 * starting with 9 (Ai's AI-2479 refusal). A sha that cannot be a sha is not a
 * weaker record; it is not a record.
 *
 * A record without a `to` is dropped: it names an obligation with no one to owe
 * it. Nothing has shipped, so no such marker exists in the wild.
 */
export function parseArtifactMarkers(body: string): ArtifactRecord[] {
  const out: ArtifactRecord[] = [];
  const markerRe = /<!--\s*artifact-disclosure:\s*(\{.*?\})\s*-->/g;

  for (const match of body.matchAll(markerRe)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.branch !== "string" || !rec.branch) continue;
      if (typeof rec.sha !== "string" || !SHA_RE.test(rec.sha)) continue;
      if (typeof rec.to !== "string" || !rec.to) continue;
      out.push({ branch: rec.branch, sha: rec.sha.toLowerCase(), to: rec.to });
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
  return a.branch.toLowerCase() === b.branch.toLowerCase() && shasMatch(a.sha, b.sha);
}

export function formatCodeArtifact(a: CodeArtifact): string {
  return `${a.branch}@${a.sha}`;
}
