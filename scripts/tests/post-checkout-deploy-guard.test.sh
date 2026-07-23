#!/usr/bin/env bash
set -uo pipefail

pass=0
fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }

GUARD_SCRIPT="${GUARD_SCRIPT_PATH:-scripts/git-hooks/post-checkout-deploy-guard}"

if [ ! -f "$GUARD_SCRIPT" ]; then
  echo "FATAL: guard script not found at $GUARD_SCRIPT"
  exit 1
fi

echo "Testing deploy checkout guard at: $GUARD_SCRIPT"
echo ""

if grep -q 'GUARD_VERSION="INF-411.2026.07.23"' "$GUARD_SCRIPT"; then
  ok "guard version records INF-411 provenance"
else
  no "guard version was not bumped for INF-411"
fi

if grep -q 'git rev-parse origin/main' "$GUARD_SCRIPT" && grep -q 'git checkout --quiet --detach origin/main' "$GUARD_SCRIPT"; then
  ok "guard allows and restores to detached origin/main"
else
  no "guard does not use detached origin/main as the deploy invariant"
fi

if grep -q 'release-1.4' "$GUARD_SCRIPT"; then
  no "guard still references release-1.4"
else
  ok "guard no longer references release-1.4"
fi

if grep -q 'Branch checkout blocked' "$GUARD_SCRIPT" && grep -q 'must remain detached at origin/main' "$GUARD_SCRIPT"; then
  ok "branch checkout rejection explains the origin/main invariant"
else
  no "branch checkout rejection does not describe the origin/main invariant"
fi

echo ""
echo "========================"
echo " $pass passed, $fail failed"
echo "========================"
[ "$fail" -eq 0 ]
