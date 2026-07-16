#!/usr/bin/env node
/**
 * AI-2280 — Fail-closed guard on npm run build in the shared runtime tree.
 *
 * Prevents a stray dev build from overwriting the deployed `dist/` in the
 * runtime tree. The guard:
 *
 * 1. Resolves the tsc output directory (`./dist` relative to project root).
 * 2. Checks whether that output dir resolves to the runtime tree's `dist/`.
 * 3. If yes, checks for the `CONNECTOR_DEPLOY` env marker.
 * 4. If the marker is unset, exits 1 with a message directing the dev to a
 *    worktree — otherwise exits 0 silently (deploy path passes through).
 *
 * The key predicate is **location, not branch**: the runtime tree is expected
 * to sit on a feature branch per the AI-1832 deploy model, so branch is the
 * wrong predicate.
 *
 * Precedent: AI-1393 in the linear-skill-cli (guard-main-branch.js adapted to
 * key on output location rather than branch).
 */
import { realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function main() {
  const projectRoot = resolve(__dirname, "..");
  const outDir = resolve(projectRoot, "dist");

  // Resolve symlinks — the runtime tree may be a symlink target.
  let outDirReal;
  try {
    outDirReal = realpathSync(outDir);
  } catch {
    // dist/ doesn't exist yet — nothing to overwrite, allow build.
    process.exit(0);
  }

  // Resolve the current working directory's real path.
  let cwdReal;
  try {
    cwdReal = realpathSync(process.cwd());
  } catch {
    // Can't resolve cwd — abort safely rather than silently allowing.
    console.error(
      "error [build-guard]: cannot resolve cwd – refusing build. " +
        "Set CONNECTOR_DEPLOY=1 to bypass, or work in a worktree.",
    );
    process.exit(1);
  }

  // Are we building into the runtime tree's dist/?
  // Compare resolved paths: if the runtime's dist/ doesn't exist then we're
  // clearly not in the production runtime tree, so allow.
  const runtimeDist = resolve(cwdReal, "dist");
  let runtimeDistReal;
  try {
    runtimeDistReal = realpathSync(runtimeDist);
  } catch {
    // runtime dist/ doesn't exist — not the runtime tree. Allow.
    process.exit(0);
  }

  if (outDirReal !== runtimeDistReal) {
    // Different output location — not the runtime tree. Allow.
    process.exit(0);
  }

  // We're building into the runtime tree's dist/. Is the deploy marker set?
  // Accept CONNECTOR_DEPLOY (used by this guard's docs) or CONNECTOR_DEPLOY_BUILD
  // (used by guard-build-location.js). Both are env vars that the deploy path sets.
  if (
    process.env.CONNECTOR_DEPLOY === "1" ||
    process.env.CONNECTOR_DEPLOY_BUILD === "1"
  ) {
    // Deploy path — allow.
    process.exit(0);
  }

  // Refuse. Stray build would overwrite live production.
  console.error(
    "error [build-guard]: refusing to build — dist/ is the runtime tree's deployed output.\n" +
      "\n" +
      "This would overwrite the live production service.\n" +
      "To build safely, use a git worktree:\n" +
      "\n" +
      "  git worktree add ../<branch>-work <branch>\n" +
      "  cd ../<branch>-work\n" +
      "  npm install && npm run build\n" +
      "\n" +
      "If this is a production deploy, set CONNECTOR_DEPLOY=1:\n" +
      "\n" +
      "  CONNECTOR_DEPLOY=1 npm run build\n" +
      "\n" +
      "(The deploy script already sets this marker automatically.)",
  );
  process.exit(1);
}

main();
