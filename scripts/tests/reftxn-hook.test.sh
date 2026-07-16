#!/usr/bin/env bash
# AI-2481 item 1 — comprehensive regression test for the out-of-tree HEAD-veto
# hook + self-gating arm script. Uses the REAL scripts from /tmp/conn-fix.
# Each case runs in its own fresh fixture so a vetoed op's working-tree tear
# cannot corrupt a later assertion.
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }

# new_fixture: c_pre (no hook) -> c_hook (has hook), armed out-of-tree. Prints T.
new_fixture(){
  local T; T=$(mktemp -d)
  ( cd "$T"
    git init -q; git config user.email t@t; git config user.name t; git config commit.gpgsign false
    echo pre > marker.txt; git add marker.txt; git commit -qm c_pre
    mkdir -p scripts/git-hooks
    cp "$SRC/scripts/git-hooks/reference-transaction" scripts/git-hooks/; chmod +x scripts/git-hooks/reference-transaction
    cp "$SRC/scripts/connector-reftxn-arm.sh" scripts/; chmod +x scripts/connector-reftxn-arm.sh
    echo hook > marker.txt; git add .; git commit -qm c_hook
    bash scripts/connector-reftxn-arm.sh --force >/dev/null 2>&1
  )
  echo "$T"
}

echo "== arm mechanics =="
T=$(new_fixture)
[ -e "$T/.git/hooks/reference-transaction" ] && ok "arm installs hook out-of-tree (.git/hooks)" || no "arm did NOT install out-of-tree"
[ -z "$(git -C "$T" config --local --get core.hooksPath || true)" ] && ok "core.hooksPath left unset" || no "core.hooksPath set (should be unset)"
rm -rf "$T"

echo "== ACCEPTANCE: yank onto a PRE-hook commit while armed (Ai's live repro) =="
T=$(new_fixture); C_PRE=$(git -C "$T" rev-parse HEAD~1); C_HOOK=$(git -C "$T" rev-parse HEAD)
( cd "$T"; git checkout --detach "$C_PRE" >/dev/null 2>&1 )
[ "$(git -C "$T" rev-parse HEAD)" = "$C_HOOK" ] && ok "YANK VETOED: HEAD unmoved (bug fixed — hook survives checkout onto pre-hook commit)" || no "YANK SUCCEEDED: HEAD moved — NOT fixed"
# working tree was swapped by git before the veto, but HEAD intact → recoverable
( cd "$T"; git reset --hard HEAD >/dev/null 2>&1 )
[ "$(cat "$T/marker.txt")" = "hook" ] && ok "recovery: git reset --hard HEAD restores working tree (HEAD preserved)" || no "recovery failed"
rm -rf "$T"

echo "== amend must be ALLOWED =="
T=$(new_fixture)
( cd "$T"; echo x >> marker.txt; git add marker.txt; git commit --amend --no-edit -q >/dev/null 2>&1 )
[ $? -eq 0 ] && ok "amend ALLOWED" || no "amend VETOED (regression)"
rm -rf "$T"

echo "== forward commit must be ALLOWED =="
T=$(new_fixture)
( cd "$T"; echo y >> marker.txt; git add marker.txt; git commit -qm forward >/dev/null 2>&1 )
[ $? -eq 0 ] && ok "forward commit ALLOWED" || no "forward commit VETOED (regression)"
rm -rf "$T"

echo "== reset --hard onto an OLDER commit must be VETOED (HEAD preserved) =="
T=$(new_fixture)
( cd "$T"; echo z >> marker.txt; git add marker.txt; git commit -qm c2 )
top=$(git -C "$T" rev-parse HEAD)
( cd "$T"; git reset --hard HEAD~1 >/dev/null 2>&1 )
[ "$(git -C "$T" rev-parse HEAD)" = "$top" ] && ok "reset --hard onto older VETOED (HEAD unmoved)" || no "reset --hard onto older SUCCEEDED (should veto)"
rm -rf "$T"

echo "== worktree-internal detach must be ALLOWED (hook early-exits for linked worktrees) =="
T=$(new_fixture); C_PRE=$(git -C "$T" rev-parse HEAD~1)
git -C "$T" worktree add -q "$T/wt" -b wtb >/dev/null 2>&1
( cd "$T/wt"; git checkout --detach "$C_PRE" >/dev/null 2>&1 )
[ "$(git -C "$T/wt" rev-parse HEAD)" = "$C_PRE" ] && ok "worktree-internal detach ALLOWED" || no "worktree-internal detach VETOED (regression)"
rm -rf "$T"

echo "== disarm removes the hook; control yank then succeeds =="
T=$(new_fixture); C_PRE=$(git -C "$T" rev-parse HEAD~1)
( cd "$T"; bash scripts/connector-reftxn-arm.sh --disarm >/dev/null 2>&1 )
[ -e "$T/.git/hooks/reference-transaction" ] && no "disarm did NOT remove hook" || ok "disarm removed hook"
( cd "$T"; git checkout --detach "$C_PRE" >/dev/null 2>&1 )
[ "$(git -C "$T" rev-parse HEAD)" = "$C_PRE" ] && ok "control: disarmed → yank succeeds" || no "control: disarmed yank still blocked?!"
rm -rf "$T"

echo "== legacy migration: an old in-tree core.hooksPath is cleared on arm =="
T=$(new_fixture)
git -C "$T" config --local core.hooksPath scripts/git-hooks   # simulate the old broken arming
( cd "$T"; bash scripts/connector-reftxn-arm.sh --force >/dev/null 2>&1 )   # already armed → refresh path
[ -z "$(git -C "$T" config --local --get core.hooksPath || true)" ] && ok "legacy in-tree core.hooksPath cleared" || no "legacy core.hooksPath NOT cleared"
rm -rf "$T"

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
