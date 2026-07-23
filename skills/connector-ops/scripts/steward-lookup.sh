#!/usr/bin/env bash
set -euo pipefail

: "${CONNECTOR_BASE_URL:=http://127.0.0.1:3100}"
: "${LINEAR_PROXY_URL:=http://127.0.0.1:3100/proxy}"
: "${CONNECTOR_ADMIN_SECRET:=}"
: "${LINEAR_OAUTH_TOKEN:=}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <ticket-id>"
  echo "Example: $0 INF-123"
  exit 1
fi

TICKET_ID="$1"

# Resolve secrets
if [ -z "$CONNECTOR_ADMIN_SECRET" ] && [ -f .env ]; then
  # shellcheck disable=SC1091
  CONNECTOR_ADMIN_SECRET=$(grep -E '^ADMIN_SECRET=' .env | cut -d= -f2-)
fi
if [ -z "$LINEAR_OAUTH_TOKEN" ] && [ -f ~/.openclaw/.secrets/linear.env ]; then
  # shellcheck disable=SC1091
  LINEAR_OAUTH_TOKEN=$(grep -E '^LINEAR_OAUTH_TOKEN=' ~/.openclaw/.secrets/linear.env | cut -d= -f2-)
fi

echo "=== Steward Lookup: $TICKET_ID ==="
echo ""

# 1. Fetch engagement/admin state from the connector
if [ -n "$CONNECTOR_ADMIN_SECRET" ]; then
  echo "--- Connector Admin State ---"
  curl -sf "$CONNECTOR_BASE_URL/admin/api/engagement/$TICKET_ID" \
    -H "Authorization: Bearer $CONNECTOR_ADMIN_SECRET" \
    -H "Accept: application/json" \
    | python3 -m json.tool 2>/dev/null || echo "(no admin engagement data)"
  echo ""
fi

# 2. Fetch current issue state from Linear
if [ -n "$LINEAR_OAUTH_TOKEN" ]; then
  echo "--- Linear Issue State ---"
  curl -sf -X POST "$LINEAR_PROXY_URL/graphql" \
    -H "Authorization: $LINEAR_OAUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"{ issue(id: \\\"$TICKET_ID\\\") { identifier title state { name type } assignee { name } description \`delegate\` { ... on User { name } } } }\"}" \
    | python3 -m json.tool 2>/dev/null || echo "(could not fetch Linear state)"
fi
