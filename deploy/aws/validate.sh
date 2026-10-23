#!/usr/bin/env bash
# Offline validation of the DASH AI staging infrastructure code. Never calls AWS: every AWS credential
# variable is removed from the environment first, and nothing here needs one.
#
#   deploy/aws/validate.sh            # cfn-lint + policy tests
#   deploy/aws/validate.sh --ops-db   # also the one-off database scripts against a local TLS PostgreSQL 16
#                                     # (needs: pnpm install, the API built, PostgreSQL 16 binaries, psql)
#
# Uses python3 and cfn-lint from PATH; install the pinned tools first:
#   python3 -m pip install --require-hashes -r deploy/aws/requirements.txt
set -euo pipefail
for v in $(env | grep -oE '^AWS_[A-Z_]+' || true); do unset "$v"; done
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

echo "== cfn-lint"
cfn-lint deploy/aws/templates/*.yaml
echo "== policy tests"
python3 -m unittest discover -s deploy/aws/tests -p 'test_templates.py'
echo "== bring-up helper and runbook (no AWS: a recording stand-in replaces the aws command)"
python3 -m unittest discover -s deploy/aws/tests -p 'test_bringup_helper.py'

if [ "${1:-}" = "--ops-db" ]; then
  dir="$(mktemp -d)"
  chmod 755 "$dir"
  trap 'deploy/aws/tests/tls-postgres.sh stop "$dir/pg" >/dev/null 2>&1; rm -rf "$dir"' EXIT
  eval "$(deploy/aws/tests/tls-postgres.sh start "$dir/pg")"
  echo "== one-off database scripts (local TLS PostgreSQL)"
  python3 -m unittest discover -s deploy/aws/tests -p 'test_ops_scripts.py' -v
fi
echo "OK: no AWS API was called."
