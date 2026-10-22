#!/usr/bin/env bash
# Throwaway local PostgreSQL 16 that accepts TCP only over TLS (like rds.force_ssl=1), with a test CA,
# for test_ops_scripts.py. Local only: nothing here talks to AWS.
#
#   deploy/aws/tests/tls-postgres.sh start <dir>   # prints the DASH_OPS_TEST_* variables to export
#   deploy/aws/tests/tls-postgres.sh stop <dir>
set -euo pipefail

cmd="${1:?start|stop}"
dir="$(realpath -m "${2:?directory}")"
bin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
port="${PG_TEST_PORT:-55432}"

# initdb refuses to run as root: use the postgres account when we are root (containers).
as_owner() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }

if [ "$cmd" = stop ]; then
  as_owner "'$bin/pg_ctl' -D '$dir/data' -m fast stop" || true
  exit 0
fi

[ -e "$dir/data" ] && { echo "$dir already holds a cluster: stop it and remove the directory first" >&2; exit 1; }
mkdir -p "$dir"
cd "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 1 -subj "/CN=dash-ops-test-ca" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf "subjectAltName=DNS:localhost\n" >ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.crt -days 1 -extfile ext.cnf 2>/dev/null
admin_password="$(openssl rand -hex 16)"
printf '%s\n' "$admin_password" >pwfile
chmod 600 server.key pwfile
[ "$(id -u)" = 0 ] && chown -R postgres "$dir"

as_owner "'$bin/initdb' -D '$dir/data' -U postgres -A scram-sha-256 --pwfile='$dir/pwfile' >/dev/null"
cat >>"$dir/data/postgresql.conf" <<EOF
listen_addresses = 'localhost'
port = $port
unix_socket_directories = '$dir'
ssl = on
ssl_cert_file = '$dir/server.crt'
ssl_key_file = '$dir/server.key'
ssl_min_protocol_version = 'TLSv1.2'
EOF
# TCP is TLS-only; the local socket is for the test's own setup and cleanup.
cat >"$dir/data/pg_hba.conf" <<EOF
local all postgres scram-sha-256
hostssl all all 127.0.0.1/32 scram-sha-256
hostssl all all ::1/128 scram-sha-256
EOF
[ "$(id -u)" = 0 ] && chown postgres "$dir/data/postgresql.conf" "$dir/data/pg_hba.conf"
as_owner "'$bin/pg_ctl' -D '$dir/data' -l '$dir/server.log' -w start >/dev/null"

echo "export DASH_OPS_TEST_ADMIN='host=$dir port=$port user=postgres dbname=postgres password=$admin_password'"
echo "export DASH_OPS_TEST_PGHOST=localhost DASH_OPS_TEST_PGPORT=$port DASH_OPS_TEST_CA='$dir/ca.pem'"
