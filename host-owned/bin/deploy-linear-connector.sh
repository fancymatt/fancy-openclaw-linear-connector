#!/usr/bin/env bash
# Host-owned deploy script for the Linear connector (linear-webhook-fancymatt).
# Triggered by the systemd path unit when Astrid touches the request file.
# Astrid CANNOT edit this file (lives outside her container mounts) — she can only
# request a deploy; this script defines exactly what a deploy does.
#
# AI-1832: All builds happen in a dedicated deploy worktree. The shared working
# tree (where agents have feature branches + uncommitted edits) is NEVER touched
# — not its HEAD, not its index, not its tracked files. Only dist/ is copied in.
set -uo pipefail

# AI-1868: connector decoupled from the life-os monorepo into its own repo.
# Paths re-pointed from the dead Code/repos/life-os/linear-webhook-fancymatt[-deploy].
REPO=/home/fancymatt/Code/repos/fancy-openclaw-linear-connector
DEPLOY_WT=/home/fancymatt/Code/repos/fancy-openclaw-linear-connector-deploy
SHARE=/home/fancymatt/.openclaw/linear-connector
RESULT="$SHARE/.deploy-result"
SERVICE=linear-webhook-fancymatt.service
DEPLOY_REF=origin/main
export PATH="/home/fancymatt/.nvm/versions/node/v24.15.0/bin:$PATH"

# AI-2589: support --dry-run for workflow YAML definitions preview
DRY_RUN=
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

