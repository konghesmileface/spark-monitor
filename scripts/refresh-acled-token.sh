#!/usr/bin/env bash
# Refresh ACLED API token using OAuth endpoint.
# Token valid 24h, refresh_token valid 14d.
#
# Usage:
#   ./scripts/refresh-acled-token.sh                # use credentials from .env.local
#   ./scripts/refresh-acled-token.sh --refresh       # use refresh_token instead of password
#
# Can be added to crontab for automatic refresh:
#   0 */12 * * * cd /path/to/worldmonitor && ./scripts/refresh-acled-token.sh >> /tmp/acled-refresh.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env.local"
PROXY="${HTTP_PROXY:-${HTTPS_PROXY:-}}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[ACLED] ERROR: .env.local not found at $ENV_FILE"
  exit 1
fi

# Read credentials from .env.local
ACLED_EMAIL=$(grep '^ACLED_EMAIL=' "$ENV_FILE" | cut -d= -f2-)
ACLED_PASSWORD=$(grep '^ACLED_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
ACLED_REFRESH_TOKEN=$(grep '^ACLED_REFRESH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)

CURL_PROXY_ARGS=""
if [ -n "$PROXY" ]; then
  CURL_PROXY_ARGS="-x $PROXY"
fi

# Decide: use refresh_token or password
if [ "${1:-}" = "--refresh" ] && [ -n "$ACLED_REFRESH_TOKEN" ]; then
  echo "[ACLED] $(date '+%Y-%m-%d %H:%M:%S') Refreshing token via refresh_token..."
  RESPONSE=$(curl -s -X POST "https://acleddata.com/oauth/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "refresh_token=${ACLED_REFRESH_TOKEN}&grant_type=refresh_token&client_id=acled" \
    $CURL_PROXY_ARGS 2>&1)
else
  if [ -z "$ACLED_EMAIL" ] || [ -z "$ACLED_PASSWORD" ]; then
    echo "[ACLED] ERROR: ACLED_EMAIL or ACLED_PASSWORD not found in .env.local"
    exit 1
  fi
  echo "[ACLED] $(date '+%Y-%m-%d %H:%M:%S') Refreshing token via email/password..."
  RESPONSE=$(curl -s -X POST "https://acleddata.com/oauth/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=${ACLED_EMAIL}&password=${ACLED_PASSWORD}&grant_type=password&client_id=acled" \
    $CURL_PROXY_ARGS 2>&1)
fi

# Parse response
NEW_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['access_token'])" 2>/dev/null || true)
NEW_REFRESH=$(echo "$RESPONSE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('refresh_token',''))" 2>/dev/null || true)

if [ -z "$NEW_TOKEN" ]; then
  echo "[ACLED] ERROR: Failed to get new token. Response:"
  echo "$RESPONSE"
  exit 1
fi

# Update .env.local — replace token lines
OLD_TOKEN=$(grep '^ACLED_ACCESS_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
if [ -n "$OLD_TOKEN" ]; then
  # Use python for safe replacement (tokens contain special chars)
  python3 -c "
import re, sys
with open('$ENV_FILE', 'r') as f:
    content = f.read()
content = re.sub(r'^ACLED_ACCESS_TOKEN=.*$', 'ACLED_ACCESS_TOKEN=$NEW_TOKEN', content, flags=re.MULTILINE)
if '$NEW_REFRESH':
    content = re.sub(r'^ACLED_REFRESH_TOKEN=.*$', 'ACLED_REFRESH_TOKEN=$NEW_REFRESH', content, flags=re.MULTILINE)
with open('$ENV_FILE', 'w') as f:
    f.write(content)
"
  echo "[ACLED] Token updated successfully. Expires in 24h."
  # Show expiry
  python3 -c "
import json, base64, datetime
token = '$NEW_TOKEN'
payload = token.split('.')[1]
payload += '=' * (4 - len(payload) % 4)
d = json.loads(base64.urlsafe_b64decode(payload))
exp = datetime.datetime.fromtimestamp(d['exp'])
print(f'[ACLED] New token expires: {exp.strftime(\"%Y-%m-%d %H:%M:%S\")}')
" 2>/dev/null || true
else
  echo "[ACLED] WARNING: Could not find ACLED_ACCESS_TOKEN in .env.local"
  echo "[ACLED] New token: ${NEW_TOKEN:0:50}..."
fi
