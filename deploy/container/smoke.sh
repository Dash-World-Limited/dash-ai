#!/usr/bin/env bash
# LOCAL container smoke test for the DASH AI API image (docs/container.md). Not a staging check.
#
#   deploy/container/smoke.sh [image]        (default image: dash-ai-api:local, built beforehand with
#                                             docker build --platform=linux/amd64)
#
# Everything is throwaway and local: a private Docker network, PostgreSQL 16 and Redis 7, both with
# TLS from a test CA generated for this run, and the API in the first bring-up configuration
# (deploy/staging/staging.env.example + first-bringup.env.example: production mode, demonstration
# providers only, no push). No AI provider, Firebase or cloud service is contacted, no provider key
# exists, and every generated password and key is random and deleted at the end.
#
# The API container runs the way Fargate will run it: non-root, read-only root filesystem, no
# writable mounts, all capabilities dropped, no new privileges.
set -euo pipefail

IMAGE="${1:-dash-ai-api:local}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_ID="dsmoke$$"
NET="$RUN_ID-net"
PG="$RUN_ID-pg"
REDIS="$RUN_ID-redis"
API="$RUN_ID-api"
WORK="$(mktemp -d)"
# Git Bash/MSYS exposes paths such as /tmp/x to shell tools, but native Windows programs such as
# openssl.exe need the corresponding Windows path. Linux/macOS have no cygpath, so this is identity.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
OPENSSL_WORK="$(native_path "$WORK")"
chmod 0755 "$WORK" # the PostgreSQL and Redis containers read their throwaway certificates from it
API_PORT="${SMOKE_API_PORT:-18787}"
BASE="http://127.0.0.1:$API_PORT"

pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*" >&2
  docker logs "$API" 2>&1 | tail -40 >&2 || true
  exit 1
}

