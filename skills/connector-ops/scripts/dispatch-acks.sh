#!/usr/bin/env bash
set -euo pipefail

: "${CONNECTOR_BASE_URL:=http://127.0.0.1:3100}"
: "${CONNECTOR_ADMIN_SECRET:=}"

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

echo "=== Dispatch Acknowledgments ==="
curl -sf "$CONNECTOR_BASE_URL/admin/api/dispatch-acks" \
  -H "Authorization: Bearer $CONNECTOR_ADMIN_SECRET" \
  -H "Accept: application/json" \
  | python3 -m json.tool 2>/dev/null || {
    echo "ERROR: Failed to fetch dispatch acks." >&2
    exit 1
  }
