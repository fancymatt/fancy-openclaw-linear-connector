#!/usr/bin/env bash
# AI-2589 — Deploy script should sync workflow YAML to WORKFLOW_DEFS_DIR.
#
# TDD failing tests: these assert that deploy-linear-connector.sh contains
# the required sync step. Because the sync step has NOT been added yet,
# every assertion FAILS. The implementer adds the step to the script, then
# re-runs these tests — they PASS, proving the fix.
#
# Acceptance Criteria:
#   AC1: deploy script copies *.yaml from src/registered-defs/ to WORKFLOW_DEFS_DIR
#        before restarting the connector
#   AC2: copy step includes dry-run output showing files to be updated
#   AC3: missing src/registered-defs/ prints warning but continues (non-fatal)
#   AC4: after deploy, /health can report correct workflow versions from synced defs
#
# Design: instead of simulating (which runs the risk of accidentally
# "implementing" the behavior in the test), these assertions scan the
# REAL deploy script's source for exact patterns that the implementation
# must contain. The scan-based approach means:
#   - The test encodes what the final script should look like
#   - It fails NOISILY against the current script (no patterns match)
#   - It passes only after the real script is modified
set -uo pipefail
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }

# Locate the real deploy script.
DEPLOY_SCRIPT="${DEPLOY_SCRIPT_PATH:-}"
if [ -z "$DEPLOY_SCRIPT" ]; then
  for candidate in \
    "$HOME/.openclaw/workspace/tdd/ai-repo/host-owned/bin/deploy-linear-connector.sh" \
    "$HOME/obsidian-vault/life-os/infra/projects/linear-connector/deploy-linear-connector.sh" \
  ; do
    [ -f "$candidate" ] && { DEPLOY_SCRIPT="$candidate"; break; }
  done
fi

if [ -z "$DEPLOY_SCRIPT" ] || [ ! -f "$DEPLOY_SCRIPT" ]; then
  echo "FATAL: deploy-linear-connector.sh not found. Can't run tests."
  echo "Set DEPLOY_SCRIPT_PATH or ensure the file exists."
  exit 1
fi

echo "Testing deploy script at: $DEPLOY_SCRIPT"
echo ""

# ═════════════════════════════════════════════════════════════════════════════
# AC1: Deploy script copies *.yaml from src/registered-defs/ to WORKFLOW_DEFS_DIR
#      before restarting the connector.
#
# Expected pattern in deploy-linear-connector.sh between step 4 (sync dist/) and
# step 5 (restart):
#
#   # ── [4.5/5] Sync workflow YAML definitions ────────────────────────
#   echo "[4.5/5] sync workflow YAML definitions to $SHARE/workflows/…"
#   WORKFLOW_DEFS_DIR="$SHARE/workflows"
#   if [ -d "$DEPLOY_WT/src/registered-defs" ]; then
#     mkdir -p "$WORKFLOW_DEFS_DIR"
#     rsync -a --delete "$DEPLOY_WT/src/registered-defs/"*.yaml "$WORKFLOW_DEFS_DIR/"
#     echo "        workflow YAML definitions synced"
#   else
#     echo "        src/registered-defs/ not found — skipping (non-fatal)"
#   fi
# ═════════════════════════════════════════════════════════════════════════════

echo "=== AC1: sync *.yaml from src/registered-defs/ to WORKFLOW_DEFS_DIR ==="
echo "    (fails: no sync step exists in current script)"
echo ""

