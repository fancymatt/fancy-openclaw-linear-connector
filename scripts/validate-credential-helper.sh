#!/usr/bin/env bash
# validate-credential-helper.sh
#
# Validates that the Developer App credential helper is correctly wired
# in the container's global git config and can authenticate to private repos.
#
# Returns 0 = PASS (all checks pass), 1 = FAIL (any check fails)
#
# This is a test – it must FAIL (exit non-zero) before the config is fixed.
#
# Usage: AGENT_ID=tdd ./validate-credential-helper.sh
#
# AGENT_ID is required and must match the workspace directory name.

set -euo pipefail

PASS=0
FAIL=0
CONTAINER_HOME="${HOME}"
AGENT_ID="${AGENT_ID:-}"

if [ -z "${AGENT_ID}" ]; then
  echo "❌ AGENT_ID is required"
  echo "   Usage: AGENT_ID=tdd ./validate-credential-helper.sh"
  exit 1
fi

pass()  { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail()  { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

echo "=== Git Config Validation for ${AGENT_ID} ==="
echo "HOME: ${CONTAINER_HOME}"
echo

# ─── AC 1: ~/.gitconfig exists ──────────────────────────────────────────

GITCONFIG="${CONTAINER_HOME}/.gitconfig"
if [ -f "${GITCONFIG}" ]; then
  pass "~/.gitconfig exists"
else
  fail "~/.gitconfig does not exist"
fi

# ─── AC 2: credential.helper is set globally ─────────────────────────────

HELPER=$(git config --global credential.helper 2>/dev/null || true)
if [ -n "${HELPER}" ]; then
  pass "credential.helper is set globally"
else
  fail "credential.helper is not set globally"
fi

# ─── AC 3: credential.useHttpPath is true ────────────────────────────────

USE_HTTP_PATH=$(git config --global credential.useHttpPath 2>/dev/null || true)
if [ "${USE_HTTP_PATH}" = "true" ]; then
  pass "credential.useHttpPath is true"
else
  fail "credential.useHttpPath is not true (got: '${USE_HTTP_PATH}')"
fi

# ─── AC 4: Helper path points to THIS agent's workspace, not another ───
#
# The helper must live under ~/.openclaw/workspace/<agent-id>/.secrets/
# NOT under another agent's workspace (e.g. igor's).
#
# This test FAILS when miswired across containers (current state for tdd:
# gitconfig points at igor's workspace path instead of its own).

WORKSPACE_PREFIX="/.openclaw/workspace/${AGENT_ID}/.secrets/"
if echo "${HELPER}" | grep -qF "${WORKSPACE_PREFIX}"; then
  pass "Helper path points to this agent's own workspace (.openclaw/workspace/${AGENT_ID}/.secrets/)"
else
  fail "Helper path does NOT point to this agent's own workspace"
  echo "      Expected prefix: ...${WORKSPACE_PREFIX}"
  echo "      Actual helper:   ${HELPER}"
fi

# ─── AC 5: Helper script exists and is executable ────────────────────────

# Extract the script path from the credential helper config
# Format: !/path/to/script.sh  (git's shell-command syntax)
HELPER_SCRIPT=$(echo "${HELPER}" | sed 's/^!//')

if [ -x "${HELPER_SCRIPT}" ]; then
  pass "Helper script exists and is executable: ${HELPER_SCRIPT}"
else
  fail "Helper script missing or not executable: ${HELPER_SCRIPT}"
fi

# ─── AC 6: Helper can mint a token for a private repo ────────────────────
#
# This exercises the full credential path: help script → Python JWT →
# 1Password SA token → GitHub App API. If any link is broken, "git credential
# fill" will return nothing and the test fails.

TOKEN_OUTPUT=$(printf 'protocol=https\nhost=github.com\npath=fancyfleet/gen\n\n' \
  | bash "${HELPER_SCRIPT}" get 2>&1 || true)

if echo "${TOKEN_OUTPUT}" | grep -q "^password="; then
  pass "Helper returns a token for fancyfleet/gen (private repo)"
  TOKEN=$(echo "${TOKEN_OUTPUT}" | sed -n 's/^password=//p')
else
  fail "Helper did NOT return a token for fancyfleet/gen"
  TOKEN=""
fi

# ─── AC 7: Token covers repos the agent needs ────────────────────────────
#
# Verify the installation actually includes repos by querying the API.
# This catches scoping bugs where the App installation exists but is empty.

if [ -n "${TOKEN}" ]; then
  INSTALL_REPO_COUNT=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
    https://api.github.com/installation/repositories 2>/dev/null \
    | jq -r '.total_count' 2>/dev/null || echo "0")

  if [ "${INSTALL_REPO_COUNT}" -gt 0 ]; then
    pass "Installation returns repos (count: ${INSTALL_REPO_COUNT})"
  else
    fail "Installation returned 0 repos — may be mis-scoped"
  fi
fi

# ─── AC 8: Git can actually use the helper for fetch ─────────────────────
#
# End-to-end: git fetch --dry-run on a private repo. This is the true test
# that all layers (git config → credential helper → GitHub App → repo read)
# are working together.

WORKDIR=$(mktemp -d)
trap "rm -rf ${WORKDIR}" EXIT

git clone --depth 1 https://github.com/fancyfleet/gen.git "${WORKDIR}/gen-check" 2>/dev/null && {
  pass "git clone (HTTPS) works for fancyfleet/gen (private repo)"
} || {
  fail "git clone (HTTPS) failed for fancyfleet/gen (private repo)"
}

echo
echo "=== Result ==="
if [ "${FAIL}" -eq 0 ]; then
  echo "🎉 All ${PASS} tests passed!"
  exit 0
else
  echo "⚠️  ${FAIL} test(s) failed, ${PASS} passed"
  exit 1
fi
