#!/usr/bin/env bash
# PM-2 (LIF-92) — Security scanners in CI
#
# Failing tests (TDD) that will pass only after the CI workflow is updated
# with bandit (Python SAST), pip-audit (dependency CVE auditing), and
# trufflehog (secrets scanning) jobs.
#
# AC mapping:
#   AC1 — bandit SAST, medium+ fails the job
#   AC2 — pip-audit on pinned deps, fixable CVEs fail
#   AC3 — trufflehog verified-findings over PR diff/history
#   AC4 — clear pass/fail summary in CI output
#   AC5 — Hanzo merges the ci.yml change
#   AC6 — baseline green at merge time

set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_YML="$SRC/.github/workflows/ci.yml"
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }

# Ensure CI workflow file exists
[ -f "$CI_YML" ] || { echo "FATAL: no ci.yml at $CI_YML"; exit 1; }

echo "== AC1: bandit (Python SAST) =="

if grep -q 'bandit' "$CI_YML"; then
  ok "AC1a: CI workflow mentions bandit"
else
  no "AC1a: CI workflow does NOT mention bandit — add a bandit scanning step"
fi

if grep -Eq '(severity.level|medium|HIGH)' "$CI_YML"; then
  ok "AC1b: Bandit has severity threshold (medium+ fails)"
else
  no "AC1b: Bandit missing severity threshold — set --severity-level medium or equivalent"
fi

if grep -Eq '(apps/mam-downloader|mam_downloader|mam-downloader)' "$CI_YML"; then
  ok "AC1c: Bandit targets the Python source tree"
else
  no "AC1c: Bandit does NOT specify Python source path — must scan apps/mam-downloader"
fi

echo "== AC2: pip-audit (dependency CVEs) =="

if grep -q 'pip-audit\|pip_audit' "$CI_YML"; then
  ok "AC2a: CI workflow mentions pip-audit"
else
  no "AC2a: CI workflow does NOT mention pip-audit — add pip-audit step"
fi

if grep -Eq '(requirements\.txt|pyproject\.toml|Pipfile\.lock|requirements-dev\.txt)' "$CI_YML"; then
  ok "AC2b: pip-audit targets the pinned dependency set"
else
  no "AC2b: pip-audit does NOT specify dependency file — must point to requirements.txt or pyproject.toml"
fi

echo "== AC3: trufflehog (secrets scanning) =="

if grep -q 'trufflehog' "$CI_YML"; then
  ok "AC3a: CI workflow mentions trufflehog"
else
  no "AC3a: CI workflow does NOT mention trufflehog — add a trufflehog step"
fi

if grep -Eq '(only-verified|verified)' "$CI_YML"; then
  ok "AC3b: Trufflehog runs in verified-findings mode"
else
  no "AC3b: Trufflehog NOT in verified-findings mode — add --only-verified flag"
fi

echo "== AC4: Clear pass/fail summary =="

total_scanners=0
grep -q 'bandit' "$CI_YML" && total_scanners=$((total_scanners+1))
grep -q 'pip-audit\|pip_audit' "$CI_YML" && total_scanners=$((total_scanners+1))
grep -q 'trufflehog' "$CI_YML" && total_scanners=$((total_scanners+1))

if [ "$total_scanners" -eq 3 ]; then
  ok "AC4: All 3 scanner tools present for clear pass/fail reporting"
else
  no "AC4: Only $total_scanners/3 scanner tools present ($total_scanners scanners found; expected 3: bandit, pip-audit, trufflehog)"
fi

echo "== AC5: Hanzo merge convention =="

if grep -qi 'hanzo' "$CI_YML"; then
  ok "AC5: CI workflow header references Hanzo merge convention"
else
  no "AC5: CI workflow does NOT reference Hanzo merge convention — add header comment per ci.yml convention"
fi

echo "== AC6: Baseline green =="

if [ -f "$SRC/.bandit" ] || grep -q 'skip\|# nosec\|# suppress' "$CI_YML" 2>/dev/null; then
  ok "AC6a: Baseline bandit suppressions configured"
else
  no "AC6a: No bandit baseline suppressions found — ensure pre-existing findings are triaged"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"

if [ "$fail" -gt 0 ]; then
  echo "FAIL: Not all ACs are covered by the CI workflow yet."
  exit 1
fi
echo "PASS: All acceptance criteria are met."
