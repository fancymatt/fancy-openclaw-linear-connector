#!/usr/bin/env bash
# AI-2481 / INF-17 — comprehensive regression test for the out-of-tree HEAD-veto
# hook + self-gating arm script. Runs the REAL scripts from this repo checkout.
# Each case runs in its own fresh fixture so a vetoed op's working-tree tear
# cannot corrupt a later assertion. INF-17 added the ATOMIC-veto assertions below:
# a veto must leave the index + working tree exactly as before, and its scoped
# self-restore must not clobber a concurrent session's unstaged edit.
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

echo "== ACCEPTANCE (INF-17): yank onto a PRE-hook commit is VETOED and ATOMIC =="
T=$(new_fixture); C_PRE=$(git -C "$T" rev-parse HEAD~1); C_HOOK=$(git -C "$T" rev-parse HEAD)
( cd "$T"; git checkout --detach "$C_PRE" >/dev/null 2>&1 )
[ "$(git -C "$T" rev-parse HEAD)" = "$C_HOOK" ] && ok "YANK VETOED: HEAD unmoved (hook survives checkout onto pre-hook commit)" || no "YANK SUCCEEDED: HEAD moved — NOT fixed"
# INF-17: the veto must be ATOMIC — NO manual recovery. git swapped the index +
# worktree to the target before the veto; the aborted-phase self-restore must have
# already put them back at HEAD, with nothing left staged from the target ref.
[ "$(cat "$T/marker.txt")" = "hook" ] && ok "atomic: working tree already restored to HEAD (no manual recovery)" || no "atomic FAIL: working tree left swapped to foreign content"
[ -z "$(git -C "$T" status --porcelain)" ] && ok "atomic: index + tree clean — nothing left staged after veto" || no "atomic FAIL: veto left residue: $(git -C "$T" status --porcelain | tr '\n' '|')"
rm -rf "$T"

echo "== ACCEPTANCE (INF-17): atomic restore is SCOPED — a concurrent UNSTAGED edit survives =="
# Session A holds an unstaged WIP edit to a file the yank does NOT swap (identical
# between HEAD and the target). The scoped restore (staged delta only) must leave
# A's edit intact — a blanket `git restore .` would clobber it.
T=$(new_fixture)
( cd "$T"
  echo shared > bystander.txt; git add bystander.txt; git commit -qm add-bystander
  echo changed > marker.txt;   git add marker.txt;    git commit -qm change-marker
  TARGET=$(git rev-parse HEAD~1)                  # old marker + identical bystander
  echo SESSION-A-WIP > bystander.txt              # concurrent UNSTAGED edit
  git checkout --detach "$TARGET" >/dev/null 2>&1 # vetoed + auto-restored (scoped)
)
[ "$(cat "$T/bystander.txt")" = "SESSION-A-WIP" ] && ok "scoped restore PRESERVED concurrent unstaged edit" || no "scoped restore CLOBBERED concurrent unstaged edit (blanket-restore bug)"
[ "$(cat "$T/marker.txt")" = "changed" ] && ok "swapped file restored to HEAD" || no "swapped file NOT restored"
[ "$(git -C "$T" status --porcelain | grep -v ' bystander.txt$' | grep -c .)" = "0" ] && ok "no foreign staged residue (besides the preserved WIP)" || no "unexpected residue: $(git -C "$T" status --porcelain | tr '\n' '|')"
rm -rf "$T"

echo "== ACCEPTANCE (INF-17): atomic restore is SCOPED — a concurrent STAGED edit survives =="
# Mirror of the unstaged case. Session A has a STAGED edit to a file the yank does
# NOT swap. checkout carries that staged edit across, so it lands in the staged
# delta vs HEAD alongside the swap — but it is NOT in the swap set (head_old..
# head_new). The scoped restore must leave it staged and intact. Restoring the whole
# staged delta (the pre-fix behavior) destroys it with no recoverable ref — the exact
# regression this AC closes.
T=$(new_fixture)
( cd "$T"
  echo shared > bystander.txt; git add bystander.txt; git commit -qm add-bystander
  echo changed > marker.txt;   git add marker.txt;    git commit -qm change-marker
  TARGET=$(git rev-parse HEAD~1)                  # old marker + identical bystander
  echo SESSION-A-STAGED > bystander.txt; git add bystander.txt   # concurrent STAGED edit
  git checkout --detach "$TARGET" >/dev/null 2>&1 # vetoed + auto-restored (scoped)
)
[ "$(git -C "$T" show :bystander.txt 2>/dev/null)" = "SESSION-A-STAGED" ] && ok "scoped restore PRESERVED concurrent STAGED edit (index)" || no "scoped restore DESTROYED concurrent staged edit (INF-17 regression)"
[ "$(cat "$T/bystander.txt")" = "SESSION-A-STAGED" ] && ok "concurrent staged edit intact in worktree" || no "concurrent staged edit lost from worktree"
[ "$(cat "$T/marker.txt")" = "changed" ] && ok "swapped file restored to HEAD (staged sibling preserved)" || no "swapped file NOT restored"
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
