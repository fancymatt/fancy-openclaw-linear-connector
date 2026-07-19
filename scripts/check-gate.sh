#!/usr/bin/env bash
# check-gate.sh — Evaluate a PR against the merge gate with baseline-diff awareness.
#
# Compares PR check runs against the base branch (main) baseline. Failures
# present on both the PR head AND main are reported as pre-existing/informational
# and do NOT block the merge. Failures present only on the PR head (new failures)
# block the merge.
#
# Also supports a --skip-known-failures waiver path: explicitly list check names
# that are known to fail on main as a manual override when baseline comparison
# is not possible (e.g., main CI hasn't run recently).
#
# Usage:
#   check-gate.sh <owner/repo> <pr_number> [--skip-known-failures "Check1,Check2"]
#
# Exit codes:
#   0 — gate passed (all checks clean, or only pre-existing failures)
#   1 — gate blocked (new failures introduced, dirty, or protection blocked)
#   2 — infrastructure/access error

set -euo pipefail

REPO="${1:-}"
PR="${2:-}"
SKIP_KNOWN_FAILURES=""

# Parse optional flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-known-failures)
      SKIP_KNOWN_FAILURES="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$REPO" || -z "$PR" ]]; then
  echo "Usage: check-gate.sh <owner/repo> <pr_number> [--skip-known-failures \"Check1,Check2\"]" >&2
  exit 2
fi

ORG="${REPO%%/*}"

# ── Resolve GitHub App credentials ──────────────────────────────────────
OP_VAULT="${HANZO_GH_OP_VAULT:-OpenClaw Agent - Hanzo}"
OP_ITEM="${HANZO_GH_OP_ITEM:-Hanzo Merge Gate (GitHub App)}"
opf() { op item get "$OP_ITEM" --vault "$OP_VAULT" --fields "label=$1" --reveal; }
GITHUB_APP_ID="$(opf app-id)"
GITHUB_APP_PRIVATE_KEY_B64="$(opf private-key | base64 -w0)"
export GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY_B64

case "$ORG" in
  fancymatt)  INST_LABEL="installation-fancymatt"  ;;
  Loafsoft)   INST_LABEL="installation-loafsoft"   ;;
  beardbird)  INST_LABEL="installation-beardbird"  ;;
  fancyfleet) INST_LABEL="installation-fancyfleet" ;;
  *)
    echo "Unknown org '$ORG' — no installation ID mapped." >&2
    exit 2
    ;;
esac

INST_ID="$(opf "$INST_LABEL")"

# Generate an installation token for gate evaluation.
# The App has `checks:read` scope (added by Matt 2026-07-19 01:31Z).
GH_TOKEN=$(GITHUB_INSTALLATION_ID="$INST_ID" node /usr/local/bin/gen-github-token.js)
export GH_TOKEN="$GH_TOKEN"

# ── Step 1: Fetch PR details ────────────────────────────────────────────
echo "==> Gate check for ${REPO}#${PR}"
PR_JSON=$(gh pr view "$PR" --repo "$REPO" --json headRefOid,baseRefName,headRefName,mergeable,mergeStateStatus,state,title 2>&1) || {
  echo "ERROR: Cannot fetch PR #${PR} from ${REPO}" >&2
  echo "$PR_JSON" >&2
  exit 2
}

HEAD_SHA=$(echo "$PR_JSON" | jq -r '.headRefOid')
BASE_REF=$(echo "$PR_JSON" | jq -r '.baseRefName')
HEAD_REF=$(echo "$PR_JSON" | jq -r '.headRefName')
MERGEABLE=$(echo "$PR_JSON" | jq -r '.mergeable')
MSS=$(echo "$PR_JSON" | jq -r '.mergeStateStatus')
PR_TITLE=$(echo "$PR_JSON" | jq -r '.title')

echo "  PR:        #${PR} — ${PR_TITLE}"
echo "  Head:      ${HEAD_REF} @ ${HEAD_SHA:0:12}"
echo "  Base:      ${BASE_REF}"
echo "  Mergeable: ${MERGEABLE}  |  mergeStateStatus: ${MSS}"
echo ""

# ── Step 2: Check mergeStateStatus for non-CI issues ───────────────────
if [[ "$MSS" == "DIRTY" ]]; then
  echo "❌ BLOCKED: mergeStateStatus=DIRTY (merge conflict)."
  echo "   Not a CI issue — needs conflict resolution. Route to cra."
  echo "GATE_RESULT=BLOCKED_DIRTY"
  exit 1
fi

if [[ "$MSS" == "BLOCKED" ]]; then
  echo "❌ BLOCKED: mergeStateStatus=BLOCKED (branch protection)."
  echo "   Likely missing required reviews or failing required checks."
  echo "   Route to cra."
  echo "GATE_RESULT=BLOCKED_PROTECTION"
  exit 1
fi

if [[ "$MSS" == "CLEAN" ]]; then
  echo "✅ mergeStateStatus=CLEAN — gate passed."
  echo "GATE_RESULT=PASS"
  exit 0
fi

# ── Step 3: Fetch check runs for PR head commit ────────────────────────
echo "==> Fetching check runs for PR head commit ${HEAD_SHA:0:12}..."
PR_CHECKS=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" --paginate 2>&1) || {
  echo "WARNING: Could not fetch check runs for head commit." >&2
  echo "  Falling back to mergeStateStatus-based evaluation." >&2
  if [[ "$MSS" == "UNSTABLE" ]]; then
    echo "  mergeStateStatus=UNSTABLE — blocking (cannot evaluate baseline)." >&2
    echo "GATE_RESULT=BLOCKED_NO_CHECK_ACCESS"
    exit 1
  fi
  echo "GATE_RESULT=PASS_FALLBACK"
  exit 0
}

