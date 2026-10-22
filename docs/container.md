# DASH AI API container image

The API ships as one container image, built by the repository's `Dockerfile`. It is the unit the
approved staging architecture will run (AWS eu-west-1: ALB → ECS Fargate → private RDS PostgreSQL 16
and private ElastiCache Redis 7). **Nothing in this repository provisions or deploys that
infrastructure**: there is no registry push, no deployment workflow and no cloud credential here.
This page describes the image and how it is verified locally.

## What the image contains

| | |
|---|---|
| Base | `node:22-bookworm-slim`, pinned by digest (Node 22.23.4, Debian 12); Dockerfile frontend `docker/dockerfile:1` also pinned by digest |
| Platform | `linux/amd64` only (ECS Fargate runtime platform `X86_64`) |
| Contents | `/app/apps/api/dist` (compiled API, without the live smoke CLI), `/app/packages/contracts/dist`, the locked **production** dependencies only, and `/etc/dash-ai/certs/rds-eu-west-1-bundle.pem` |
| Not included | source, tests, fixtures, the web and Android apps, development dependencies (TypeScript, tsx, Vitest, ESLint), npm/corepack/yarn, `.git`, any `.env` file, any key or credential |
| User | `1000:1000` (the base image's unprivileged `node` user); application files are owned by root and read-only to it |
| Working directory | `/app/apps/api` |
| Command | `node dist/index.js` (exec form, no entrypoint script, no shell, no init) |
| Port | `8787` (`PORT`, the existing default) |
| Built-in environment | `NODE_ENV=production`, `NODE_EXTRA_CA_CERTS=/etc/dash-ai/certs/rds-eu-west-1-bundle.pem` |
| Size | **286,711,998 bytes (≈ 287 MB) uncompressed** for commit 691f8a1, as measured by `docker image inspect --format '{{.Size}}'` in the CI `container` job (GitHub `ubuntu-latest`, classic Docker image store); compressed layers ≈ 91 MB (sum of the gzip layer blobs in `docker save`, measured locally; not a registry measurement) |

Everything else (database, Redis, keys, tokens, provider settings) comes from the task's environment
and secret manager at run time. No secret is a build input: the build has no `ARG` for one, and the
optional `build_ca` (below) is a BuildKit secret mount that never reaches a layer or the history.

The size is always quoted with the CI definition above: the `.Size` that the CI `container` job prints
in its "Image summary" step. Docker Desktop and engines using the containerd image store report a
larger local "disk usage" (on the machine that built this, `.Size` was about 441 MB for the same
image) because they count unpacked snapshots and the stored compressed layers together; that figure is
local storage accounting, not image content, and is not comparable.

### One image, three commands

| Purpose | Command |
|---|---|
| API server (the service) | default: `node dist/index.js` |
| Migrations (a deliberate one-off task before a release; `DATABASE_AUTO_MIGRATE=false` in production) | `node dist/migrate-cli.js` |
| Encryption maintenance (after a key rotation) | `node dist/data-cli.js` |

The one-off commands need the same `DATABASE_URL`, `DATABASE_SSL` and (for `data-cli`)
`DATA_ENCRYPTION_KEY` as the service.

### Signals and shutdown

Node runs as PID 1 and installs its own `SIGTERM`/`SIGINT` handlers (`src/index.ts`): on SIGTERM the
instance reports `/ready` 503 ("draining"), lets in-flight answers finish for up to
`SHUTDOWN_DRAIN_MS` (staging: 20 s), then closes the database and Redis and exits 0. No init process
is needed: the only child processes are the document parsers, which the server spawns, waits for and
reaps itself, and which exit on their own if the server disappears. Set the ECS container
`stopTimeout` above `SHUTDOWN_DRAIN_MS` (for example 30 s; the server itself gives up 15 s after the
drain window) and the ALB target group's deregistration delay to at least the drain window.

### Filesystem

The API writes nothing to its filesystem: all state is in PostgreSQL and Redis, uploads are held in
memory, and document text is parsed from stdin by a child process. The image works with a read-only
root filesystem and no writable volume (`readonlyRootFilesystem: true` on Fargate); the local smoke
test runs it that way and checks `docker diff` is empty.

### Document extraction

PDF and DOCX files are parsed in a separate `node dist/documents/extractChild.js` process with an
empty environment (no database URL, key or token reaches it), a 384 MB heap, a 640 MB resident-memory
watchdog and a raised OOM score. Two run at once per instance by default
(`DOCUMENT_EXTRACTION_CONCURRENCY=2`).

### Fargate size

Start at **0.5 vCPU / 2 GB** per task, as the staging plan says. The server itself idles at roughly
85–135 MB, but each extraction process may reach 640 MB before it is stopped, so two concurrent
extractions plus the server and its in-memory upload queue need about 1.5 GB at the worst moment. Do
not lower the memory without measuring extraction load on the real task size; raise it if
`DOCUMENT_EXTRACTION_CONCURRENCY` is raised.

## Database TLS: the Amazon RDS CA bundle

Production defaults to `DATABASE_SSL=require`, which verifies the database certificate and host name
against the CAs Node trusts. Node's built-in list is Mozilla's public roots, which do not include the
Amazon RDS CAs that sign RDS server certificates, so without more trust every RDS connection would
fail verification. The fix is to add exactly the RDS roots, not to relax verification:
`DATABASE_SSL=no-verify` and `NODE_TLS_REJECT_UNAUTHORIZED=0` are never used.

- **Source**: AWS's official regional bundle for eu-west-1,
  `https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem` (AWS documentation:
  "Using SSL/TLS to encrypt a connection to a DB instance", certificate bundles by AWS Region). It is
  public certificate material, not a secret.
- **Content**: three self-signed root CAs, the region's current RDS roots: *Amazon RDS eu-west-1 Root
  CA RSA2048 G1* (the default for new instances, valid to 2061), *RSA4096 G1* and *ECC384 G1* (to 2121).
  All three are also in AWS's global bundle. No private key.
- **Pinned**: committed at `deploy/container/certs/rds-eu-west-1-bundle.pem` with its SHA-256
  (`a11cf9a1d0aadd7db86f92cbaa496466daeb501bf1c5e429d8ce8914a01c15d6`) in
  `deploy/container/certs/SHA256SUMS`; the image build fails if they disagree. Nothing is downloaded at
  build or start-up time. The checksum file only proves the image carries **the committed file,
  unchanged**; it does not prove where that file came from (both were committed together).
- **Provenance: NOT YET INDEPENDENTLY VERIFIED (deployment blocker).** The committed bundle was
  downloaded through the egress proxy of the build session that created this change. The certificate
  subjects match AWS's documented eu-west-1 CA families (RSA2048 G1, RSA4096 G1, ECC384 G1), but the
  exact bytes have not been compared with a download made on a trusted machine. See "Before the first
  staging deployment" below.
- **Included**: copied to `/etc/dash-ai/certs/` and named by `NODE_EXTRA_CA_CERTS`. Node reads that
  variable once at start-up and **adds** the certificates to its built-in roots; nothing is replaced,
  and verification (`rejectUnauthorized: true`, host-name check) is unchanged. The document parser
  process gets an empty environment and makes no network connections, so it is unaffected.
- **Why this is narrow**: the regional bundle trusts only the RDS roots for eu-west-1 (3 certificates),
  not the global bundle (over 100 certificates for every region) and not a system-wide store change.
  These roots only issue RDS server certificates. The extra trust is process-wide in the API, so
  provider HTTPS endpoints would in principle also accept a certificate chained to an RDS root; AWS
  does not issue such certificates for other names.
- **Proved locally** (`deploy/container/smoke.sh`): the image loads exactly these 3 roots; a database
  whose certificate comes from any other CA is refused with `DATABASE_SSL=require` ("unable to verify
  the first certificate"); a certificate for a different host name is refused even when its CA is
  trusted; only a deliberately trusted CA connects.

### Before the first staging deployment: verify the bundle's provenance

**Deployment blocker.** No image built from this repository may be deployed to staging until this is
done and recorded. On an approved, trusted workstation (not through the session or proxy that created
the commit):

```sh
curl -fsS -o /tmp/eu-west-1-bundle.pem https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem
sha256sum /tmp/eu-west-1-bundle.pem deploy/container/certs/rds-eu-west-1-bundle.pem
for f in /tmp/eu-west-1-bundle.pem deploy/container/certs/rds-eu-west-1-bundle.pem; do
  openssl crl2pkcs7 -nocrl -certfile "$f" | openssl pkcs7 -print_certs | \
    awk '/BEGIN/{c=""} {c=c $0 "\n"} /END/{printf "%s", c | "openssl x509 -noout -subject -fingerprint -sha256"; close("openssl x509 -noout -subject -fingerprint -sha256")}'
done
```

Both SHA-256 values must be identical, and both files must list the same three certificates with the
same SHA-256 fingerprints. The committed file is expected to have
SHA-256 `a11cf9a1d0aadd7db86f92cbaa496466daeb501bf1c5e429d8ce8914a01c15d6` and these fingerprints:

| Certificate | SHA-256 fingerprint |
|---|---|
| Amazon RDS eu-west-1 Root CA RSA2048 G1 | `6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86` |
| Amazon RDS eu-west-1 Root CA RSA4096 G1 | `62:E2:9E:F9:03:10:94:7E:ED:5D:55:46:02:1D:63:60:08:FA:D3:29:FA:B9:EA:31:BA:1A:E7:68:B7:34:F2:9A` |
| Amazon RDS eu-west-1 Root CA ECC384 G1 | `88:EC:F0:27:44:8F:71:98:F3:C1:A6:76:24:74:C4:65:8D:AB:35:A1:86:86:AF:6B:65:DE:3C:40:23:C6:D0:B2` |

If anything differs, do not deploy: replace the bundle with the trusted download in a reviewed pull
request (steps below) and investigate. Record who checked, when, and from which machine.

### Updating the bundle when AWS rotates roots

1. On an approved workstation, download the regional bundle from the URL above over HTTPS and compare
   it with AWS's global bundle and the AWS documentation for eu-west-1 (subjects, validity dates).
2. Replace `deploy/container/certs/rds-eu-west-1-bundle.pem`, run
   `cd deploy/container/certs && sha256sum rds-eu-west-1-bundle.pem > SHA256SUMS`, and review the
   diff in a pull request (certificate subjects and fingerprints:
   `openssl crl2pkcs7 -nocrl -certfile rds-eu-west-1-bundle.pem | openssl pkcs7 -print_certs -noout`).
3. Keep the old roots in the bundle until every RDS instance has been moved to the new CA (RDS shows
   the instance's CA in the console and `describe-db-instances`), then remove them in a later change.
4. Rebuild and roll out the image **before** changing an RDS instance's certificate authority.

If the database is ever moved to another region, use that region's bundle and file name.

### Redis TLS

ElastiCache with in-transit encryption is expected to present a certificate chained to a public
Amazon Trust Services root, which Node already trusts, so `REDIS_URL=rediss://…` should need no extra
CA. This is not yet verified against a real ElastiCache endpoint: confirm it in the staging smoke
test before relying on it (never by disabling verification). The local smoke test uses TLS Redis.

## Build

```sh
docker build --platform=linux/amd64 -t dash-ai-api:local .
```

**Target platform.** The image is built for `linux/amd64` only, and the ECS task definition must use
runtime platform `operatingSystemFamily: LINUX`, `cpuArchitecture: X86_64`. Always pass
`--platform=linux/amd64`: without it Docker builds for the host, so an ARM (Apple silicon or Graviton)
machine would produce an ARM image that an X86_64 task cannot run. `smoke.sh` and the CI job fail on
any image that is not `linux/amd64`. On an ARM machine the build and smoke test run under emulation
(slower, same result). A multi-architecture (arm64/Graviton) image is a possible later change, not part
of this one.

The build installs from `pnpm-lock.yaml` with `--frozen-lockfile`, compiles the contracts package and
the API, then installs the production dependency set into a fresh tree (offline, from the same
lockfile). `.dockerignore` is an allowlist: only the manifests, the lockfile, the API and contracts
sources and the RDS bundle enter the build context, with secret-shaped names excluded again inside
them.

Behind a TLS-inspecting proxy (corporate network or sandbox), give the build the proxy's CA as a
BuildKit secret, used only for the dependency download and never stored:
`docker build --platform=linux/amd64 --secret id=build_ca,src=/path/to/proxy-ca.pem -t dash-ai-api:local .`

### Updating the base image and the Dockerfile frontend

Two things are pinned by digest and are updated together, deliberately, in one reviewed pull request:

- **Node base image**: `NODE_IMAGE` in the `Dockerfile`. Run `docker pull node:22-bookworm-slim` and
  use the digest it prints (a multi-platform index digest; `--platform=linux/amd64` picks the amd64
  image from it). Stay on Node 22 (the repository's `engines`).
- **Dockerfile frontend**: the first line, `# syntax=docker/dockerfile:1@sha256:…`. This is the
  BuildKit parser for the Dockerfile itself; unpinned, `docker/dockerfile:1` can change between two
  builds of the same commit. Run `docker buildx imagetools inspect docker/dockerfile:1` (or read the
  `resolve docker.io/docker/dockerfile:1@sha256:…` line of a `docker build --progress=plain` log) and
  use the digest it shows. Stay on major version 1. The current pin,
  `sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e`, is the digest
  `docker/dockerfile:1` resolved to in CI run #246 and in local builds on 2026-10-22.

After changing either: build with `--platform=linux/amd64` (with and without the `build_ca` secret if
you use one), run `deploy/container/smoke.sh`, and record the new CI image size.

## Local verification

```sh
docker build --platform=linux/amd64 -t dash-ai-api:local .
deploy/container/smoke.sh dash-ai-api:local
```

`smoke.sh` is a **local** check (it also runs in CI), not a staging test. It starts throwaway
PostgreSQL 16 and Redis 7 containers with TLS from a CA generated for the run, and runs the image the
way Fargate will (non-root, read-only root filesystem, no capabilities, no new privileges) with the
committed staging template plus the first bring-up overlay (production mode, demonstration providers
only, no push; `deploy/staging/`). It checks: the image platform (`linux/amd64`); the image layout and user; fail-closed start-up without
configuration, database or encryption key; RDS trust and TLS refusal; migrations through the image's
CLI (and idempotence); `/health`, `/ready`; demonstration-only provider mode with no provider or
Firebase key; a demonstration chat; PDF and DOCX extraction in a child process; SIGTERM with an answer
in flight (drained, exit 0); no file written; a new container decrypting the same data with the same
key; and a different key refused. No provider, Firebase or cloud service is contacted.

## Image path to staging (prepared, not executed)

GitHub (reviewed commit, CI green) → `docker build --platform=linux/amd64` on an approved workstation
→ local smoke → push to the private, tag-immutable Amazon ECR repository `dash-ai-staging/api`
(eu-west-1) → resolve the image **digest** → ECS Fargate task definition (runtime platform `LINUX` /
`X86_64`) referencing `<repository>@sha256:…` → service behind the ALB. The exact commands and
approval gates are docs/aws-staging.md Phase 5; the RDS bundle's provenance check (Phase 4) comes
first. Runtime secrets are SSM Parameter Store SecureString values injected by ECS at task start,
never baked into the image. No push or deployment has been performed, and this repository contains
no deployment pipeline and no AWS credentials.
