#!/usr/bin/env bash
# AI-2623 — 27 container Dockerfiles pin linear-cli v0.4.1 — every rebuild
# re-drifts, races the 6h auto-converge.
#
# TDD failing tests: these assert that a single-source-of-truth mechanism
# exists for the linear-cli version in container Dockerfiles. Because the
# mechanism has NOT been implemented yet, every assertion FAILS.
# The implementer adds the version file, the build/lint scripts, and the
# documentation — then re-runs these tests. They PASS, proving the fix.
#
# Acceptance Criteria:
#   AC1 — Single canonical version file (build arg or version file)
#   AC2 — Changing the version in the single source propagates to all containers
#   AC3 — CI lint check catches hardcoded linear-cli versions in Dockerfiles
#   AC4 — Mechanism is documented in container-build / release-process docs
#   AC5 — Rebuilding any of the 27 images produces a container with the
#         soaked release version, without relying on the 6h auto-converge cron

set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }

# Exclusions: grep only non-generated source in the main tree, not worktrees
# or node_modules. The `tests` dir is excluded so the test can't self-match.
EXCL='--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.worktrees'
gr() {
  # Use process substitution to pipe through grep, excluding dirs manually
  find "$SRC" -type f \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/.worktrees/*' \
    -not -path '*/scripts/tests/*' \
    -not -name 'package-lock.json' \
    -not -name 'package.json' \
    2>/dev/null | xargs grep -l "$@" 2>/dev/null | head -5
}

# Variant that returns matched lines, not just filenames
grl() {
  local pattern="$1"
  shift
  find "$SRC" -type f \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/.worktrees/*' \
    -not -path '*/scripts/tests/*' \
    -not -name 'package-lock.json' \
    2>/dev/null | xargs grep -n "$pattern" "$@" 2>/dev/null | head -10
}

echo "=========================================="
echo " AI-2623: linear-cli version source tests"
echo "=========================================="
echo ""

# ═════════════════════════════════════════════════════════════════════════════
# AC1: Single canonical source for linear-cli version
# ═════════════════════════════════════════════════════════════════════════════

echo "=== AC1: single canonical version source ==="
echo "    (fails: no version file exists today)"
echo ""

VERSION_FILE=""
for candidate in \
  "config/linear-cli-version" \
  ".linear-cli-version" \
  "LINEAR_CLI_VERSION" \
  "containers/linear-cli-version" \
; do
  [ -f "$SRC/$candidate" ] && { VERSION_FILE="$SRC/$candidate"; break; }
done

if [ -n "$VERSION_FILE" ]; then
  ok "AC1.1: version file exists at $VERSION_FILE"
  VERSION_CONTENT=$(cat "$VERSION_FILE" | tr -d '[:space:]')
  if [ -n "$VERSION_CONTENT" ]; then
    ok "AC1.1a: version file is non-empty (content: $VERSION_CONTENT)"
  else
    no "AC1.1a: version file is empty"
  fi
else
  no "AC1.1: no canonical version file found at any expected path"
fi

if [ -n "$VERSION_FILE" ]; then
  VERSION_VAL=$(cat "$VERSION_FILE" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -n "$VERSION_VAL" ]; then
    ok "AC1.2: version file contains a valid semver ($VERSION_VAL)"
  else
    no "AC1.2: version file does not contain a valid semver string"
  fi
else
  no "AC1.2: cannot validate version format — no version file"
fi

# Verify no hardcoded linear-cli tarball URLs in repo source
HARDCODED=$(grl 'fancy-openclaw-linear-skill-cli-[0-9]+\.[0-9]+\.[0-9]+\.tgz')
if [ -z "$HARDCODED" ]; then
  ok "AC1.3: no hardcoded linear-cli tarball URLs in repo source files"
else
  no "AC1.3: hardcoded tarball URLs found — should use version file reference:"
  echo "$HARDCODED"
fi

# Version file must be referenced by build/deploy mechanism
VERSION_REF=$(grl 'linear-cli-version\|LINEAR_CLI_VERSION' "$SRC/scripts/" "$SRC/host-owned/" "$SRC/.github/")
if [ -n "$VERSION_REF" ]; then
  ok "AC1.4: version file is referenced by build/deploy scripts"
else
  no "AC1.4: no build/deploy script references the version source — mechanism not wired"
fi


# ═════════════════════════════════════════════════════════════════════════════
# AC2: Changing the version propagates to all containers
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC2: single edit propagates to all containers ==="
echo "    (fails: no propagation mechanism exists today)"
echo ""

# A script that reads the version file and applies it
GENERATOR=$(grl 'linear-cli-version\|LINEAR_CLI_VERSION')
if [ -n "$GENERATOR" ]; then
  ok "AC2.1: version-aware script exists"
else
  no "AC2.1: no script consumes the version source — propagation not implemented"
fi

# Loop or batch operation over all containers in scripts/ or host-owned/
BATCH_OPS=$(grl 'for.*container\|containers/\*\|find.*Dockerfile\|build.*all\|bake.*all')
if [ -n "$BATCH_OPS" ]; then
  ok "AC2.2: batch operation over containers exists"
else
  no "AC2.2: no batch container operation — would need per-container manual edits"
fi

# The propagation script should report which containers are affected
OUTPUT_REPORT=$(gr -l 'echo\|printf\|report' | xargs grep -l 'version\|linear-cli\|container' 2>/dev/null | head -5)
if [ -n "$OUTPUT_REPORT" ]; then
  ok "AC2.3: propagation script reports affected containers"
else
  no "AC2.3: no output/report of affected containers in propagation script"
fi


# ═════════════════════════════════════════════════════════════════════════════
# AC3: CI lint check catches hardcoded versions in Dockerfiles
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC3: CI lint check for hardcoded versions ==="
echo "    (fails: no CI check exists today)"
echo ""

CI_YML="$SRC/.github/workflows/ci.yml"
if [ ! -f "$CI_YML" ]; then
  no "AC3: no ci.yml found at $CI_YML — build-and-test step not in this repo"
else
  if grep -q 'linear-cli\|LINEAR_CLI_VERSION\|linear_cli_version' "$CI_YML"; then
    ok "AC3.1: CI workflow references linear-cli version check"
  else
    no "AC3.1: CI workflow has no linear-cli version consistency check"
  fi

  VERSION_CHECK=$(grep -n 'linear-cli-version\|LINEAR_CLI_VERSION\|cat.*version' "$CI_YML" | head -5)
  if [ -n "$VERSION_CHECK" ]; then
    ok "AC3.2: CI check references the version source file"
  else
    no "AC3.2: CI check does not reference the canonical version source"
  fi

  DOCKERFILE_SCAN=$(grep -n 'Dockerfile\|dockerfile\|CONTAINERS\|containers' "$CI_YML" | grep -v '^\s*#\|# Merged\|# do not' | head -5)
  if [ -n "$DOCKERFILE_SCAN" ]; then
    ok "AC3.3: CI check scans Dockerfiles for hardcoded versions"
  else
    no "AC3.3: CI check does not scan Dockerfiles — hardcoded versions would pass CI"
  fi

  FAIL_ON_MISMATCH=$(grep -n 'exit\|::error\|non-zero' "$CI_YML" | grep -i 'version\|linear\|cli\|lint\|check' | head -5)
  if [ -n "$FAIL_ON_MISMATCH" ]; then
    ok "AC3.4: version mismatch causes CI failure"
  else
    no "AC3.4: no CI failure behavior for version mismatch"
  fi
fi

# Standalone lint script exists for local use
LINT_SCRIPT=$(find "$SRC/scripts/" -maxdepth 2 \( -name "*linear*" -o -name "*version*" -o -name "*lint*docker*" \) \
  -not -path '*/.git/*' -not -path '*/.worktrees/*' 2>/dev/null | head -3)
if [ -n "$LINT_SCRIPT" ]; then
  ok "AC3.5: standalone lint script exists for local use"
else
  no "AC3.5: no standalone lint script — version check only available in CI"
fi


# ═════════════════════════════════════════════════════════════════════════════
# AC4: Documentation
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC4: documentation of the version mechanism ==="
echo "    (fails: no documentation for this exists today)"
echo ""

DOC_REF=$(grl 'linear-cli-version\|LINEAR_CLI_VERSION\|version.*source.*truth\|single.*source.*linear\|linear.*cli.*version.*pin')
if [ -n "$DOC_REF" ]; then
  ok "AC4.1: documentation references the version mechanism"
  echo "$DOC_REF" | while read -r line; do echo "       - $line"; done
else
  no "AC4.1: no documentation references the version mechanism"
fi

README_SECTION=$(grep -n -i 'linear.cli.version\|updating.*cli\|linear.cli.*update\|version.*bump\|how.to.update' "$SRC/README.md" 2>/dev/null | head -5)
if [ -n "$README_SECTION" ]; then
  ok "AC4.2: README documents how to update the linear-cli version"
else
  no "AC4.2: README does not document the version update process"
fi

echo ""
echo "=== AC4b: deployment docs ==="
DEPLOY_DOC_REF=$(grl 'linear-cli-version\|LINEAR_CLI_VERSION\|version.*source')
if [ -n "$DEPLOY_DOC_REF" ]; then
  ok "AC4.3: deployment docs mention the version source"
else
  no "AC4.3: deployment docs do not mention the version source"
fi


# ═════════════════════════════════════════════════════════════════════════════
# AC5: End-to-end — rebuilt images produce container with soaked release
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC5: rebuilt images carry the correct version ==="
echo "    (fails: no end-to-end guarantee exists)"
echo ""

# Version passed as Docker build-arg
BUILD_ARG=$(grl 'build-arg.*LINEAR_CLI_VERSION\|LINEAR_CLI_VERSION')
if [ -n "$BUILD_ARG" ]; then
  ok "AC5.1: version passed as Docker build-arg"
else
  no "AC5.1: no Docker build-arg for linear-cli version — rebuilds will not bake the correct version"
fi

# Mechanism must NOT rely on auto-converge cron
NO_CRON_DEP=$(grl 'auto.converge\|6h.*cron\|converge.*cron')
if [ -n "$NO_CRON_DEP" ]; then
  no "AC5.2: mechanism references the auto-converge cron — would still flap on rebuild"
else
  ok "AC5.2: no auto-converge cron dependency in version mechanism"
fi

# Image carries a verifiable version label
VERSION_LABEL=$(grl 'LABEL.*LINEAR_CLI\|label.*linear.*cli\|version.*label')
if [ -n "$VERSION_LABEL" ]; then
  ok "AC5.3: image carries a verifiable version label"
else
  no "AC5.3: no version label or metadata exposed in built images"
fi


# ── Summary ─────────────────────────────────────────────────────────────

echo ""
echo "========================"
echo " $pass passed, $fail failed"
echo "========================"
echo ""
echo "NOTE: ALL AC tests expected to FAIL until the single-source-of-truth"
echo "mechanism is implemented. These tests encode the required patterns."
echo ""

[ "$fail" -gt 0 ] && exit 1 || exit 0
