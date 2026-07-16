#!/usr/bin/env bash
set -euo pipefail
#
# connector-reftxn-arm.sh — arm/disarm the primary-tree HEAD-veto hook in the
# SHARED connector clone (AI-2481). Self-gating on quiescence.
#
# Arming means installing scripts/git-hooks/reference-transaction OUT OF THE
# WORKING TREE, into <git-common-dir>/hooks/reference-transaction (git's default
# hook location), and leaving core.hooksPath UNSET. From that instant, a
# detached checkout or a sideways/backward `git reset` in the PRIMARY working
# tree is refused (see the hook header for the exact allow/deny matrix).
#
# WHY OUT OF TREE (AI-2481, the flaw that made the first cut fail open): the hook
# used to be armed via core.hooksPath=scripts/git-hooks — a path INSIDE the
# working tree. But `git checkout` updates the working tree BEFORE the ref
# transaction fires, so detaching onto any commit that predates the hook DELETES
# the hook file before it can veto, and the transaction proceeds unhooked. That
# fails open on exactly the case the hook exists to stop. The default hook dir
# (<git-common-dir>/hooks) is untracked and immune to tree swaps, so the hook
# survives any checkout and always runs. We COPY the committed hook there on each
# arm (so it can never go stale relative to source), and disarm by deleting it.
#
# WHY THIS IS GATED: arming while a session is mid-checkout would abort that
# session's in-flight git command (non-destructively — the transaction aborts
# before the working tree is touched — but still disruptive). AI-2475 was closed
# WITHOUT arming precisely because the reflog showed sessions active within the
# prior 9 minutes. So this script REFUSES to arm unless the shared clone's HEAD
# reflog has been quiet for --quiet-min minutes (default 15). It is safe to run
# repeatedly (e.g. from cron or by hand) until it catches a quiescent window.
#
# Usage:
#   connector-reftxn-arm.sh              # arm if quiescent, else refuse
#   connector-reftxn-arm.sh --quiet-min N
#   connector-reftxn-arm.sh --force      # arm now, bypassing the quiescence gate (human)
#   connector-reftxn-arm.sh --status     # report armed/disarmed + last activity
#   connector-reftxn-arm.sh --disarm     # remove the installed hook

QUIET_MIN=15
MODE="arm"
FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet-min) QUIET_MIN="${2:?--quiet-min needs a number}"; shift 2 ;;
    --force)     FORCE="1"; shift ;;
    --status)    MODE="status"; shift ;;
    --disarm)    MODE="disarm"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Operate on the MAIN working tree of the clone this script lives in.
REPO_ROOT="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
HOOK_SRC="$REPO_ROOT/scripts/git-hooks/reference-transaction"

# Absolute default hook dir. --git-common-dir may be relative to REPO_ROOT; the
# default (unset core.hooksPath) hook dir is <common>/hooks, shared across every
# linked worktree — which is why the in-hook worktree early-exit must (and does)
# key off --absolute-git-dir, not off which hooks dir ran it.
GIT_COMMON_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir)"
case "$GIT_COMMON_DIR" in
  /*) : ;;
  *)  GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR" ;;
esac
HOOK_DST="$GIT_COMMON_DIR/hooks/reference-transaction"

is_armed() { [ -e "$HOOK_DST" ]; }

# Legacy: the first (broken) cut armed via core.hooksPath=scripts/git-hooks. If a
# clone still carries that, clear it — the whole point is to NOT depend on an
# in-tree hooks path. Harmless when already unset.
clear_legacy_hookspath() {
  local hp
  hp="$(git -C "$REPO_ROOT" config --local --get core.hooksPath 2>/dev/null || true)"
  if [ "$hp" = "scripts/git-hooks" ]; then
    git -C "$REPO_ROOT" config --local --unset core.hooksPath 2>/dev/null || true
    echo "  (cleared legacy in-tree core.hooksPath=scripts/git-hooks)"
  fi
}

install_hook() {
  mkdir -p "$GIT_COMMON_DIR/hooks"
  local tmp="$HOOK_DST.tmp.$$"
  cp "$HOOK_SRC" "$tmp"
  chmod +x "$tmp"
  mv -f "$tmp" "$HOOK_DST"   # atomic rename within the same dir
}

# Seconds since the most recent HEAD reflog ENTRY (checkout/commit/reset/detach).
# Uses the reflog selector time (%gd --date=unix → "HEAD@{<unixts>}"), NOT the
# commit time (%ct) — %ct is when the tip commit was authored, which says nothing
# about when a session last MOVED HEAD, so a freshly-cloned old tip would look
# spuriously "active". The braces contain the only digits, so tr extracts it.
last_activity_secs() {
  local raw ts now
  raw="$(git -C "$REPO_ROOT" log -g -n 1 --format='%gd' --date=unix HEAD 2>/dev/null || echo "")"
  ts="$(printf '%s' "$raw" | tr -cd '0-9')"
  [ -n "$ts" ] || { echo "-1"; return; }
  now="$(date +%s)"
  echo "$(( now - ts ))"
}

case "$MODE" in
  status)
    if is_armed; then echo "ARMED (hook installed at $HOOK_DST)"; else echo "DISARMED (no hook at $HOOK_DST)"; fi
    secs="$(last_activity_secs)"
    if [ "$secs" -lt 0 ]; then echo "last HEAD activity: unknown"; else echo "last HEAD activity: $((secs/60))m ago (${secs}s)"; fi
    exit 0
    ;;
  disarm)
    rm -f "$HOOK_DST"
    clear_legacy_hookspath
    echo "disarmed: removed $HOOK_DST"
    exit 0
    ;;
esac

# ── arm ──────────────────────────────────────────────────────────────────────
[ -x "$HOOK_SRC" ] || { echo "refuse: hook source not found/executable at $HOOK_SRC" >&2; exit 1; }

# Already armed → just refresh the copy so it can't drift from source, no gate
# needed (enforcement is already on; re-copying identical bytes changes nothing).
if is_armed; then
  install_hook
  clear_legacy_hookspath
  echo "already armed — refreshed hook copy at $HOOK_DST"
  exit 0
fi

if [ -z "$FORCE" ]; then
  secs="$(last_activity_secs)"
  if [ "$secs" -lt 0 ]; then
    echo "refuse: cannot read HEAD reflog to prove quiescence. Use --force if you are certain." >&2
    exit 1
  fi
  if [ "$secs" -lt "$((QUIET_MIN * 60))" ]; then
    echo "refuse: shared clone had HEAD activity $((secs/60))m ago (< ${QUIET_MIN}m quiet window)." >&2
    echo "  Not quiescent — arming now could abort a session mid-checkout. Re-run later." >&2
    exit 1
  fi
  echo "quiescent: no HEAD activity for $((secs/60))m (>= ${QUIET_MIN}m). Arming."
else
  echo "warning: --force — arming without the quiescence gate."
fi

install_hook
clear_legacy_hookspath
echo "ARMED: hook installed at $HOOK_DST (out of tree; core.hooksPath left unset)."
echo "  primary-tree detach/reset HEAD moves are now vetoed. Disarm: $0 --disarm"
