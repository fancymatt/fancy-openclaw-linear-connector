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
# ANTI-DRIFT (INF-19): the armed copy is installed OUT OF TREE, so nothing makes
# it converge when the tracked source changes upstream. A clone could run an
# arbitrarily old hook while `git log` shows the fix landed hours ago — exactly
# the drift that made INF-17 look like a different bug than it was. Two guards:
#   1. AUTO-RE-ARM ON PULL. Arming also installs post-merge + post-rewrite hooks
#      (out of tree, same dir) that re-run this script's ungated refresh path.
#      So a `git pull` / rebase that brings in a new hook re-copies it the same
#      instant, with no human remembering to re-arm. It only refreshes an ALREADY
#      -armed clone — it will NOT silently arm a clone left disarmed on purpose
#      (arm-from-scratch stays gated on quiescence). NOTE the bootstrap: a clone
#      that predates this change must be armed ONCE by hand to install the
#      auto-arm hooks; from then on it self-heals.
#   2. DRIFT IS DETECTABLE. `--check` compares the armed copy to the tracked
#      source by content and reports IN-SYNC / DRIFT / NOT-ARMED for a health
#      check or cron. The hook carries a REFTXN_HOOK_VERSION stamp so the report
#      (and a refusal, and `reference-transaction --version`) names which hook ran.
#
# Usage:
#   connector-reftxn-arm.sh              # arm if quiescent, else refuse
#   connector-reftxn-arm.sh --quiet-min N
#   connector-reftxn-arm.sh --force      # arm now, bypassing the quiescence gate (human)
#   connector-reftxn-arm.sh --status     # report armed/disarmed + version + auto-arm
#   connector-reftxn-arm.sh --check      # drift check: 0 in-sync, 1 drift, 2 not-armed, 3 no-source
#   connector-reftxn-arm.sh --disarm     # remove the installed hook + auto-arm hooks

QUIET_MIN=15
MODE="arm"
FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet-min) QUIET_MIN="${2:?--quiet-min needs a number}"; shift 2 ;;
    --force)     FORCE="1"; shift ;;
    --status)    MODE="status"; shift ;;
    --check)     MODE="check"; shift ;;
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

# Auto-re-arm hooks (INF-19). Installed alongside the veto hook, out of tree.
# post-merge fires after `git pull`/merge; post-rewrite after rebase/amend — the
# two ways new hook bytes arrive by moving history. Both re-run this script's
# ungated refresh so the armed copy converges the instant a new hook lands.
AUTOARM_MARKER="connector-reftxn-arm.sh (INF-19)"
POSTMERGE_DST="$GIT_COMMON_DIR/hooks/post-merge"
POSTREWRITE_DST="$GIT_COMMON_DIR/hooks/post-rewrite"

is_armed() { [ -e "$HOOK_DST" ]; }

# Read the REFTXN_HOOK_VERSION stamp out of a hook file (source or armed copy).
hook_version() {
  local v
  v="$(sed -n 's/^REFTXN_HOOK_VERSION="\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n1)"
  [ -n "$v" ] && printf '%s' "$v" || printf 'unstamped'
}

# Body of the auto-re-arm hooks. Self-contained; finds the arm script by repo
# root and re-runs it. The refresh path is ungated and only touches file copies
# (never moves HEAD), so it cannot loop or abort the pull. Silent + non-fatal.
autoarm_body() {
  cat <<HOOK
#!/usr/bin/env bash
# AUTO-GENERATED by $AUTOARM_MARKER — do not edit; re-run the arm script to update.
# Re-arms the reference-transaction HEAD-veto hook after a pull/rebase so the
# armed copy can never drift from the tracked source. Refreshes only an already
# -armed clone; will not silently arm a clone left disarmed on purpose.
root="\$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
arm="\$root/scripts/connector-reftxn-arm.sh"
[ -x "\$arm" ] || exit 0
"\$arm" >/dev/null 2>&1 || true
exit 0
HOOK
}

