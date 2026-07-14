#!/usr/bin/env node
/**
 * Build-location guard for the connector's shared runtime tree.
 *
 * Refuses `npm run build` when the build output directory resolves to the
 * live runtime tree's dist/ AND the deploy marker is not set.
 *
 * The live runtime tree is at:
 *   /home/fancymatt/Code/repos/fancy-openclaw-linear-connector
 * It holds the production dist/ plus runtime state (agents.json, data/, .env).
 * Building in that tree silently overwrites the live dist/, while DEPLOY_COMMIT
 * still reports the last deployed commit.
 *
 * The deploy script builds in a pinned worktree and sets CONNECTOR_DEPLOY_BUILD=1,
 * so it passes this guard untouched.
 *
 * Dev work MUST use a git worktree (see connector-skill-propagation-runbook.md).
 *
 * Fails CLOSED: if the location cannot be determined, refuse rather than proceed.
 */

import { resolve, parse } from 'node:path';
import { realpathSync } from 'node:fs';

// CI environments always have clean, correct checkouts — guard not needed.
if (process.env.CI) process.exit(0);

// Deploy script sets this env var — building in the deploy worktree is always OK.
if (process.env.CONNECTOR_DEPLOY_BUILD === '1') process.exit(0);

// The canonical runtime tree path (the systemd service's WorkingDirectory).
const RUNTIME_TREE = '/home/fancymatt/Code/repos/fancy-openclaw-linear-connector';

/**
 * Safely resolve a path to its real filesystem location.
 * Returns null if the path does not exist or cannot be resolved.
 */
function resolveReal(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolve cwd to its real path, using the directory component of a
 * non-existent dist/ path as a fallback (since dist/ may not exist yet
 * on the first build in a clean checkout).
 */
function resolveCwdReal() {
  // Try realpath on cwd directly — always works for an existing directory.
  const cwdReal = resolveReal(process.cwd());
  if (cwdReal) return cwdReal;

  // Fallback: parse the cwd path and resolve parent-by-parent
  // (unlikely to fail but fail-closed if it does).
  return null;
}

const cwdReal = resolveCwdReal();
const runtimeReal = resolveReal(RUNTIME_TREE);

// Fail closed: if neither cwd nor runtime tree can be resolved, refuse.
if (!cwdReal && !runtimeReal) {
  console.error(
    `\nBUILD LOCATION GUARD: cannot determine working directory.\n` +
    `Neither the current directory nor the runtime tree path could be resolved.\n` +
    `Failing closed to protect the live production tree.\n\n` +
    `To build for development, use a git worktree:\n\n` +
    `  git worktree add ../fancy-openclaw-linear-connector-<branch> <branch>\n` +
    `  cd ../fancy-openclaw-linear-connector-<branch> && npm run build\n\n` +
    `To build for deployment, set CONNECTOR_DEPLOY_BUILD=1.\n`
  );
  process.exit(1);
}

// If runtime tree can't be resolved, we can't confirm we're in it — allow.
if (!runtimeReal) process.exit(0);

// If we can determine cwdReal (we should), compare against the runtime tree.
if (cwdReal === runtimeReal) {
  console.error(
    `\nBUILD LOCATION GUARD: refusing to build in the live runtime tree.\n\n` +
    `Current directory resolves to the shared runtime tree:\n` +
    `  ${cwdReal}\n\n` +
    `Building here would overwrite the production dist/ while DEPLOY_COMMIT\n` +
    `still reports the last deployed commit. The running connector would be\n` +
    `running unreviewed code without any indication.\n\n` +
    `For development, create a git worktree:\n\n` +
    `  git worktree add ../fancy-openclaw-linear-connector-<branch> <branch>\n` +
    `  cd ../fancy-openclaw-linear-connector-<branch> && npm run build\n\n` +
    `To build for deployment, the deploy script sets CONNECTOR_DEPLOY_BUILD=1 automatically.\n`
  );
  process.exit(1);
}

// Also check if the resolved output dir (dist/) matches the runtime tree's dist/.
// This catches cases where cwd is a symlink that points into the runtime tree.
const outputDir = resolve(process.cwd(), 'dist');
const outputReal = resolveReal(outputDir);
const runtimeDist = resolve(RUNTIME_TREE, 'dist');
const runtimeDistReal = resolveReal(runtimeDist);

if (outputReal && runtimeDistReal && outputReal === runtimeDistReal) {
  console.error(
    `\nBUILD LOCATION GUARD: refusing to build in the live runtime tree.\n\n` +
    `The resolved build output directory matches the production dist/:\n` +
    `  ${outputReal}\n\n` +
    `For development, create a git worktree:\n\n` +
    `  git worktree add ../fancy-openclaw-linear-connector-<branch> <branch>\n` +
    `  cd ../fancy-openclaw-linear-connector-<branch> && npm run build\n\n` +
    `To build for deployment, set CONNECTOR_DEPLOY_BUILD=1.\n`
  );
  process.exit(1);
}

// None of the checks triggered — allow the build.
process.exit(0);