cleanup() {
  docker rm -f "$API" "$PG" "$REDIS" "$API-check" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

# --- Throwaway TLS material: a test CA and a PostgreSQL server certificate for the name "pg" -----------
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=DASH smoke test CA" \
  -keyout "$OPENSSL_WORK/ca.key" -out "$OPENSSL_WORK/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=pg" -keyout "$OPENSSL_WORK/server.key" -out "$OPENSSL_WORK/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:pg\n' >"$WORK/san.ext"
openssl x509 -req -in "$OPENSSL_WORK/server.csr" -CA "$OPENSSL_WORK/ca.pem" -CAkey "$OPENSSL_WORK/ca.key" -CAcreateserial \
  -days 1 -extfile "$OPENSSL_WORK/san.ext" -out "$OPENSSL_WORK/server.pem" 2>/dev/null
# Redis gets a certificate from the same CA (ElastiCache in-transit encryption: rediss://).
openssl req -newkey rsa:2048 -nodes -subj "/CN=redis" -keyout "$OPENSSL_WORK/redis.key" -out "$OPENSSL_WORK/redis.csr" 2>/dev/null
printf 'subjectAltName=DNS:redis\n' >"$WORK/redis-san.ext"
openssl x509 -req -in "$OPENSSL_WORK/redis.csr" -CA "$OPENSSL_WORK/ca.pem" -CAkey "$OPENSSL_WORK/ca.key" -CAcreateserial \
  -days 1 -extfile "$OPENSSL_WORK/redis-san.ext" -out "$OPENSSL_WORK/redis.pem" 2>/dev/null
chmod 0644 "$WORK"/*.pem "$WORK/server.key" "$WORK/redis.key"

PG_PASSWORD="$(openssl rand -hex 16)"
REDIS_PASSWORD="$(openssl rand -hex 16)"
DATA_KEY="$(openssl rand -base64 32)"
METRICS_TOKEN="$(openssl rand -hex 24)"
OPERATOR_TOKEN="$(openssl rand -hex 32)"

docker network create "$NET" >/dev/null
# "pg" matches the certificate; "pg-wrong-name" reaches the same server under a name it does not match.
docker run -d --name "$PG" --network "$NET" --network-alias pg --network-alias pg-wrong-name \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=dash_smoke -v "$WORK:/tls:ro" \
  --entrypoint sh postgres:16 -c '
    install -o postgres -g postgres -m 0600 /tls/server.key /tmp/server.key
    install -o postgres -g postgres -m 0644 /tls/server.pem /tmp/server.pem
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.pem -c ssl_key_file=/tmp/server.key' >/dev/null
docker run -d --name "$REDIS" --network "$NET" --network-alias redis -v "$WORK:/tls:ro" redis:7 \
  redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no --port 0 --tls-port 6379 \
  --tls-cert-file /tls/redis.pem --tls-key-file /tls/redis.key --tls-ca-cert-file /tls/ca.pem --tls-auth-clients no >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U postgres -h 127.0.0.1 >/dev/null || fail "PostgreSQL did not start"
redis_ping() { docker exec "$REDIS" redis-cli --tls --cacert /tls/ca.pem -h redis -a "$REDIS_PASSWORD" --no-auth-warning ping 2>/dev/null; }
for _ in $(seq 1 30); do [ "$(redis_ping)" = "PONG" ] && break; sleep 1; done
[ "$(redis_ping)" = "PONG" ] || fail "Redis did not start"

# --- The environment: committed staging template + first bring-up overlay + throwaway secrets ---------
ENV_FILE="$WORK/api.env"
{
  grep -v '^\s*#' "$REPO/deploy/staging/staging.env.example" | grep '='
  grep -v '^\s*#' "$REPO/deploy/staging/first-bringup.env.example" | grep '='
  echo "DATABASE_URL=postgres://postgres:$PG_PASSWORD@pg:5432/dash_smoke"
  echo "DATA_ENCRYPTION_KEY=$DATA_KEY"
  echo "REDIS_URL=rediss://:$REDIS_PASSWORD@redis:6379"
  echo "METRICS_TOKEN=$METRICS_TOKEN"
  echo "OPERATOR_TOKEN=$OPERATOR_TOKEN"
  # The local CA replaces the image's RDS bundle for this run only (same mechanism; see the TLS checks).
  echo "NODE_EXTRA_CA_CERTS=/smoke/ca.pem"
} >"$ENV_FILE"
grep -q '^DATABASE_SSL=require$' "$ENV_FILE" || fail "the staging template no longer sets DATABASE_SSL=require"
grep -q '^PROVIDER_MODE=fake$' "$ENV_FILE" || fail "the first bring-up overlay no longer sets PROVIDER_MODE=fake"

# Fargate-like hardening for every run of the image.
HARDEN=(--read-only --cap-drop ALL --security-opt no-new-privileges --network "$NET")
run_tool() { docker run --rm "${HARDEN[@]}" -v "$WORK/ca.pem:/smoke/ca.pem:ro" --env-file "$ENV_FILE" "$@"; }

# --- A/B. The image targets linux/amd64, runs as non-root, with Node 22 and the expected command ------
# The staging task runs on Fargate X86_64; an image built for another platform must never pass.
platform="$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')"
[ "$platform" = "linux/amd64" ] || fail "the image platform is $platform, expected linux/amd64 (build with --platform=linux/amd64)"
[ "$(docker run --rm --entrypoint uname "$IMAGE" -m)" = "x86_64" ] || fail "the image does not run as x86_64"
pass "image platform: linux/amd64 (runs as x86_64)"
[ "$(docker run --rm --entrypoint id "$IMAGE" -u)" != "0" ] || fail "the image runs as root"
docker run --rm --entrypoint node "$IMAGE" -e 'process.exit(process.versions.node.startsWith("22.") ? 0 : 1)' || fail "not Node 22"
docker run --rm --entrypoint sh "$IMAGE" -c 'test -f dist/index.js && test -f dist/migrate-cli.js && test -f dist/data-cli.js && test -f dist/documents/extractChild.js && test ! -e dist/smoke' \
  || fail "the built API files are not where the image expects them"
pass "image: non-root, Node 22, dist/index.js, migrate/data CLIs and extraction child present, smoke CLI absent"

# --- C. Production configuration fails closed -------------------------------------------------------
# With no configuration at all (the image default is live mode) it refuses before touching anything.
out="$(docker run --rm "${HARDEN[@]}" "$IMAGE" 2>&1)" && fail "started with no configuration"
grep -q "PROVIDER_MODE=live needs real AI provider credentials" <<<"$out" || fail "unexpected refusal with no configuration: $out"
out="$(docker run --rm "${HARDEN[@]}" -e PROVIDER_MODE=fake "$IMAGE" 2>&1)" && fail "started without a database"
grep -q "DATABASE_URL is required in production" <<<"$out" || fail "unexpected refusal without a database: $out"
out="$(docker run --rm "${HARDEN[@]}" -e PROVIDER_MODE=fake -e DATABASE_URL="postgres://postgres:$PG_PASSWORD@pg:5432/dash_smoke" "$IMAGE" 2>&1)" && fail "started without an encryption key"
grep -q "DATA_ENCRYPTION_KEY is required" <<<"$out" || fail "unexpected refusal without an encryption key: $out"
pass "fails closed: no configuration (live mode, no provider keys), no DATABASE_URL, no DATA_ENCRYPTION_KEY"

# --- RDS TLS trust: verification stays on; untrusted or mismatched certificates are refused -----------
# The image's own trust (Node's public CAs + the RDS eu-west-1 roots) does not include the local CA.
docker run --rm "${HARDEN[@]}" --entrypoint node "$IMAGE" -e '
  const fs = require("node:fs"); const tls = require("node:tls");
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  if (extra !== "/etc/dash-ai/certs/rds-eu-west-1-bundle.pem" || !fs.existsSync(extra)) process.exit(2);
  const ours = fs.readFileSync(extra, "utf8").match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g);
  const loaded = new Set(tls.getCACertificates("extra").map((c) => c.replace(/\s/g, "")));
  process.exit(ours.length === 3 && ours.every((c) => loaded.has(c.replace(/\s/g, ""))) ? 0 : 3);
' || fail "the RDS bundle is not loaded as extra CA certificates"
pass "image trust: NODE_EXTRA_CA_CERTS loads the 3 RDS eu-west-1 roots in addition to Node's public CAs"

untrusted_env=(--env-file "$ENV_FILE" -e NODE_EXTRA_CA_CERTS=/etc/dash-ai/certs/rds-eu-west-1-bundle.pem)
out="$(docker run --rm "${HARDEN[@]}" "${untrusted_env[@]}" "$IMAGE" node dist/migrate-cli.js 2>&1)" && fail "connected to a database whose CA the image does not trust"
grep -qiE "certificate|self.signed|unable to verify" <<<"$out" || fail "unexpected error for an untrusted certificate: $out"
pass "untrusted certificate refused with DATABASE_SSL=require (image defaults): $(grep -oiE 'self[- ]signed certificate in certificate chain|unable to verify the first certificate|unable to get local issuer certificate' <<<"$out" | head -1)"

out="$(run_tool -e DATABASE_URL="postgres://postgres:$PG_PASSWORD@pg-wrong-name:5432/dash_smoke" "$IMAGE" node dist/migrate-cli.js 2>&1)" && fail "connected to a host name the certificate does not name"
grep -qiE "altnames|hostname|does not match" <<<"$out" || fail "unexpected error for a host name mismatch: $out"
pass "host name mismatch refused even with the CA trusted"

# --- D. Migrations are a deliberate step with the image's own CLI ------------------------------------
out="$(run_tool "$IMAGE" node dist/migrate-cli.js 2>&1)" || fail "migrations failed: $out"
grep -q "^Applied " <<<"$out" || fail "unexpected migration output: $out"
pass "migrations (verified TLS): $out"
out="$(run_tool "$IMAGE" node dist/migrate-cli.js 2>&1)" || fail "second migration run failed: $out"
grep -q "up to date" <<<"$out" || fail "migrations not idempotent: $out"
pass "migrations idempotent: $out"

start_api() {
  docker run -d --name "$API" "${HARDEN[@]}" -p "127.0.0.1:$API_PORT:8787" \
    -v "$WORK/ca.pem:/smoke/ca.pem:ro" --env-file "$ENV_FILE" "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    curl -sf "$BASE/health" >/dev/null 2>&1 && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$API")" = "true" ] || fail "the API exited during start-up"
    sleep 0.5
  done
  fail "the API did not answer /health"
}

# Slower demonstration streaming (only for this run) so an answer is still in flight at SIGTERM.
start_api -e FAKE_STREAM_DELAY_MS=150
pass "API starts (read-only root filesystem, non-root, no capabilities)"
[ "$(curl -sf "$BASE/health" | json 'd["status"]')" = "ok" ] || fail "/health"
pass "/health: $(curl -sf "$BASE/health")"
for _ in $(seq 1 30); do
  ready="$(curl -s "$BASE/ready")"
  [ "$(json 'd["status"]' <<<"$ready")" = "ready" ] && break
  sleep 1
done
[ "$(json 'd["status"]' <<<"$ready")" = "ready" ] || fail "/ready not ready: $ready"
pass "/ready: $ready"
[ "$(curl -sf "$BASE/v1/assistant" | json 'd["demo"]')" = "True" ] || fail "assistant is not in demonstration mode"
docker logs "$API" 2>&1 | grep '"provider configuration"' | grep -q '"providerMode":"fake"' || fail "provider mode is not fake"
warns="$(docker logs "$API" 2>&1 | grep '"level":40' || true)"
[ "$(grep -c . <<<"$warns")" = "2" ] && ! grep -qv 'PROVIDER_MODE=fake' <<<"$warns" || fail "unexpected start-up warnings: $warns"
pass "provider mode fake/demo only; exactly the 2 expected PROVIDER_MODE=fake warnings; no provider or Firebase key set"
! grep -qE '^(OPENAI_API_KEY|ANTHROPIC_API_KEY|BEDROCK_API_KEY|FCM_SERVICE_ACCOUNT|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=.+' "$ENV_FILE" \
  || fail "a provider, Firebase or AWS credential is set"

# Demonstration chat.
EMAIL="smoke-$RUN_ID@example.com"
PASSWORD="$(openssl rand -hex 12)Aa1!"
reg="$(curl -sf -X POST "$BASE/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"Smoke\"}")" || fail "register"
TOKEN="$(json 'd["token"]' <<<"$reg")"
AUTH=(-H "authorization: Bearer $TOKEN")
CONV="conv$(openssl rand -hex 8)"
curl -sf -X POST "$BASE/v1/conversations" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"id\":\"$CONV\",\"title\":\"Container smoke\"}" >/dev/null || fail "create conversation"
MSG="msg$(openssl rand -hex 8)"
stream="$(curl -sfN -X POST "$BASE/v1/chat/stream" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"conversationId\":\"$CONV\",\"mode\":\"general\",\"message\":{\"id\":\"$MSG\",\"content\":\"Container smoke: say hello.\"}}")" || fail "chat stream"
grep -q '^event: stream.start' <<<"$stream" && grep -q '"demo":true' <<<"$stream" || fail "no demonstration stream start: $stream"
grep -q '^event: stream.end' <<<"$stream" || fail "the stream did not end normally: $stream"
! grep -qiE 'openai|anthropic|bedrock|claude|gpt' <<<"$stream" || fail "the consumer stream names a provider"
pass "demonstration chat streamed (demo: true, stream.end, no provider identity in the consumer stream)"

# --- F. Document extraction in its child process ----------------------------------------------------
python3 - "$WORK" <<'PY'
import sys, zipfile
work = sys.argv[1]
text = "DASH container extraction check"
content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET"
objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
pdf, offsets = "%PDF-1.4\n", []
for i, body in enumerate(objects):
    offsets.append(len(pdf))
    pdf += f"{i + 1} 0 obj\n{body}\nendobj\n"
xref = len(pdf)
pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
open(f"{work}/check.pdf", "wb").write(pdf.encode("latin1"))
with zipfile.ZipFile(f"{work}/check.docx", "w") as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
PY
chmod 0644 "$WORK/check.pdf" "$WORK/check.docx"

# Watch the container's process table while uploading: the parser must run in its own process.
docker exec "$API" sh -c 'for i in $(seq 1 400); do for f in /proc/[0-9]*/cmdline; do tr "\0" " " <"$f" 2>/dev/null; echo; done; done' \
  >"$WORK/procs.txt" 2>/dev/null &
WATCH=$!
for kind in pdf docx; do
  mime=application/pdf
  [ "$kind" = docx ] && mime=application/vnd.openxmlformats-officedocument.wordprocessingml.document
  doc="$(curl -sf -X POST "$BASE/v1/documents" "${AUTH[@]}" -F "file=@$WORK/check.$kind;type=$mime")" || fail "$kind upload"
  [ "$(json 'd["status"]' <<<"$doc")" = "ready" ] && [ "$(json 'd["extractedChars"] > 20' <<<"$doc")" = "True" ] || fail "$kind not extracted: $doc"
  pass "$kind extracted in the container: $(json '{k: d[k] for k in ("kind", "status", "extractedChars", "pageCount")}' <<<"$doc")"
done
wait "$WATCH" || true
grep -qE 'dist/documents/extractChild\.js (pdf|docx)' "$WORK/procs.txt" || fail "no extraction child process was seen"
pass "extraction ran in a child process: $(grep -oE '[^ ]*node --max-old-space-size=[0-9]+ [^ ]*extractChild\.js (pdf|docx)' "$WORK/procs.txt" | sort -u | tr '\n' ';')"
# The child entry point works on its own, with an empty environment, as the server user.
out="$(docker run --rm "${HARDEN[@]}" -i --entrypoint env "$IMAGE" -i /usr/local/bin/node dist/documents/extractChild.js pdf <"$WORK/check.pdf")"
grep -q '"status":"ready"' <<<"$out" || fail "the extraction child failed on its own: $out"
pass "extraction child runs standalone with an empty environment on a read-only filesystem"

# --- SIGTERM: graceful drain, clean exit ------------------------------------------------------------
# An answer is streaming when the platform sends SIGTERM: it must be allowed to finish.
MSG2="msg$(openssl rand -hex 8)"
curl -sN -X POST "$BASE/v1/chat/stream" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"conversationId\":\"$CONV\",\"mode\":\"general\",\"message\":{\"id\":\"$MSG2\",\"content\":\"Second message, in flight at shutdown.\"}}" \
  >"$WORK/inflight.txt" &
INFLIGHT=$!
for _ in $(seq 1 50); do grep -q '^event: stream.start' "$WORK/inflight.txt" 2>/dev/null && break; sleep 0.1; done
docker stop -t 40 "$API" >/dev/null
wait "$INFLIGHT" || true
code="$(docker inspect -f '{{.State.ExitCode}}' "$API")"
logs="$(docker logs "$API" 2>&1)"
grep -q '"signal":"SIGTERM"' <<<"$logs" && grep -q '"shutting down: draining"' <<<"$logs" || fail "SIGTERM did not start the drain"
grep -q '"drain finished"' <<<"$logs" || fail "the drain did not finish"
[ "$code" = "0" ] || fail "exit code after SIGTERM: $code"
grep -q '"activeStreams":1' <<<"$logs" || fail "no answer was in flight at SIGTERM (the check proved nothing)"
grep -q '^event: stream.end' "$WORK/inflight.txt" || fail "the in-flight answer was cut off by SIGTERM: $(tail -c 400 "$WORK/inflight.txt")"
pass "SIGTERM with an answer in flight: drain started (activeStreams 1), the answer finished (stream.end), $(grep -o '"outcome":"[a-z_]*"' <<<"$logs" | head -1), exit code 0"

# --- G. Nothing was written to the container filesystem ---------------------------------------------
# (The /smoke bind-mount point for the test CA is created by Docker, not by the API.)
changes="$(docker diff "$API" | grep -vE '^A /smoke(/ca\.pem)?$' || true)"
[ -z "$changes" ] || fail "the container filesystem changed: $changes"
pass "docker diff is empty: no file was written to the container (read-only root, no writable mounts)"
docker rm "$API" >/dev/null

# --- E. A new container with the same key reads the same encrypted data ----------------------------
start_api
login="$(curl -sf -X POST "$BASE/v1/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")" || fail "login after restart"
TOKEN="$(json 'd["token"]' <<<"$login")"
detail="$(curl -sf "$BASE/v1/conversations/$CONV" -H "authorization: Bearer $TOKEN")" || fail "conversation after restart"
[ "$(json 'd["conversation"]["title"]' <<<"$detail")" = "Container smoke" ] || fail "title not decrypted after restart: $detail"
[ "$(json 'any(m["content"] == "Container smoke: say hello." for m in d["messages"])' <<<"$detail")" = "True" ] || fail "message not decrypted after restart"
[ "$(json 'len(d["messages"])' <<<"$detail")" -ge 4 ] || fail "assistant answer missing after restart"
docs="$(curl -sf "$BASE/v1/documents" -H "authorization: Bearer $TOKEN" | json 'len(d["documents"])')"
[ "$docs" = "2" ] || fail "documents after restart: $docs"
enc="$(docker exec "$PG" psql -U postgres -d dash_smoke -Atc "select count(*) from messages where content like '%Container smoke%'")"
[ "$enc" = "0" ] || fail "message content is stored in plaintext"
pass "new container, same key: conversation title, messages and documents decrypt; content is not plaintext in PostgreSQL"
docker stop -t 40 "$API" >/dev/null
docker rm "$API" >/dev/null

# A different key must not silently read or overwrite the data: the server refuses to start.
out="$(timeout 60 docker run --rm "${HARDEN[@]}" -v "$WORK/ca.pem:/smoke/ca.pem:ro" --env-file "$ENV_FILE" \
  -e DATA_ENCRYPTION_KEY="$(openssl rand -base64 32)" "$IMAGE" 2>&1)" && fail "started with a different DATA_ENCRYPTION_KEY"
grep -q "DATA_ENCRYPTION_KEY does not match" <<<"$out" || fail "unexpected result with a different key: $out"
pass "a different DATA_ENCRYPTION_KEY is refused at start-up (no data read or overwritten)"

echo "All local container checks passed for $IMAGE."
