#!/usr/bin/env bash
set -euo pipefail
#
# connector-reftxn-arm.sh — arm/disarm the primary-tree HEAD-veto hook in the
# SHARED connector clone (AI-2481). Self-gating on quiescence.
#
# Arming means pointing this clone's core.hooksPath at scripts/git-hooks, which
# activates scripts/git-hooks/reference-transaction. From that instant, a
# detached checkout or a sideways/backward `git reset` in the PRIMARY working
# tree is refused (see the hook header for the exact allow/deny matrix).
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
#   connector-reftxn-arm.sh --disarm     # unset core.hooksPath

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
HOOKS_REL="scripts/git-hooks"
HOOK="$REPO_ROOT/$HOOKS_REL/reference-transaction"

current_hookspath() { git -C "$REPO_ROOT" config --local --get core.hooksPath || true; }

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
    hp="$(current_hookspath)"
    if [ "$hp" = "$HOOKS_REL" ]; then echo "ARMED (core.hooksPath=$hp)"; else echo "DISARMED (core.hooksPath='${hp:-unset}')"; fi
    secs="$(last_activity_secs)"
    if [ "$secs" -lt 0 ]; then echo "last HEAD activity: unknown"; else echo "last HEAD activity: $((secs/60))m ago (${secs}s)"; fi
    exit 0
    ;;
  disarm)
    git -C "$REPO_ROOT" config --local --unset core.hooksPath 2>/dev/null || true
    echo "disarmed: core.hooksPath unset in $REPO_ROOT"
    exit 0
    ;;
esac

# ── arm ──────────────────────────────────────────────────────────────────────
[ -x "$HOOK" ] || { echo "refuse: hook not found/executable at $HOOK" >&2; exit 1; }

if [ "$(current_hookspath)" = "$HOOKS_REL" ]; then
  echo "already armed (core.hooksPath=$HOOKS_REL) — nothing to do."
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

git -C "$REPO_ROOT" config --local core.hooksPath "$HOOKS_REL"
echo "ARMED: core.hooksPath=$HOOKS_REL in $REPO_ROOT"
echo "  primary-tree detach/reset HEAD moves are now vetoed. Disarm: $0 --disarm"