# ── Step 4: Fetch check runs for base branch ────────────────────────────
echo "==> Fetching latest check runs for base branch '${BASE_REF}'..."
BASE_CHECKS=$(gh api "repos/${REPO}/commits/${BASE_REF}/check-runs" --paginate 2>&1) || {
  echo "WARNING: Could not fetch check runs for base branch." >&2
  echo "  Cannot establish baseline. Will evaluate without one." >&2
  BASE_CHECKS_EMPTY=true
}

# ── Step 5: Build baseline failure set ──────────────────────────────────
echo ""
echo "==> Analyzing baseline failures..."

declare -A BASELINE_FAILURES

if [[ -z "${BASE_CHECKS_EMPTY:-}" ]]; then
  while IFS=$'\x1f' read -r name conclusion; do
    if [[ -n "$name" ]]; then
      BASELINE_FAILURES["$name"]="$conclusion"
    fi
  done < <(echo "$BASE_CHECKS" | jq -r '
    .check_runs // [] | .[]
    | select(.status == "completed" and .conclusion != "success"
         and .conclusion != "skipped" and .conclusion != "neutral")
    | "\(.name)\u001f\(.conclusion)"
  ' 2>/dev/null || echo "")

  if [[ ${#BASELINE_FAILURES[@]} -eq 0 ]]; then
    echo "  ✅ No pre-existing failures detected on ${BASE_REF}."
  else
    echo "  ⚠️  Pre-existing failures on ${BASE_REF}:"
    for name in "${!BASELINE_FAILURES[@]}"; do
      echo "     - ${name} (${BASELINE_FAILURES[$name]})"
    done
  fi
else
  echo "  ⚠️  Could not check base branch — all PR failures treated as new."
fi

# Apply --skip-known-failures waiver (AC2)
if [[ -n "$SKIP_KNOWN_FAILURES" ]]; then
  echo ""
  echo "==> Applying --skip-known-failures waiver:"
  IFS=',' read -ra KF <<< "$SKIP_KNOWN_FAILURES"
  for kf in "${KF[@]}"; do
    kf_trimmed="$(echo "$kf" | xargs)"
    if [[ -n "$kf_trimmed" ]]; then
      BASELINE_FAILURES["$kf_trimmed"]="known-failure"
      echo "  ➕ Added to baseline: ${kf_trimmed} (waiver)"
    fi
  done
fi

# ── Step 6: Classify PR check results ──────────────────────────────────
echo ""
echo "==> Analyzing PR check runs..."

NEW_FAILURES=()
PRE_EXISTING=()
PASSING_COUNT=0
INCOMPLETE=()

while IFS=$'\x1f' read -r name conclusion status html_url; do
  if [[ -z "$name" ]]; then continue; fi
  
  if [[ "$status" != "completed" ]]; then
    INCOMPLETE+=("$name (${status})")
    continue
  fi
  
  if [[ "$conclusion" == "success" || "$conclusion" == "skipped" || "$conclusion" == "neutral" ]]; then
    PASSING_COUNT=$((PASSING_COUNT + 1))
  elif [[ -n "${BASELINE_FAILURES[$name]:-}" ]]; then
    PRE_EXISTING+=("$name (${conclusion})")
  else
    NEW_FAILURES+=("$name (${conclusion})")
  fi
done < <(echo "$PR_CHECKS" | jq -r '
  .check_runs // [] | .[]
  | "\(.name)\u001f\(.conclusion // "unknown")\u001f\(.status)\u001f\(.html_url // "")"
' 2>/dev/null || echo "")

# Report results
echo ""
echo "  ✅ Passing checks: ${PASSING_COUNT}"
echo "  ℹ️  Pre-existing (not blocking): ${#PRE_EXISTING[@]}"
echo "  ❌ New failures (blocking): ${#NEW_FAILURES[@]}"
[[ ${#INCOMPLETE[@]} -gt 0 ]] && echo "  ⏳ Incomplete: ${#INCOMPLETE[@]}"

if [[ ${#PRE_EXISTING[@]} -gt 0 ]]; then
  echo ""
  echo "  Pre-existing failures (from main baseline or waiver):"
  for f in "${PRE_EXISTING[@]}"; do
    echo "     ℹ️  ${f}"
  done
fi

if [[ ${#NEW_FAILURES[@]} -gt 0 ]]; then
  echo ""
  echo "  NEW failures (introduced by this PR):"
  for f in "${NEW_FAILURES[@]}"; do
    echo "     ❌ ${f}"
  done
fi

# Structured summary for skip-log
echo ""
echo "---"
echo "BASELINE_SUMMARY: pre_existing=${#PRE_EXISTING[@]} new=${#NEW_FAILURES[@]} incomplete=${#INCOMPLETE[@]}"
echo "---"

# ── Step 7: Gate decision ──────────────────────────────────────────────
if [[ ${#INCOMPLETE[@]} -gt 0 ]]; then
  echo ""
  echo "⏳ GATE INCOMPLETE: ${#INCOMPLETE[@]} check(s) still running — cannot decide yet."
  echo "   Re-run this check when CI settles."
  echo "GATE_RESULT=INCOMPLETE"
  exit 1
fi

if [[ ${#NEW_FAILURES[@]} -gt 0 ]]; then
  echo ""
  echo "❌ GATE BLOCKED: ${#NEW_FAILURES[@]} new failure(s) introduced by this PR."
  echo "   Pre-existing failures (${#PRE_EXISTING[@]}) are informational only."
  echo "   Route to cra for failing-check disposition."
  echo "GATE_RESULT=BLOCKED_NEW_FAILURES"
  exit 1
fi

echo ""
echo "✅ GATE PASSED — all checks clean or pre-existing only."
echo "GATE_RESULT=PASS"
exit 0