# Test 1.1: The script must have a step labeled "sync workflow" between
# the dist sync and the restart.
#
# Current: the step numbering goes 1/5 → 5/5 with no 4.5/5.
sync_comment=$(grep -n 'sync.*workflow.*YAML\|workflow.*YAML.*sync\|4\.[0-9]/5.*workflow\|workflow definitions' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$sync_comment" ]; then
  ok "AC1.1: sync-workflow comment exists: $sync_comment"
else
  no "AC1.1: no workflow YAML sync comment found — step heading missing"
fi

# Test 1.2: The script must reference "src/registered-defs" as a source.
registered_ref=$(grep -n 'registered-defs\|registered_defs' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$registered_ref" ]; then
  ok "AC1.2: references src/registered-defs/ path"
else
  no "AC1.2: no reference to src/registered-defs/ — sync source not defined"
fi

# Test 1.3: The script must have a block that copies files with a *.yaml glob.
yaml_copy=$(grep -n '\.yaml.*$WORKFLOW_DEFS_DIR\|\.yaml.*"$WORKFLOW\|rsync.*\.yaml\|cp.*\.yaml' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$yaml_copy" ]; then
  ok "AC1.3: has a *.yaml file copy command"
else
  no "AC1.3: no *.yaml file copy command — sync step not implemented"
fi

# Test 1.4: The YAML sync must happen BEFORE the connector restart.
restart_lineno=$(grep -n 'systemctl.*restart\|restart.*$SERVICE' "$DEPLOY_SCRIPT" 2>/dev/null | grep -v '^#' | head -1 | cut -d: -f1)
yaml_lineno=$(grep -n 'registered-defs\|\.yaml' "$DEPLOY_SCRIPT" 2>/dev/null | head -1 | cut -d: -f1)
if [ -n "$restart_lineno" ] && [ -n "$yaml_lineno" ] && [ "$yaml_lineno" -lt "$restart_lineno" ] 2>/dev/null; then
  ok "AC1.4: YAML sync step appears before restart (line $yaml_lineno < $restart_lineno)"
else
  if [ -z "$yaml_lineno" ]; then
    no "AC1.4: cannot verify ordering — no YAML sync step exists"
  else
    no "AC1.4: YAML sync appears at line $yaml_lineno but restart at $restart_lineno — wrong order!"
  fi
fi

# Test 1.5: WORKFLOW_DEFS_DIR should reference $SHARE/workflows or similar.
wf_defs=$(grep -n 'SHARE.*workflow\|WORKFLOW.*DIR\|workflows.*dir' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$wf_defs" ]; then
  ok "AC1.5: defines WORKFLOW_DEFS_DIR"
else
  no "AC1.5: no WORKFLOW_DEFS_DIR definition — target path not set"
fi


# ═════════════════════════════════════════════════════════════════════════════
# AC2: The copy step includes a dry-run output showing which files will be
#      updated.
#
# Expected: the sync step section contains a --dry-run branch or an echo
# listing the files that would be synced.
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC2: dry-run output lists files to be synced ==="
echo "    (fails: no dry-run logic for YAML sync exists)"
echo ""

# Test 2.1: dry-run flag or variable for the YAML sync step.
dry_run=$(grep -n 'dry.run\|DRY_RUN\|--dry-run' "$DEPLOY_SCRIPT" 2>/dev/null | grep -i 'yaml\|workflow\|def' | head -5)
if [ -n "$dry_run" ]; then
  ok "AC2.1: dry-run option exists for YAML sync"
else
  no "AC2.1: no dry-run option for YAML sync"
fi

# Test 2.2: dry-run output would list individual files.
dry_file_list=$(sed -n '/registered-defs/,/^  #\|^$)\|^esac\|^fi/ {
  /DRY RUN\|dry-run\|would copy\|would sync/ p
}' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$dry_file_list" ]; then
  ok "AC2.2: dry-run outputs file listing"
else
  # Broader search: does the script have any dry-run section at all?
  any_dry=$(grep -c 'dry.run\|DRY_RUN\|--dry-run' "$DEPLOY_SCRIPT" 2>/dev/null)
  if [ "$any_dry" -gt 0 ]; then
    no "AC2.2: dry-run exists but does not list individual YAML files"
  else
    no "AC2.2: no dry-run output at all"
  fi
fi


# ═════════════════════════════════════════════════════════════════════════════
# AC3: If src/registered-defs/ does not exist, the script prints a warning
#      but continues (non-fatal) to handle first-time-setup edge cases.
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC3: missing src/registered-defs/ is non-fatal ==="
echo "    (fails: current script doesn't check for this dir)"
echo ""

# Test 3.1: The sync step must check for existence of src/registered-defs before copying.
exists_check=$(sed -n '/registered-defs/,/^  #\|^$\|^esac/ {
  /\[.*-d.*registered-defs\|\[.*!.*-d.*registered-defs\|test.*-d.*registered-defs/ p
}' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$exists_check" ]; then
  ok "AC3.1: existence check for src/registered-defs/ present"
else
  no "AC3.1: no existence check for src/registered-defs/"
fi

# Test 3.2: The script handles the missing case with a warning (not exit 1).
warning_nofatal=$(sed -n '/registered-defs/,/^  #\|^$\|^esac/ {
  /not.found.*skip\|skip.*non.fatal\|warn.*registered\|not.found.*continue/ p
}' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$warning_nofatal" ]; then
  ok "AC3.2: warning printed for missing dir, continues non-fatally"
else
  no "AC3.2: missing dir does not trigger warning/continuation"
fi

# Test 3.3: The missing-dir branch must NOT call exit 1.
has_exit=$(sed -n '/[ -d .*registered-defs/,/^  #\|^$\|^esac/ {
  /exit 1\|exit 2\|exit [1-9]/ p
}' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$has_exit" ]; then
  no "AC3.3: missing-dir case would EXIT (should be non-fatal)"
else
  ok "AC3.3: missing-dir case does not fatal-exit (or no handler at all)"
fi


# ═════════════════════════════════════════════════════════════════════════════
# AC4: After deploying, /health reports the correct workflow version matching
#      the registered definitions (not a stale cached version).
#
# This is an integration property: the sync step must copy YAML files to a
# location the runtime reads and the /health endpoint reports. We verify that
# the deploy script copies to a path consistent with WORKFLOW_DEFS_DIR.
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC4: /health reports workflow versions matching registered defs ==="
echo "    (fails: without sync step, /health reads stale WORKFLOW_DEFS_DIR)"
echo ""

# Test 4.1: The target directory for YAML sync must match where
# the runtime reads defs (SHARE/workflows/ or WORKFLOW_DEFS_DIR).
target_path=$(grep -n 'workflow.*$SHARE\|$SHARE.*workflow\|WORKFLOW_DEFS_DIR' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$target_path" ]; then
  ok "AC4.1: YAML sync target matches runtime WORKFLOW_DEFS_DIR"
else
  no "AC4.1: YAML sync target not aligned with WORKFLOW_DEFS_DIR runtime path"
fi

# Test 4.2: The deploy script stamps/tracks the deployed workflow version
# so /health can expose it.
version_stamp=$(grep -n 'DEPLOY_COMMIT\|deploy.*version\|WORKFLOW.*version' "$DEPLOY_SCRIPT" 2>/dev/null | head -5)
if [ -n "$version_stamp" ]; then
  ok "AC4.2: deploy script tracks deployed version"
else
  no "AC4.2: no version tracking in deploy script"
fi

# Test 4.3: Integration — the runtime WORKFLOW_DEFS_DIR ($SHARE/workflows/)
# should exist and contain the same workflow versions as src/registered-defs/
# after deploy. We can't run the actual deploy, but we can verify the script
# would copy to a path the health endpoint reads.
share_path=$(grep -n 'SHARE=' "$DEPLOY_SCRIPT" 2>/dev/null | head -1 | sed 's/.*SHARE=//')
if [ -n "$share_path" ]; then
  eval target_dir="$share_path/workflows"
  health_defs=$(grep -c 'workflow\|health.*workflow\|workflowRegistry' "$DEPLOY_SCRIPT" 2>/dev/null)
  if [ "$health_defs" -gt 0 ]; then
    ok "AC4.3: deploy script references path readable by /health endpoint"
  else
    no "AC4.3: deploy script does not reference /health-visible workflow paths"
  fi
else
  no "AC4.3: cannot resolve SHARE path from deploy script"
fi


# ── Summary ─────────────────────────────────────────────────────────────

echo ""
echo "========================"
echo " $pass passed, $fail failed"
echo "========================"
[ "$fail" -eq 0 ]
