#!/usr/bin/env bash
# lint-linear-cli-version.sh — CI lint check for AI-2623
#
# Verifies:
#   1. The canonical version file exists and contains a valid semver
#   2. No container Dockerfiles in the repository hardcode a linear-cli tarball URL
#      that doesn't match the canonical version
#
# Can be run standalone or as a CI step. On CI failure, exits non-zero.

set -uo pipefail
EXIT_CODE=0

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
VERSION_FILE="$SRC/config/linear-cli-version"

# ── 1. Validate canonical version file ──────────────────────────────────

if [ ! -f "$VERSION_FILE" ]; then
  echo "::error title=linear-cli-version::Canonical version file not found at config/linear-cli-version"
  EXIT_CODE=1
else
  VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
  if ! echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "::error title=linear-cli-version::Version file config/linear-cli-version does not contain a valid semver (got: '$VERSION')"
    EXIT_CODE=1
  else
    echo "::notice title=linear-cli-version::Canonical linear-cli version: $VERSION"
  fi
fi

# ── 2. Scan Dockerfiles for hardcoded tarball URLs ──────────────────────
# Look for any Dockerfile in the repo (excluding worktrees and node_modules)
# that contains a hardcoded linear-cli tarball URL.

find "$SRC" -name Dockerfile \
  -not -path '*/.git/*' \
  -not -path '*/.worktrees/*' \
  -not -path '*/node_modules/*' \
  -print0 2>/dev/null | while IFS= read -r -d '' df; do
  if grep -qn 'fancy-openclaw-linear-skill-cli-[0-9]\+\.[0-9]\+\.[0-9]\+\.tgz' "$df" 2>/dev/null; then
    URL_VERSION=$(grep -o 'fancy-openclaw-linear-skill-cli-[0-9]\+\.[0-9]\+\.[0-9]\+\.tgz' "$df" | head -1)
    PINNED=$(echo "$URL_VERSION" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
    REL=$(realpath --relative-to="$SRC" "$df" 2>/dev/null || echo "$df")
    echo "::error title=hardcoded-linear-cli::$REL has a hardcoded linear-cli tarball (pinned to $PINNED). Use the version from config/linear-cli-version instead."
    EXIT_CODE=1
  fi
done

exit $EXIT_CODE
