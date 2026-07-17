import type { Express } from "express";
import type { Test } from "supertest";

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

export const REQUIRED_VERB_HEADERS: readonly RequiredVerbHeader[] = [];

export function verbRequest(_app: Express, _opts: VerbRequestOptions = {}): Test {
  throw new Error("not implemented");
}

export async function assertVerbPathReachable(_app: Express, _opts: VerbRequestOptions = {}): Promise<void> {
  throw new Error("not implemented");
}
