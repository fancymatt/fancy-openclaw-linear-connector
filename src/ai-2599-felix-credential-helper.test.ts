/**
 * AI-2599 — Felix Developer App credential helper wiring.
 *
 * These are container-environment tests. They intentionally assert Felix's
 * global git config and then run the existing 8-check validator with
 * AGENT_ID=felix. They should be red until Felix's container is wired.
 */

import * as cp from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-credential-helper.sh');
const FELIX_HELPER = '!/home/node/.openclaw/workspace/felix/.secrets/gh-app-helper-venv.sh';

const run = (command: string, args: string[], env = process.env) =>
  cp.spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 70_000,
  });

describe('AI-2599: Felix Developer App git credential helper', () => {
  test('AC: Felix global git config uses the Developer App helper and HTTP path scoping', () => {
    const helper = run('git', ['config', '--global', 'credential.helper']);
    const useHttpPath = run('git', ['config', '--global', 'credential.useHttpPath']);

    expect(helper.status).toBe(0);
    expect(helper.stdout.trim()).toBe(FELIX_HELPER);
    expect(useHttpPath.status).toBe(0);
    expect(useHttpPath.stdout.trim()).toBe('true');
  });

  test('AC: Felix passes all 8 credential-helper validation checks', () => {
    const result = run('bash', [VALIDATOR], { AGENT_ID: 'felix' });

    console.log(result.stdout);
    if (result.stderr) {
      console.error(result.stderr);
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All 8 tests passed');
  }, 80_000);
});
