/**
 * AI-2524 — Milestone Close Verification template for the dev-sprint workflow.
 *
 * When a sprint reaches `post-validation`, the steward posts a milestone-close
 * verification comment. For user-facing sprints the close is gated on a visual
 * audit at multiple breakpoints (spec §5 hard rule): a sprint does not close on
 * code review alone. This module produces that comment, including the Visual
 * Audit breakpoint table and the sign-off checkbox.
 *
 * The visual-audit section is conditional in spirit — it is waived when no
 * `ui-impact` ticket appeared in the sprint (mirroring the `spawn_if:
 * label_present: ui-impact` gate on the post-validation state) — but the
 * template always renders the section and offers the "or waived" escape on the
 * checkbox so the sign-off is explicit either way.
 */

/** A single breakpoint row in the visual-audit table. */
export interface VisualAuditBreakpoint {
  /** Human label, e.g. "Desktop (≥1280px)". */
  label: string;
  /** Number of screens audited at this breakpoint (or a placeholder). */
  screensAudited?: number | string;
  /** Verdict text; defaults to the pass/fail placeholder. */
  verdict?: string;
  /** Reviewer name; defaults to the "[name]" placeholder. */
  reviewer?: string;
}

/** The canonical breakpoints audited at milestone close. */
export const DEFAULT_VISUAL_AUDIT_BREAKPOINTS: VisualAuditBreakpoint[] = [
  { label: "Desktop (≥1280px)" },
  { label: "Tablet (768px)" },
  { label: "Mobile (375px)" },
];

function renderRow(bp: VisualAuditBreakpoint): string {
  const screens = bp.screensAudited ?? "N";
  const verdict = bp.verdict ?? "✓ pass / ✗ fail";
  const reviewer = bp.reviewer ?? "[name]";
  return `| ${bp.label} | ${screens} | ${verdict} | ${reviewer} |`;
}

/**
 * Render the Visual Audit section of the milestone-close verification comment.
 *
 * @param uiAuditTicket - the wf:ui-audit child identifier + link, or null when
 *   the sprint had no ui-impact tickets (audit waived).
 */
export function renderVisualAuditSection(
  breakpoints: VisualAuditBreakpoint[] = DEFAULT_VISUAL_AUDIT_BREAKPOINTS,
  uiAuditTicket: { identifier: string; url: string } | null = null,
): string {
  const rows = breakpoints.map(renderRow).join("\n");
  const ticketLine = uiAuditTicket
    ? `Visual audit ticket: [${uiAuditTicket.identifier}](${uiAuditTicket.url})`
    : "Visual audit ticket: [UI-AUDIT-XXX](link)";
  return [
    "### Visual Audit",
    "",
    "| Breakpoint | Screens Audited | Verdict | Reviewer |",
    "|-----------|-----------------|---------|----------|",
    rows,
    "",
    ticketLine,
  ].join("\n");
}

/** The visual-audit sign-off checkbox (spec §5). */
export const VISUAL_AUDIT_SIGNOFF_CHECKBOX =
  "- [ ] Visual audit passed (or waived: no ui-impact tickets in sprint)";

/**
 * Build the full Milestone Close Verification comment body.
 *
 * @param uiAuditTicket - the spawned wf:ui-audit child, or null when waived.
 */
export function renderMilestoneCloseTemplate(
  uiAuditTicket: { identifier: string; url: string } | null = null,
  breakpoints: VisualAuditBreakpoint[] = DEFAULT_VISUAL_AUDIT_BREAKPOINTS,
): string {
  return [
    "## Milestone Close Verification",
    "",
    renderVisualAuditSection(breakpoints, uiAuditTicket),
    "",
    "### Sign-off",
    "",
    VISUAL_AUDIT_SIGNOFF_CHECKBOX,
    "",
    "> Hard rule (spec §5): a user-facing sprint does not close on code review",
    "> alone. Visual rendering must be verified at multiple breakpoints. The",
    "> ui-audit ticket's verdict is a gate input to milestone close.",
  ].join("\n");
}