{
  echo "=== linear-connector deploy $(date -Is) ==="

  # ── [1/5] Validate deploy worktree is REAL, not just present ──────────────
  # AI-2409: a bare existence check ([ -e "$DEPLOY_WT/.git" ]) passes on a
  # DANGLING gitdir pointer — a worktree whose admin entry
  # ($REPO/.git/worktrees/<name>/) was pruned/removed out from under it while
  # the dir on disk survived, still holding its gitignored runtime state
  # (.env, agents.json, data/ SQLite DBs). That state fell through to [2/5]
  # and died on a raw FETCH_FAILED instead of an actionable message. Validate
  # the worktree is genuinely registered with git instead of merely present.
  echo "[1/5] validate deploy worktree at $DEPLOY_WT…"
  wt_valid() { git -C "$DEPLOY_WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; }
  if ! wt_valid; then
    if [ ! -d "$DEPLOY_WT" ]; then
      echo "RESULT: FAILED — deploy worktree not found at $DEPLOY_WT"
      echo "         Recreate with: git -C $REPO worktree add $DEPLOY_WT origin/main"
      echo "         Then restore runtime state (.env, agents.json, data/) — see linear-connector/DEPLOY.md."
      exit 1
    fi
    # Dir exists but git doesn't recognize it as a worktree — the AI-2409
    # dangling-gitdir state. Attempt a NON-DESTRUCTIVE self-heal that rebuilds
    # only the admin metadata under $REPO/.git/worktrees/<name>/ and preserves
    # the worktree's live runtime state (.env, agents.json, data/ are all
    # gitignored, so nothing on disk is checked out over or deleted). We do
    # NOT `worktree add [--force]` here: it refuses a populated path, and
    # clobbering the dir would destroy the live agent registry + SQLite DBs.
    echo "        deploy worktree present but not registered — attempting non-destructive self-heal (AI-2409)…"
    ptr=$(sed -n 's/^gitdir: //p' "$DEPLOY_WT/.git" 2>/dev/null)
    name=${ptr##*/worktrees/}
    if [ -n "$name" ] && [ "$name" != "$ptr" ]; then
      git -C "$REPO" worktree prune 2>&1 || true
      admin="$REPO/.git/worktrees/$name"
      mkdir -p "$admin"
      printf '%s/.git\n' "$DEPLOY_WT" > "$admin/gitdir"
      printf '../..\n' > "$admin/commondir"
      git -C "$REPO" rev-parse HEAD > "$admin/HEAD" 2>/dev/null || true
      git -C "$REPO" worktree repair "$DEPLOY_WT" 2>&1 || true
    fi
    if wt_valid; then
      echo "        self-heal OK — deploy worktree re-registered, runtime state intact"
    else
      echo "RESULT: FAILED — deploy worktree at $DEPLOY_WT has a dangling git metadata"
      echo "         pointer and self-heal did not recover it."
      echo "         This dir holds LIVE runtime state (.env, agents.json, data/ SQLite) — do NOT"
      echo "         delete it. Recover the git metadata manually, e.g.:"
      echo "           git -C $REPO worktree prune && git -C $REPO worktree repair $DEPLOY_WT"
      echo "         or rebuild the admin entry under $REPO/.git/worktrees/. See linear-connector/DEPLOY.md."
      exit 1
    fi
  fi

  # ── [2/5] Pin deploy worktree to origin/main ─────────────────────────────
  # The deploy worktree is a dedicated build tree — agents never work in it.
  # We fetch + hard-reset it to origin/main. This does NOT touch the shared
  # working tree at all.
  echo "[2/5] pin deploy worktree to $DEPLOY_REF…"
  if ! git -C "$DEPLOY_WT" fetch origin main 2>&1; then
    echo "RESULT: FETCH_FAILED — could not fetch $DEPLOY_REF; service left untouched"
    exit 1
  fi
  # Clean + reset in the deploy worktree only. The shared tree is untouched.
  if ! git -C "$DEPLOY_WT" checkout --detach "$DEPLOY_REF" 2>&1; then
    echo "RESULT: CHECKOUT_FAILED — could not check out $DEPLOY_REF in deploy worktree"
    exit 1
  fi
  if ! git -C "$DEPLOY_WT" reset --hard "$DEPLOY_REF" 2>&1; then
    echo "RESULT: RESET_FAILED — could not reset deploy worktree to $DEPLOY_REF"
    exit 1
  fi
  DEPLOY_COMMIT=$(git -C "$DEPLOY_WT" rev-parse --short HEAD)
  echo "        deploy worktree now at $DEPLOY_REF @ $DEPLOY_COMMIT"

  # ── [3/5] Build in the deploy worktree ──────────────────────────────────
  # Ensure backend deps (incl. devDeps like typescript/tsc) are present before
  # building — the worktree's node_modules can be created without devDeps, which
  # made `npm run build` fail with `tsc: not found` (AI-1893). Mirrors the web
  # step below, which already installs before building. npm ci is lockfile-exact.
  echo "[3/5] install backend deps in deploy worktree (npm ci)…"
  if ! npm --prefix "$DEPLOY_WT" ci --no-audit --no-fund 2>&1; then
    echo "RESULT: BUILD_FAILED — backend dependency install (npm ci) failed, NOT restarted"
    exit 1
  fi
  echo "[3/5] build backend in deploy worktree (npm run build)…"
  export CONNECTOR_DEPLOY_BUILD=1 CONNECTOR_DEPLOY=1
  if ! npm --prefix "$DEPLOY_WT" run build 2>&1; then
    echo "RESULT: BUILD_FAILED — service left running on previous build, NOT restarted"
    exit 1
  fi
  echo "[3.5/5] build web frontend (npm --prefix web run build)…"
  if ! (npm --prefix "$DEPLOY_WT/web" install --no-audit --no-fund 2>&1 && npm --prefix "$DEPLOY_WT/web" run build 2>&1); then
    echo "RESULT: WEB_BUILD_FAILED — service left running on previous build, NOT restarted"
    exit 1
  fi

  # ── [4/5] Sync dist/ to shared tree (atomic swap) ────────────────────────
  # We only copy the build output. Source files, index, HEAD, stash —
  # everything in the shared working tree stays exactly as it was.
  echo "[4/5] sync dist/ to shared tree ($REPO)…"
  if [ ! -d "$DEPLOY_WT/dist" ]; then
    echo "RESULT: BUILD_OUTPUT_MISSING — dist/ not found in deploy worktree"
    exit 1
  fi
  # Use rsync with --delete to ensure dist/ exactly matches the build.
  # --backup --backup-dir gives us a rollback if something goes wrong.
  DIST_BACKUP="$REPO/dist.pre-deploy-$(date +%s)"
  if ! rsync -a --delete --backup --backup-dir="$DIST_BACKUP" "$DEPLOY_WT/dist/" "$REPO/dist/" 2>&1; then
    echo "RESULT: RSYNC_FAILED — could not copy dist/ to shared tree"
    exit 1
  fi
  echo "        dist/ synced (backup at $DIST_BACKUP if rollback needed)"
  # Also sync web/dist/ (frontend SPA) if present.
  if [ -d "$DEPLOY_WT/web/dist" ]; then
    WEB_DIST_BACKUP="$REPO/web/dist.pre-deploy-$(date +%s)"
    rsync -a --delete --backup --backup-dir="$WEB_DIST_BACKUP" "$DEPLOY_WT/web/dist/" "$REPO/web/dist/" 2>&1
    echo "        web/dist/ synced (backup at $WEB_DIST_BACKUP if rollback needed)"
  fi

  # Stamp the deployed commit hash into dist/ so /health reports the
  # correct commit even when the shared working tree is on a feature branch.
  #
  # AI-2357: the service's WorkingDirectory is the DEPLOY worktree (drop-in
  # 20-deploy-repo.conf, AI-2305), so resolveStartupCommit() reads
  # $DEPLOY_WT/dist/DEPLOY_COMMIT — NOT the shared tree. Stamping only $REPO
  # left the deploy-worktree stamp frozen at whatever wrote it last, so /health
  # reported a stale commit forever and no deploy could be verified from it.
  # Stamp the tree the service actually runs from; keep $REPO for back-compat.
  printf '%s' "$DEPLOY_COMMIT" > "$DEPLOY_WT/dist/DEPLOY_COMMIT"
  printf '%s' "$DEPLOY_COMMIT" > "$REPO/dist/DEPLOY_COMMIT"

  # ── [4.5/5] Sync workflow YAML definitions to WORKFLOW_DEFS_DIR ────
  echo "[4.5/5] sync workflow YAML definitions to $SHARE/workflows/…"
  WORKFLOW_DEFS_DIR="$SHARE/workflows"
  if [ -d "$DEPLOY_WT/src/registered-defs" ]; then
    if [ -n "$DRY_RUN" ]; then
      echo "        dry-run: would sync yaml files from $DEPLOY_WT/src/registered-defs/ to $WORKFLOW_DEFS_DIR/"
      for f in "$DEPLOY_WT/src/registered-defs/"*.yaml; do
        [ -f "$f" ] && echo "          would copy: $(basename "$f")"
      done
    else
      mkdir -p "$WORKFLOW_DEFS_DIR"
      rsync -a --ignore-existing "$DEPLOY_WT/src/registered-defs/"*.yaml "$WORKFLOW_DEFS_DIR/"
      echo "        workflow YAML definitions synced"
    fi
  else
    echo "        src/registered-defs/ not found — skipping (non-fatal)"
  fi

  # ── [5/5] Restart + health check ────────────────────────────────────────
  echo "[5/5] restart ($SERVICE)…"
  systemctl --user restart "$SERVICE" || { echo "RESULT: FAILED — systemctl restart errored"; exit 1; }

  echo "        health check (http://127.0.0.1:3100/health)…"
  for i in $(seq 1 15); do
    sleep 2
    if curl -sf --max-time 3 http://127.0.0.1:3100/health >/dev/null 2>&1; then
      SHARED_WT=$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)
      # AI-2357: a 200 from /health only proves *something* is listening — it was
      # possible for a deploy to report OK while the live process ran different
      # code (stale stamp, failed swap). Assert the running process reports the
      # commit we just shipped, so RESULT: OK is a verified claim, not a hope.
      LIVE_COMMIT=$(curl -sf --max-time 3 http://127.0.0.1:3100/health 2>/dev/null \
        | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')
      case "$LIVE_COMMIT" in
        "$DEPLOY_COMMIT"*)
          echo "RESULT: OK — deployed $DEPLOY_REF @ $DEPLOY_COMMIT, healthy after $((i*2))s ($(date -Is))"
          echo "        verified: /health reports commit $LIVE_COMMIT"
          echo "        shared working tree UNTOUCHED: $SHARED_WT"
          exit 0
          ;;
        *)
          echo "RESULT: COMMIT_MISMATCH — service is healthy but reports commit '$LIVE_COMMIT', expected '$DEPLOY_COMMIT'."
          echo "        The running process is NOT the code just built. Do NOT treat this as deployed."
          echo "        Check the DEPLOY_COMMIT stamp in $DEPLOY_WT/dist/ and: journalctl --user -u $SERVICE"
          exit 3
          ;;
      esac
    fi
  done
  echo "RESULT: UNHEALTHY — restarted but /health did not pass within 30s. Check: journalctl --user -u $SERVICE"
  exit 2
} > "$RESULT" 2>&1
