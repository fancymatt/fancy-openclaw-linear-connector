#!/usr/bin/env bash
#
# guard-restart-cooldown.sh — prevent back-to-back container restarts within a cooldown window
#
# Usage:
#   scripts/guard-restart-cooldown.sh [--cooldown <seconds>] [--status] [docker-compose restart args...]
#
# Wraps `docker compose restart` (or any deploy-restart command) to enforce a
# cooldown between restarts. If a restart was triggered within the cooldown
# window (default: 120 seconds), the script warns and exits without restarting,
# preventing the restart cascade that caused AI-2171 (4 dropped inbound Matrix
# messages during back-to-back gateway restarts).
#
# Flags:
#   --cooldown <seconds>   Set the cooldown window (default: 120)
#   --status               Show cooldown state and exit
#   --force                Bypass the cooldown check (use with care — only when
#                          the restart is known-safe, e.g. scheduled maintenance)
#
# The cooldown is tracked by a timestamp file at:
#   /tmp/.guard-restart-cooldown-<project-name>
#
# This is an advisory guard, not a hard enforcement — it can be bypassed with
# --force or by running docker compose restart directly. The intent is to catch
# the common case: sequential config edits, each followed by an immediate restart.
#
# INSTALLATION:
#   Alias or wrap your deploy commands:
#     alias dc-restart='scripts/guard-restart-cooldown.sh docker compose restart'
#
#   Or source this script in your shell profile and use gated_restart():
#     source scripts/guard-restart-cooldown.sh
#     gated_restart  # uses the function below

set -euo pipefail

# Defaults
COOLDOWN_SECONDS=120
FORCE=false
ACTION="restart"

# Parse flags (before docker compose args)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cooldown)
      COOLDOWN_SECONDS="$2"
      shift 2
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

# Derive a project key for the cooldown marker from the cwd (so each deploy
# directory gets its own cooldown window)
PROJECT_SLUG="$(basename "$(cd "$(dirname "$0")/.." && pwd)" | tr -cd 'A-Za-z0-9_-')"
MARKER_FILE="/tmp/.guard-restart-cooldown-${PROJECT_SLUG}"

show_status() {
  if [[ -f "$MARKER_FILE" ]]; then
    local last_restart last_epoch now elapsed remaining
    last_restart="$(cat "$MARKER_FILE")"
    last_epoch="$(date -d "$last_restart" +%s 2>/dev/null || echo 0)"
    now="$(date +%s)"
    elapsed=$(( now - last_epoch ))
    if (( elapsed < COOLDOWN_SECONDS )); then
      remaining=$(( COOLDOWN_SECONDS - elapsed ))
      echo "RESTART COOLDOWN: ACTIVE — $(date -d "@$last_restart" '+%H:%M:%S') (${remaining}s remaining of ${COOLDOWN_SECONDS}s window)"
    else
      echo "RESTART COOLDOWN: EXPIRED — last restart was ${elapsed}s ago (window: ${COOLDOWN_SECONDS}s)"
    fi
  else
    echo "RESTART COOLDOWN: NO PRIOR RESTART (no cooldown marker at ${MARKER_FILE})"
  fi
}

if [[ "$ACTION" == "status" ]]; then
  show_status
  exit 0
fi

# Check cooldown
if [[ -f "$MARKER_FILE" ]] && ! $FORCE; then
  local last_restart last_epoch now elapsed
  last_restart="$(cat "$MARKER_FILE")"
  last_epoch="$(date -d "$last_restart" +%s 2>/dev/null || echo 0)"
  now="$(date +%s)"
  elapsed=$(( now - last_epoch ))

  if (( elapsed < COOLDOWN_SECONDS )); then
    remaining=$(( COOLDOWN_SECONDS - elapsed ))
    echo "⚠️  RESTART GUARD: Restart blocked — last restart was ${elapsed}s ago." >&2
    echo "   Cooldown: ${remaining}s remaining of ${COOLDOWN_SECONDS}s window." >&2
    echo "   To bypass: ${0} --force $*" >&2
    echo "   To check:  ${0} --status" >&2
    echo "   NOT restarting. Batch remaining config changes, then restart once." >&2
    exit 1
  fi
fi

# If no docker-compose command was passed, just run the default
if [[ $# -eq 0 ]]; then
  echo "RESTART GUARD: no docker compose command provided — showing status only" >&2
  show_status
  exit 0
fi

# Execute the restart command
echo "RESTART GUARD: executing: $*" >&2
"$@"

# Mark the cooldown
date -Iseconds > "$MARKER_FILE"
echo "RESTART GUARD: cooldown marker set at ${MARKER_FILE}"
echo "   Next restart guarded for ${COOLDOWN_SECONDS}s (--force bypasses)"
