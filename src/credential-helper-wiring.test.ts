/**
 * credential-helper-wiring.test.ts — AI-2272
 *
 * Validates that the Developer App credential helper is correctly wired
 * in each dev container's global git config.
 *
 * These tests are infrastructure-level validation — they shell out to
 * scripts/validate-credential-helper.sh which performs 8 distinct checks
 * covering the credential path from git config → credential helper →
 * GitHub App installation token → end-to-end git operation.
 *
 * All tests in this file MUST RED before the fix is applied.
 * (Current state: tdd/felix/noah/sage containers have helper files but
 *  their ~/.gitconfig points to igor's workspace path or is unwired.)
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'validate-credential-helper.sh');
const AGENT_ID = process.env['AGENT_ID'];

describe('AI-2272: Container git credential helper wiring', () => {
  beforeAll(() => {
    if (!AGENT_ID) {
      throw new Error(
        'AGENT_ID env var is required. Run: AGENT_ID=tdd npx jest credential-helper-wiring'
      );
    }
  });

  describe('AC 1-8: validate-credential-helper.sh passes all checks', () => {
    test('script exists', () => {
      expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    });

    test('script is executable', () => {
      const stat = fs.statSync(SCRIPT_PATH);
      // Check executable bit for owner
      expect((stat.mode & 0o100)).toBe(0o100);
    });

    test(`all 8 checks pass for ${AGENT_ID}`, () => {
      const result = cp.spawnSync(SCRIPT_PATH, [], {
        env: { ...process.env, AGENT_ID },
        cwd: path.dirname(SCRIPT_PATH),
        timeout: 60_000,
        encoding: 'utf-8',
      });

      // Print full output for debugging
      console.log(result.stdout);

      if (result.status !== 0) {
        // This is the RED test — must fail before the fix is applied.
        // Print stderr too
        if (result.stderr) {
          console.error(result.stderr);
        }
      }

      expect(result.status).toBe(0);
    }, 70_000);
  });
});
