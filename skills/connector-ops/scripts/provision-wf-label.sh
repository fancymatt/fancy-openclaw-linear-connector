#!/usr/bin/env bash
set -euo pipefail

: "${LINEAR_PROXY_URL:=http://127.0.0.1:3100/proxy}"
: "${LINEAR_OAUTH_TOKEN:=}"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <team-key> <label-name>"
  echo "Example: $0 INF wf:dev-impl"
  echo ""
  echo "Provisions a label on the given team via the Linear proxy."
  exit 1
fi

TEAM_KEY="$1"
LABEL_NAME="$2"

if [ -z "$LINEAR_OAUTH_TOKEN" ]; then
  if [ -f ~/.openclaw/.secrets/linear.env ]; then
    # shellcheck disable=SC1091
    LINEAR_OAUTH_TOKEN=$(grep -E '^LINEAR_OAUTH_TOKEN=' ~/.openclaw/.secrets/linear.env | cut -d= -f2-)
  fi
fi

if [ -z "$LINEAR_OAUTH_TOKEN" ]; then
  echo "ERROR: LINEAR_OAUTH_TOKEN not set." >&2
  exit 1
fi

echo "=== Provision Label ==="
echo "Team: $TEAM_KEY"
echo "Label: $LABEL_NAME"
echo ""

# First, resolve the team ID from the key
TEAM_RESPONSE=$(curl -sf -X POST "$LINEAR_PROXY_URL/graphql" \
  -H "Authorization: $LINEAR_OAUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"{ team(key: \\\"$TEAM_KEY\\\") { id name } }\"}" 2>&1)

TEAM_ID=$(echo "$TEAM_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['team']['id'])" 2>/dev/null) || {
  echo "ERROR: Could not resolve team key '$TEAM_KEY'. Response:" >&2
  echo "$TEAM_RESPONSE" >&2
  exit 1
}

echo "Team ID: $TEAM_ID"

# Create the label
LABEL_RESPONSE=$(curl -sf -X POST "$LINEAR_PROXY_URL/graphql" \
  -H "Authorization: $LINEAR_OAUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { issueLabelCreate(input: { name: \\\"$LABEL_NAME\\\", teamId: \\\"$TEAM_ID\\\" }) { success label { id name } } }\"}" 2>&1)

echo ""
echo "$LABEL_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$LABEL_RESPONSE"
