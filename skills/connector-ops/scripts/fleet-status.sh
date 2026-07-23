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
  echo "ERROR: CONNECTOR_ADMIN_SECRET not set. Set it or create a .env with ADMIN_SECRET=..." >&2
  exit 1
fi

echo "=== Fleet Status ==="
echo "Base URL: $CONNECTOR_BASE_URL"
echo ""

curl -sf "$CONNECTOR_BASE_URL/admin/api/fleet" \
  -H "Authorization: Bearer $CONNECTOR_ADMIN_SECRET" \
  -H "Accept: application/json" \
  | python3 -m json.tool 2>/dev/null || {
    echo "ERROR: Failed to fetch fleet status. Check CONNECTOR_BASE_URL and ADMIN_SECRET." >&2
    exit 1
  }
