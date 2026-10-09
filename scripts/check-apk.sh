#!/usr/bin/env bash
# Fails if the built APK contains AI-provider credentials or provider API endpoints.
# The Android app must only ever talk to the Dash AI API.
set -euo pipefail
APK="${1:?usage: check-apk.sh path/to/app.apk}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q -o "$APK" -d "$WORK"
PATTERN='sk-ant-(api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}|sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|api\.openai\.com|api\.anthropic\.com|bedrock-runtime\.[A-Za-z0-9-]+\.amazonaws\.com|OPENAI_API_KEY|ANTHROPIC_API_KEY|BEDROCK_API_KEY'
if grep -rEaoh "$PATTERN" "$WORK" | sort -u | grep .; then
  echo "::error::The APK contains provider credentials or provider endpoints (see matches above)."
  exit 1
fi
echo "APK check passed: no provider keys or provider endpoints in $(basename "$APK")."
