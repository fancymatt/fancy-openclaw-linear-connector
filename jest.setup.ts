/**
 * Test-env isolation. The connector's production `.env` (loaded via
 * `import 'dotenv/config'` when tests import app modules) must never leak
 * deployment config into the suite. dotenv does NOT override variables that
 * already exist, so pinning these to "" here — before any test module loads —
 * keeps them falsy regardless of what `.env` or the host shell carries.
 *
 * Tests that need one of these set their own value in beforeAll/beforeEach.
 */
// dir-mode defs dir points at the prod instance-config path; tests build
// their own single-file defs via WORKFLOW_DEF_PATH fixtures. Pinned to ""
// (falsy) because it IS in .env and dotenv skips existing vars.
process.env.WORKFLOW_DEFS_DIR = "";

// A live token in the container/shell env changes linear-actionable behavior
// (previously worked around with `env -u LINEAR_OAUTH_TOKEN npm test`).
// Deleted rather than blanked — those tests distinguish unset from empty —
// and it is NOT in .env, so dotenv cannot re-add it.
delete process.env.LINEAR_OAUTH_TOKEN;
