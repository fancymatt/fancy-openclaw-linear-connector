#!/usr/bin/env bash
set -euo pipefail

: "${CONNECTOR_BASE_URL:=http://127.0.0.1:3100}"
: "${CONNECTOR_ADMIN_SECRET:=}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <ticket-id>"
  echo "Example: $0 INF-123"
  exit 1
fi

TICKET_ID="$1"

if [ -z "$CONNECTOR_ADMIN_SECRET" ]; then
  if [ -f .env ]; then
    # shellcheck disable=SC1091
    CONNECTOR_ADMIN_SECRET=$(grep -E '^ADMIN_SECRET=' .env | cut -d= -f2-)
  fi
fi

if [ -z "$CONNECTOR_ADMIN_SECRET" ]; then
  echo "ERROR: CONNECTOR_ADMIN_SECRET not set." >&2
  exit 1
fi

echo "=== Redispatch Ticket: $TICKET_ID ==="
RESPONSE=$(curl -sf -X POST "$CONNECTOR_BASE_URL/admin/api/redispatch" \
  -H "Authorization: Bearer $CONNECTOR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"ticketId\": \"$TICKET_ID\"}" 2>&1) || {
    echo "ERROR: Redispatch request failed." >&2
    echo "$RESPONSE" >&2
    exit 1
  }

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""
echo "Ticket $TICKET_ID redispatched."
