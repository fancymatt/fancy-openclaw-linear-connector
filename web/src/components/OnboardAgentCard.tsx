import { Card } from "../components";

/**
 * OnboardAgentCard — AI-2143 (AC2 slice of AI-1955): console launch point for
 * agent onboarding.
 *
 * Per Astrid's scope call (Option 2 — "launch + link"), the console does NOT
 * drive the OAuth register→authorize→verify flow over HTTP. That flow stays
 * CLI-only (`npm run onboard` → `onboard-wizard.ts`); this card simply surfaces
 * the command and links to the onboarding guide. No new OAuth plumbing.
 */

/** GitHub README section that documents the onboarding wizard end-to-end. */
const ONBOARD_GUIDE_URL =
  "https://github.com/fancyfleet/fancy-openclaw-linear-connector#quick-start-onboard-wizard";

/** The CLI entry point wired in package.json ("onboard": "node dist/onboard-wizard.js"). */
const ONBOARD_COMMAND = "npm run onboard";

export function OnboardAgentCard() {
  return (
    <Card span={4} title="Onboard a new agent">
      <p className="muted">
        Adding an agent runs the OAuth register → authorize → verify flow from
        the host shell. Run the wizard, then the new agent appears in the fleet
        table above once its first proxy call confirms.
      </p>
      <pre className="onboard-command" aria-label="Onboarding command">
        <code>{ONBOARD_COMMAND}</code>
      </pre>
      <p>
        <a href={ONBOARD_GUIDE_URL} target="_blank" rel="noreferrer noopener">
          Onboarding guide ↗
        </a>
      </p>
    </Card>
  );
}
