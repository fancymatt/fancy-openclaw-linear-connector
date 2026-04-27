#!/usr/bin/env bash
# sync-linear-token.sh — Pull Linear OAuth token from the connector
#
# Environment variables (or positional args):
#   CONNECTOR_URL  — base URL of the connector (e.g. https://ill.fcy.sh)
#   AGENT_NAME     — agent name in agents.json
#   TOKEN_SYNC_SECRET — shared secret for bearer auth
#   OUTPUT_PATH    — where to write linear.env (default: $HOME/.openclaw/workspace-$AGENT_NAME/.secrets/linear.env)
#
# Usage:
#   ./sync-linear-token.sh
#   CONNECTOR_URL=https://ill.fcy.sh AGENT_NAME=sakura TOKEN_SYNC_SECRET=xxx ./sync-linear-token.sh
#   ./sync-linear-token.sh https://ill.fcy.sh sakura my-secret /path/to/output.env

set -euo pipefail

CONNECTOR_URL="${1:-${CONNECTOR_URL:?CONNECTOR_URL is required}}"
AGENT_NAME="${2:-${AGENT_NAME:?AGENT_NAME is required}}"
SECRET="${3:-${TOKEN_SYNC_SECRET:?TOKEN_SYNC_SECRET is required}}"
OUTPUT_PATH="${4:-${OUTPUT_PATH:-$HOME/.openclaw/workspace-$AGENT_NAME/.secrets/linear.env}}"

TMP_PATH="${OUTPUT_PATH}.tmp.$(date +%s)"

# Fetch token from connector
HTTP_CODE=$(curl -s -o "$TMP_PATH.response" -w '%{http_code}' \
  -H "Authorization: Bearer $SECRET" \
  "${CONNECTOR_URL}/tokens/${AGENT_NAME}")

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "ERROR: Token fetch failed (HTTP $HTTP_CODE)" >&2
  cat "$TMP_PATH.response" >&2
  rm -f "$TMP_PATH.response"
  exit 1
fi

# Extract access_token from JSON response
ACCESS_TOKEN=$(python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" < "$TMP_PATH.response" 2>/dev/null || \
  jq -r '.access_token' < "$TMP_PATH.response" 2>/dev/null)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: Could not parse access_token from response" >&2
  rm -f "$TMP_PATH.response"
  exit 1
fi

rm -f "$TMP_PATH.response"

# Atomic write: write to tmp file, then mv
mkdir -p "$(dirname "$OUTPUT_PATH")"
printf 'LINEAR_OAUTH_TOKEN=%s\n' "$ACCESS_TOKEN" > "$TMP_PATH"
chmod 600 "$TMP_PATH"
mv -f "$TMP_PATH" "$OUTPUT_PATH"

echo "OK: Token synced for $AGENT_NAME → $OUTPUT_PATH"
