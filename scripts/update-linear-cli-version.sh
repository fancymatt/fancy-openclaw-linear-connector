#!/usr/bin/env bash
# update-linear-cli-version.sh — AI-2623: propagate linear-cli version to containers
#
# Reads the canonical version from config/linear-cli-version and updates all
# container Dockerfiles under the given CONTRIB_ROOT (default: /srv/containers
# on the deployment host).
#
# Usage:
#   scripts/update-linear-cli-version.sh [--dry-run] [CONTRIB_ROOT]
#
# If no CONTRIB_ROOT is provided, defaults to scanning the host's
# deployment container directory.

set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$SRC/config/linear-cli-version"
DRY_RUN=false
UPDATED=()

# ── Parse args ────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|--dryrun)
      DRY_RUN=true
      shift
      ;;
    *)
      ROOT="$1"
      shift
      ;;
  esac
done

CONTAINER_DIR="${ROOT:-/srv/containers}"

# ── Validate version file ─────────────────────────────────────────────

if [ ! -f "$VERSION_FILE" ]; then
  echo "ERROR: Version file not found at $VERSION_FILE" >&2
  exit 1
fi

VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
if ! echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: Version '$VERSION' is not a valid semver" >&2
  exit 1
fi

echo "=== linear-cli version: $VERSION ==="
echo "Scanning Dockerfiles in: $CONTAINER_DIR"

# ── Find and update Dockerfiles ──────────────────────────────────────

if [ ! -d "$CONTAINER_DIR" ]; then
  # If running in CI or no container dir, report what would be affected
  echo "WARNING: $CONTAINER_DIR does not exist (running outside host context)."
  echo "The current canonical version is $VERSION — update container Dockerfiles"
  echo "by running this script on the host with the correct CONTAINER_DIR."
  echo "Affected Dockerfiles would include any containing the pattern:"
  echo "  fancy-openclaw-linear-skill-cli-*.tgz"
  exit 0
fi

while IFS= read -r -d '' df; do
  REL="$(realpath --relative-to="$CONTAINER_DIR" "$df")"
  if grep -q 'fancy-openclaw-linear-skill-cli-[0-9]\+\.[0-9]\+\.[0-9]\+\.tgz' "$df" 2>/dev/null; then
    OLD_URL=$(grep -o 'https://github.com/fancyfleet/fancy-openclaw-linear-skill/releases/download/v[0-9.]*/fancy-openclaw-linear-skill-cli-[0-9.]*\.tgz' "$df" | head -1)
    NEW_URL="https://github.com/fancyfleet/fancy-openclaw-linear-skill/releases/download/v${VERSION}/fancy-openclaw-linear-skill-cli-${VERSION}.tgz"

    if [ "$DRY_RUN" = true ]; then
      echo "  [DRY RUN] $REL: $OLD_URL -> $NEW_URL"
    else
      sed -i "s|https://github.com/fancyfleet/fancy-openclaw-linear-skill/releases/download/v[0-9.]*/fancy-openclaw-linear-skill-cli-[0-9.]*\.tgz|$NEW_URL|g" "$df"
      echo "  UPDATED: $REL"
    fi
    UPDATED+=("$REL")
  fi
done < <(find "$CONTAINER_DIR" -name Dockerfile -type f -print0 2>/dev/null)

# ── Report ────────────────────────────────────────────────────────────

COUNT=${#UPDATED[@]}
echo ""
if [ "$DRY_RUN" = true ]; then
  echo "=== Dry-run complete. $COUNT container Dockerfiles would be updated. ==="
else
  echo "=== Updated $COUNT container Dockerfiles to linear-cli v${VERSION}. ==="
fi

if [ "$COUNT" -gt 0 ]; then
  echo ""
  echo "Affected containers:"
  for f in "${UPDATED[@]}"; do
    echo "  - $f"
  done
fi

exit 0
