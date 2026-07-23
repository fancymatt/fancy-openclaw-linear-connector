#!/usr/bin/env bash
# verify-push.sh — confirm that a branch/SHA is actually reachable on origin (INF-422).
#
# Usage: ./scripts/verify-push.sh <branch-or-SHA> [remote]
# Default remote: origin
set -uo pipefail

TARGET="${1:-HEAD}"
REMOTE="${2:-origin}"

# Resolve TARGET to a full SHA
LOCAL_SHA=$(git rev-parse "$TARGET" 2>/dev/null) || {
  echo "error: cannot resolve '$TARGET' locally."
  exit 1
}

echo "INF-422: Verifying that $TARGET ($LOCAL_SHA) has landed on $REMOTE..."

# Check if LOCAL_SHA is an ancestor of the remote branch
# We use ls-remote to get the latest remote state without fetching.
REMOTE_BRANCH=$(git rev-parse --abbrev-ref "$TARGET" 2>/dev/null || echo "$TARGET")

# Get remote SHA for that branch
REMOTE_SHA=$(git ls-remote "$REMOTE" "refs/heads/$REMOTE_BRANCH" | cut -f1)

if [ -z "$REMOTE_SHA" ]; then
  echo "error: branch '$REMOTE_BRANCH' not found on $REMOTE."
  exit 1
fi

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "✅ VERIFIED: $TARGET matches $REMOTE/$REMOTE_BRANCH ($REMOTE_SHA)."
  exit 0
fi

# Check if it's an ancestor (the remote might be AHEAD)
if git merge-base --is-ancestor "$LOCAL_SHA" "$REMOTE_SHA" 2>/dev/null; then
  echo "✅ VERIFIED: $TARGET is present on $REMOTE/$REMOTE_BRANCH (remote is ahead)."
  exit 0
fi

echo "❌ FAILED: $TARGET ($LOCAL_SHA) is NOT found on $REMOTE/$REMOTE_BRANCH ($REMOTE_SHA)."
echo "   The push likely failed or the remote branch has diverged."
exit 1