# Install our post-merge/post-rewrite hooks. Refuse to clobber a FOREIGN hook of
# the same name (one we didn't generate) — warn and skip so a repo that later
# adds its own post-merge is never silently stomped.
install_autoarm_hooks() {
  mkdir -p "$GIT_COMMON_DIR/hooks"
  local dst tmp
  for dst in "$POSTMERGE_DST" "$POSTREWRITE_DST"; do
    if [ -e "$dst" ] && ! grep -qF "$AUTOARM_MARKER" "$dst" 2>/dev/null; then
      echo "  warning: $dst exists and is not ours — leaving it; auto-re-arm on $(basename "$dst") is OFF" >&2
      continue
    fi
    tmp="$dst.tmp.$$"
    autoarm_body > "$tmp"
    chmod +x "$tmp"
    mv -f "$tmp" "$dst"
  done
}

# Remove ONLY our generated auto-arm hooks (identified by marker).
remove_autoarm_hooks() {
  local dst
  for dst in "$POSTMERGE_DST" "$POSTREWRITE_DST"; do
    if [ -e "$dst" ] && grep -qF "$AUTOARM_MARKER" "$dst" 2>/dev/null; then rm -f "$dst"; fi
  done
}

autoarm_installed() { grep -qF "$AUTOARM_MARKER" "$POSTMERGE_DST" 2>/dev/null; }

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
  install_autoarm_hooks      # keep the armed copy converged on future pulls (INF-19)
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
    if is_armed; then
      echo "ARMED (hook installed at $HOOK_DST)"
      echo "  armed hook version:  $(hook_version "$HOOK_DST")"
    else
      echo "DISARMED (no hook at $HOOK_DST)"
    fi
    if [ -e "$HOOK_SRC" ]; then echo "  tracked src version: $(hook_version "$HOOK_SRC")"; else echo "  tracked src: ABSENT ($HOOK_SRC)"; fi
    if autoarm_installed; then echo "  auto-re-arm on pull: ON (post-merge + post-rewrite installed)"; else echo "  auto-re-arm on pull: OFF (run this script to install)"; fi
    secs="$(last_activity_secs)"
    if [ "$secs" -lt 0 ]; then echo "  last HEAD activity: unknown"; else echo "  last HEAD activity: $((secs/60))m ago (${secs}s)"; fi
    exit 0
    ;;
  check)
    # Drift check for health monitors/cron. Compares armed copy to tracked source
    # by content. Exit: 0 in-sync, 1 drift, 2 not-armed, 3 no tracked source.
    if [ ! -e "$HOOK_SRC" ]; then
      echo "SOURCE-ABSENT: no tracked hook at $HOOK_SRC (clone predates the isolation hook)"; exit 3
    fi
    if ! is_armed; then
      echo "NOT-ARMED: no hook at $HOOK_DST (tracked source version: $(hook_version "$HOOK_SRC"))"; exit 2
    fi
    if cmp -s "$HOOK_SRC" "$HOOK_DST"; then
      echo "IN-SYNC: armed hook matches tracked source (version: $(hook_version "$HOOK_DST"))"
      autoarm_installed || echo "  note: auto-re-arm hooks NOT installed — re-run this script to enable convergence-on-pull"
      exit 0
    else
      echo "DRIFT: armed hook DIFFERS from tracked source — armed clone is running a STALE hook"
      echo "  tracked source: version=$(hook_version "$HOOK_SRC") sha=$(sha256sum "$HOOK_SRC" | cut -c1-16)"
      echo "  armed copy:     version=$(hook_version "$HOOK_DST") sha=$(sha256sum "$HOOK_DST" | cut -c1-16)"
      echo "  Converge with:  $0"
      exit 1
    fi
    ;;
  disarm)
    rm -f "$HOOK_DST"
    remove_autoarm_hooks
    clear_legacy_hookspath
    echo "disarmed: removed $HOOK_DST + auto-re-arm hooks"
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
  echo "already armed — refreshed hook copy + auto-re-arm hooks at $GIT_COMMON_DIR/hooks"
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
echo "  version: $(hook_version "$HOOK_DST")"
echo "  auto-re-arm on pull/rebase: ON (post-merge + post-rewrite installed) — armed copy self-converges now."
echo "  primary-tree detach/reset HEAD moves are now vetoed. Disarm: $0 --disarm ; drift check: $0 --check"
