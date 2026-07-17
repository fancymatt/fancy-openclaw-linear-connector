/**
 * AI-2546: Shared test-request helper for the intent-resolving verb path.
 *
 * Prevents silent suite decapitation when new required headers are added to
 * the /proxy/graphql verb path. All test suites that exercise the verb path
 * should use verbRequest() — or at minimum assertVerbPathReachable() — rather
 * than hand-rolling every header, so that adding a required header causes a
 * single point of updating (this file) plus a test failure (the canary) rather
 * than silently turning 33 suites into header-check suites.
 */

import { type Express } from "express";
import request from "supertest";
import type { Test } from "supertest";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type VerbIntent = "continue-workflow" | "request-revision";

export interface RequiredVerbHeader {
  name: string;
  intents: readonly VerbIntent[];
}

export interface VerbRequestOptions {
  agent?: string;
  token?: string;
  cliVersion?: string;
  intent?: VerbIntent;
  commandId?: string;
  body?: object;
}

// ---------------------------------------------------------------------------
// Required-header registry
// ---------------------------------------------------------------------------
// Adding a new required verb-path header? Add its entry here AND update the
// canary (src/ai-2546-verb-header-canary.test.ts). Both halves are required:
// the registry ensures the helper emits the header, and the canary proves
// the registry is current.

export const REQUIRED_VERB_HEADERS: readonly RequiredVerbHeader[] = [
  {
    name: "X-Openclaw-Command-Id",
    intents: ["continue-workflow", "request-revision"],
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a supertest POST /proxy/graphql request with all currently-required
 * headers automatically set. Tests should call this instead of hand-rolling
 * header sets when they exercise the verb path (continue-workflow or
 * request-revision).
 *
 * Headers set by this helper:
 *  - Authorization: Bearer {token}
 *  - X-Openclaw-Agent: {agent}
 *  - X-Openclaw-Linear-Cli-Version: {cliVersion}
 *  - X-Openclaw-Linear-Intent: {intent}
 *  - X-Openclaw-Command-Id: {commandId}
 *
 * Plus any additional headers required by the REQUIRED_VERB_HEADERS registry
 * that match the request's intent.
 */
export function verbRequest(app: Express, opts: VerbRequestOptions = {}): Test {
  const {
    agent = "igor",
    token = "tok-igor",
    cliVersion = "0.3.6",
    intent = "continue-workflow",
    commandId = "test-command-id",
    body,
  } = opts;

  let r = request(app)
    .post("/proxy/graphql")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Openclaw-Agent", agent)
    .set("X-Openclaw-Linear-Cli-Version", cliVersion)
    .set("X-Openclaw-Linear-Intent", intent);

  // Set all registered headers that apply to this intent.
  for (const h of REQUIRED_VERB_HEADERS) {
    if ((h.intents as readonly string[]).includes(intent)) {
      r = r.set(h.name, commandId);
    }
  }

  if (body) {
    r = r.send(body);
  }

  return r;
}

/**
 * Send a verb-path request and assert that it reaches transition behavior
 * (i.e., is NOT blocked by a missing-required-header guard).
 *
 * Throws if the response contains an errors array whose message looks like
 * a guard rejection — this is the generic detection that makes the canary
 * sensitive to any future required header without hardcoding its name.
 *
 * This is the detection half of the canary: a suite that tests a behavioral
 * property should pass through this assertion first to confirm the test
 * fixture itself reaches the behavior.
 */
export async function assertVerbPathReachable(
  app: Express,
  opts: VerbRequestOptions = {},
): Promise<void> {
  const res = await verbRequest(app, opts).send(opts.body as object | undefined);

  const errors: Array<{ message: string }> | undefined = res.body?.errors;
  if (errors && errors.length > 0) {
    const guardMsg = errors[0]?.message ?? "";
    // A guard rejection responds 200 with an errors array — that's the
    // signature of silent decapitation. Detect any such message that
    // relates to a required header.
    if (
      guardMsg.toLowerCase().includes("required") &&
      guardMsg.toLowerCase().includes("header")
    ) {
      throw new Error(
        `Future required header blocked verb path: ${guardMsg}`,
      );
    }
  }

  // If we got here, the request passed through all guards.
}
