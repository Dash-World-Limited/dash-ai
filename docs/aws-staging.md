# AWS staging environment (eu-west-1): infrastructure code and controlled bring-up

**Status: prepared, not executed.** This file and `deploy/aws/` describe the DASH AI **staging**
environment as code. As of 2026-10-22 **no AWS resource exists**: nothing has been provisioned, no
image has been pushed, no migration has run and no AWS API has been called from this repository's
work. Every phase below that changes AWS needs the owner's explicit approval, given outside Claude.

This is staging, not production. A passing staging session says nothing about production or launch
readiness (see `docs/staging-runbook.md` and `docs/release-readiness.md` for what stays open).

- Infrastructure code: `deploy/aws/templates/*.yaml` (AWS CloudFormation, ADR 0019)
- Parameter examples: `deploy/aws/parameters/*.example.json` (placeholders only)
- Offline validation: `deploy/aws/validate.sh` (cfn-lint, policy tests, one-off database scripts)
- Image: the existing `Dockerfile` (docs/container.md); no second Dockerfile
- Application configuration model: `deploy/staging/staging.env.example` +
  `deploy/staging/first-bringup.env.example` (docs/staging-runbook.md)

## 1. Resource layout

```
Internet (IPv4)
  │  tcp/443 (HTTPS, TLS 1.3/1.2) and tcp/80 (301 to HTTPS only)
  ▼
Application Load Balancer  dash-ai-staging        [public subnets a/b]   sg: alb
  │  X-Forwarded-For: append · invalid headers dropped · idle 180 s · HSTS · /metrics → 404
  │  tcp/8787 only
  ▼
ECS Fargate service  dash-ai-staging-api           [public subnets a/b, public IPv4 for EGRESS only]
  task: Linux X86_64, 0.5 vCPU / 2 GB, image <ECR repo>@sha256:…, desired 1 (0 / 2 when told)
  sg: api — inbound ONLY tcp/8787 from sg alb; egress 443 (AWS endpoints), 5432 → db, 6379 → redis
  │                                   │
  ▼ tcp/5432 (TLS verified)            ▼ tcp/6379 (TLS + AUTH)
RDS PostgreSQL 16                     ElastiCache Redis OSS 7.1
dash-ai-staging-postgres              dash-ai-staging-redis
db.t4g.micro, single-AZ, gp3 20→50 GiB  cache.t4g.micro, 1 node, cluster mode off
[private subnets a/b, no internet route]  [private subnets a/b]   sg: redis (from api only)
sg: db (from api and ops only)
```

Four stacks, each deployed only through a reviewed change set:

| Stack | Template | Creates | Phase |
|---|---|---|---|
| `dash-ai-staging-foundation` | `10-foundation.yaml` | VPC 10.40.0.0/16 (2 public + 2 private /24, no NAT), internet gateway, route tables, 5 security groups, ECR repository `dash-ai-staging/api`, log group `/dash-ai/staging/api` (14 days), error-log metric + alarm, ECS cluster `dash-ai-staging`, SNS alarm topic + email subscription, AWS Budgets monthly budget | 3 |
| `dash-ai-staging-data` | `20-data.yaml` | RDS PostgreSQL 16 `dash_staging` (empty), parameter group (`rds.force_ssl=1`), ElastiCache Redis OSS 7.1 (`noeviction`), 3 alarms | 3 |
| `dash-ai-staging-edge` | `30-edge.yaml` | ACM certificate for the staging hostname, ALB, target group (`/ready`), HTTP→HTTPS redirect, HTTPS listener, `/metrics` 404 rule, 4 alarms | 3 |
| `dash-ai-staging-service` | `40-service.yaml` | IAM roles, API task definition, ECS service, two one-off database task definitions (classification, app role) | 5 (desired 0), 9–11 |

Every template refuses to deploy outside **eu-west-1**, into any account other than the
`ExpectedAccountId` the owner passes, or for any environment name other than `staging`
(CloudFormation `Rules`). The edge stack only accepts a hostname containing the word `staging`. There
is no Lambda, custom resource, scheduler or pipeline: CloudFormation creates resources and runs no code
(a test forbids any other resource type).

## 2. Security model

| Boundary | How it is enforced | Test |
|---|---|---|
| Internet → ALB | `sg alb`: tcp/443 and tcp/80 from 0.0.0.0/0, the only CIDR ingress anywhere. 80 only redirects. TLS policy `ELBSecurityPolicy-TLS13-1-2-2021-06`. HSTS added by the listener (the API does not send it). `Server` header off. Invalid header fields dropped. | `test_internet_ingress_only_reaches_the_alb_on_80_and_443`, `test_https_entry_point_and_single_trusted_proxy` |
| ALB → API | `sg api` has exactly one inbound rule: tcp/8787 from `sg alb`. `sg alb` egress is only tcp/8787 to `sg api`. | `test_api_accepts_only_the_alb_on_8787` |
| Internet → API task directly | No path: the task's public IPv4 address exists for egress (ECR, CloudWatch Logs, SSM) and its security group admits nothing but the ALB. Proven on staging by TRUST_PROXY step 6 (direct connection to the task IP must time out). | same |
| API → PostgreSQL | `sg db` inbound tcp/5432 from `sg api` and `sg ops` only. `PubliclyAccessible: false`, private subnets with no internet route. `rds.force_ssl=1`, TLS ≥ 1.2; the API verifies the server certificate (`DATABASE_SSL=require` + RDS CA bundle in the image). Server CA pinned to `rds-ca-rsa2048-g1`, which is in that bundle. | `test_rds_is_private_encrypted_and_tls_only`, `test_database_and_redis_accept_only_ecs_tasks` |
| API → Redis | `sg redis` inbound tcp/6379 from `sg api` only; private subnets; in-transit encryption **required**, AUTH token, encryption at rest. | `test_redis_is_private_single_node_tls_and_auth` |
| Data stores egress | `sg db`, `sg redis` (and `sg alb` apart from 8787) have a placeholder egress rule that matches nothing, instead of the default allow-all. | same |
| Client IP (`TRUST_PROXY=1`) | Correct only while the ALB is the sole proxy and appends to `X-Forwarded-For` (`routing.http.xff_header_processing.mode=append`). The API then believes exactly the rightmost entry. Adding CloudFront/WAF/CDN later changes it to 2 and needs its own reviewed change. The application's own refusal of `true` and `/0` in production is unchanged. | `test_https_entry_point_and_single_trusted_proxy` |
| IAM: execution roles | `api-execution`: pull from the staging repository only, write to the staging log group only, read exactly the 5 API parameters. `ops-execution`: the same pull/log rights, the RDS-managed master secret, and `DATABASE_URL`. No managed policies; trust limited to `ecs-tasks` in this account (`aws:SourceAccount`, `aws:SourceArn`). `Resource: "*"` appears only for `ecr:GetAuthorizationToken` (account-wide by design) and the ECS Exec session channel. | `test_iam_is_least_privilege` |
| IAM: application | **The API task has no task role** in normal operation, so no AWS credential exists inside the container: nothing can be read through the task metadata endpoint, and there is no Bedrock, S3, Secrets Manager or other AWS permission. A role with only the SSM session channel exists only while `EnableExecuteCommand=true`. The one-off database tasks never have a task role. | `test_no_bedrock_or_ai_service_permission_and_no_default_task_role` |
| Container | Image by digest from the private, tag-immutable, scan-on-push repository. User `1000:1000`, read-only root filesystem, all Linux capabilities dropped, no privileged mode (Fargate does not allow it), no volumes, no Docker socket, no SSH, no bastion. Node stays PID 1 (`initProcessEnabled: false`) and drains on SIGTERM (stopTimeout 30 s > drain 20 s). | `test_container_hardening` |
| Secrets | SSM Parameter Store SecureString (AWS-managed key) under `/dash-ai/staging/`; injected by ECS at task start; never in the task definition, the image, the repository or logs. The RDS master password is generated and held by RDS (Secrets Manager), and no person types it. The Redis AUTH token is resolved by CloudFormation from SSM at deploy time. | `test_only_the_five_runtime_secrets_…`, `test_no_literal_secret_…` |
| Providers / Firebase | Fake (demonstration) providers only; paid, free-pool and Bedrock off; no compatible provider; `PUSH_TRANSPORT=none`. No provider key, AWS key or Firebase credential is referenced anywhere. | `test_fake_providers_only_bedrock_and_push_off`, `test_environment_is_the_repository_staging_model` |
| Logs | The API logs pino JSON that by contract contains no prompts, answers, emails, tokens or client IPs. ECS writes stdout/stderr to `/dash-ai/staging/api` (14-day retention). The one-off database scripts print one JSON line and never print credentials (`test_ops_scripts.py` checks the app password never reaches the database server log). | — |
| Backups / deletion | RDS: 7-day automated backups (point-in-time recovery), encrypted storage, **deletion protection on**, and a final snapshot if the stack ever deletes it (`DeletionPolicy: Snapshot`). ECR images are retained even if the stack is deleted. Redis holds nothing durable and is deleted with its stack. The ALB has no deletion protection, so staging can be removed in one step. | `test_rds_is_private_…` |

Known residual risks (accepted for staging, revisit for production):

- The VPC's default security group keeps AWS's default rules; nothing in these stacks uses it.
- No VPC flow logs, no ALB access logs, no WAF (cost; ALB metrics and API logs cover staging).
- API tasks can reach any HTTPS endpoint (tcp/443 to 0.0.0.0/0) because AWS service endpoints are
  public without VPC endpoints. Fake providers make no outbound calls; live providers would need this.
- `ecr:GetAuthorizationToken` cannot be scoped to a repository (AWS design); pulls are scoped.
- ECS Exec mode (`EnableExecuteCommand=true`) turns the read-only root filesystem **off** for that
  revision, because AWS documents that the ECS Exec agent needs to write into the container. Use it
  only for a diagnostic session and switch it back. Whether the agent works with all capabilities
  dropped is **STAGING-EXECUTION REQUIRED**; if it does not, record that and decide with the owner.
- ElastiCache TLS trust (Amazon Trust Services roots) is still unverified against a real endpoint
  (docs/container.md "Redis TLS"); it is checked in Phase 9, never by disabling verification.

## 3. Network choice: public tasks without NAT (approved) vs. private tasks with VPC endpoints

The approved plan places API tasks in the public subnets with a public IPv4 address used for egress
only. This was re-checked against what the tasks need at start-up: pull from ECR (ECR API + ECR
Docker endpoints + S3 for layers), write CloudWatch Logs, read SSM parameters (and Secrets Manager for
the one-off tasks), and the SSM session channel when ECS Exec is on.

| Option | Recurring cost (eu-west-1 list prices, not fetched live) | Security |
|---|---|---|
| **A. Public subnets, public IPv4 per task, SG admits only the ALB (approved, implemented)** | $0.005/h per running task IPv4 (≈ $3.65/month per task if 24/7; ≈ $0.30 for 60 session hours) | No inbound path; depends on the security group (tested offline, and on staging by the direct-connection test). Egress to the internet on 443. |
| B. Private subnets + NAT gateway | ≈ $35/month per NAT gateway + $0.048/GB processed | No public address on the task. |
| C. Private subnets + interface VPC endpoints (ecr.api, ecr.dkr, logs, ssm, secretsmanager, ssmmessages) + S3 gateway endpoint (free) | 6 endpoints × $0.011/h × 2 AZs ≈ $96/month (≈ $48 with one AZ) + $0.01/GB | No public address; egress can be limited to AWS services. Live providers later would still need a NAT. |

Options B and C would each roughly double the approved ~$50–55/month budget, and C would not support
live providers later without adding B. **The approved architecture (A) is kept unchanged.** Moving to
B or C is a cost and architecture decision for the owner, not something this PR changes.

## 4. Configuration: non-secret vs secret

**Non-secret** (plain task-definition environment, reviewed in git): every non-empty value of
`deploy/staging/staging.env.example` with `deploy/staging/first-bringup.env.example` applied on top.
A test keeps the task definition identical to those two files. The important ones for the first
bring-up: `PROVIDER_MODE=fake`, `PAID_PROVIDERS_ENABLED=false`, `FREE_POOL_ENABLED=false`,
`BEDROCK_ENABLED=false`, no `COMPATIBLE_PROVIDERS`, `PUSH_TRANSPORT=none`, `PROVIDER_DETAILS=hidden`,
`TRUST_PROXY=1`, `DATABASE_SSL=require`, `DATABASE_AUTO_MIGRATE=false`, `RATE_LIMIT_BACKEND=redis`,
`SHUTDOWN_DRAIN_MS=20000`, `PORT=8787`.

**Secret** (SSM Parameter Store SecureString, created by the owner on a trusted workstation, never
pasted into a chat, ticket or commit):

| Parameter | When | Value | Read by |
|---|---|---|---|
| `/dash-ai/staging/REDIS_AUTH_TOKEN` | Phase 3, before the data stack | `openssl rand -hex 32` | CloudFormation (data stack) |
| `/dash-ai/staging/DATA_ENCRYPTION_KEY` | Phase 3 | `openssl rand -base64 32`; **escrow an offline copy** (losing it makes stored data unreadable); staging-only | API |
| `/dash-ai/staging/METRICS_TOKEN` | Phase 3 | `openssl rand -hex 24` | API |
| `/dash-ai/staging/OPERATOR_TOKEN` | Phase 3 | `openssl rand -hex 32`, different from `METRICS_TOKEN` | API |
| `/dash-ai/staging/REDIS_URL` | Phase 3, after the data stack | `rediss://:<REDIS_AUTH_TOKEN>@<RedisAddress>:6379` | API |
| `/dash-ai/staging/DATABASE_URL` | **Phase 8 only** | `postgres://dash_app:<openssl rand -hex 32>@<DatabaseAddress>:5432/dash_staging` (no `sslmode`) | API, app-role task |
| RDS master password | automatic | generated and held by RDS in Secrets Manager | one-off database tasks only (break-glass) |

No provider key, no `FCM_SERVICE_ACCOUNT`, no AWS access key. Nothing else is needed.

To write a parameter without the value appearing in shell history or the process list:

```sh
umask 077; f="$(mktemp)"
openssl rand -hex 32 | tr -d '\n' >"$f"          # or the value for that row
aws ssm put-parameter --region eu-west-1 --name /dash-ai/staging/<NAME> --type SecureString --value "file://$f"
shred -u "$f" 2>/dev/null || rm -f "$f"
```

## 5. Controlled sequence (Phases 1–11)

There is no command that does everything. Each phase is separate, ends with a recorded result, and the
phases marked **STOP** end until the owner approves the next one outside Claude. Record every result
with the exact commit SHA and image digest.

Common change-set pattern (used for every stack; `<n>` is a short label such as `phase3-foundation`):

```sh
R=eu-west-1
# TYPE=CREATE for a new stack, UPDATE for an existing one. Add --capabilities CAPABILITY_NAMED_IAM
# for the service stack only (it creates named IAM roles).
aws cloudformation create-change-set --region $R --stack-name <stack> --change-set-name <n> \
  --change-set-type $TYPE \
  --template-body file://deploy/aws/templates/<template>.yaml \
  --parameters file://<your filled copy of deploy/aws/parameters/<stack>.example.json> \
  --tags Key=Project,Value=dash-ai Key=Environment,Value=staging
aws cloudformation wait change-set-create-complete --region $R --stack-name <stack> --change-set-name <n>
# REVIEW the full list of changes before anything is executed:
aws cloudformation describe-change-set --region $R --stack-name <stack> --change-set-name <n>
# Only after the review:
aws cloudformation execute-change-set --region $R --stack-name <stack> --change-set-name <n>
aws cloudformation wait stack-create-complete --region $R --stack-name <stack>   # or stack-update-complete
```

A change set that shows `Replacement: True` or `Remove` for the database is a stop sign: do not
execute it; review with the owner.

### PHASE 1 — Infrastructure code review (no AWS mutation)

- Review this PR: templates, tests, this document. CI runs `deploy/aws/validate.sh --ops-db` with no
  AWS credentials.
- Re-check the cost table (§7) in the AWS Pricing Calculator for eu-west-1.
- Choose: the staging AWS account, the staging hostname (must contain `staging`), the alert email.

### PHASE 2 — Owner approval to provision (still no migration)

The owner approves, outside Claude: provisioning of the four stacks as reviewed, the spend
intervention threshold (§7), and who runs the commands with which credentials. Use a short-lived,
MFA-backed identity (IAM Identity Center / SSO) on the owner's trusted workstation. No static access
keys, and never credentials injected into an AI session's environment.

### PHASE 3 — Provision network, ALB, ECS cluster, ECR, RDS, Redis, configuration

In order:

1. `dash-ai-staging-foundation` (change set; needs `ExpectedAccountId`, `AlertEmail`). Confirm the
   SNS subscription email. The budget starts notifying at $40 actual / $50 forecast / $60 actual.
2. Create `/dash-ai/staging/REDIS_AUTH_TOKEN`, `DATA_ENCRYPTION_KEY` (+ offline escrow),
   `METRICS_TOKEN`, `OPERATOR_TOKEN` (§4).
3. `dash-ai-staging-data` (change set). Takes ~10–20 minutes. Then enable termination protection:
   `aws cloudformation update-termination-protection --region eu-west-1 --stack-name dash-ai-staging-data --enable-termination-protection`.
4. Create `/dash-ai/staging/REDIS_URL` from the data stack output `RedisAddress`.
5. `dash-ai-staging-edge` (change set; `StagingApiHostname`). **DNS gate:** the stack waits on the
   ACM certificate until the validation CNAME exists. The owner publishes it at the DNS provider
   (shown in the ACM console or `aws acm describe-certificate`). This changes only the staging
   name's validation record, never another Dash World domain. Only if the zone is in Route 53 in this
   account and the owner approves may `CertificateValidationHostedZoneId` let ACM write it instead.
6. The owner points the staging hostname at the stack output `LoadBalancerDnsName` (CNAME). Until a
   task is running, `https://<staging host>/ready` answers 503 from the ALB, which is expected.

Result to record: stack outputs (no secret values), the database CA (`rds-ca-rsa2048-g1`), and
`aws rds describe-db-instances … --query 'DBInstances[0].PubliclyAccessible'` = `false`.

### PHASE 4 — RDS CA provenance (DEPLOYMENT BLOCKER)

On an approved, trusted workstation **outside** the session or proxy that built the commit, follow
docs/container.md "Before the first staging deployment: verify the bundle's provenance": download
`https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem` and compare it with
`deploy/container/certs/rds-eu-west-1-bundle.pem`:

- SHA-256 must be exactly `a11cf9a1d0aadd7db86f92cbaa496466daeb501bf1c5e429d8ce8914a01c15d6`;
- the three SHA-256 certificate fingerprints must be exactly:
  - RSA2048 G1 `6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86`
  - RSA4096 G1 `62:E2:9E:F9:03:10:94:7E:ED:5D:55:46:02:1D:63:60:08:FA:D3:29:FA:B9:EA:31:BA:1A:E7:68:B7:34:F2:9A`
  - ECC384 G1 `88:EC:F0:27:44:8F:71:98:F3:C1:A6:76:24:74:C4:65:8D:AB:35:A1:86:86:AF:6B:65:DE:3C:40:23:C6:D0:B2`

**If anything differs: STOP. Do not build, push or deploy.** Replace the bundle only through a
separately reviewed change. Record who checked, when and from which machine. Passing the IaC tests or
cfn-lint says nothing about provenance; only this check does.

### PHASE 5 — Build, verify, push the exact reviewed image; deploy the service at desired 0

```sh
git fetch origin && git checkout --detach <approved SHA>   # CI green on this exact SHA
git status --porcelain                                      # must be empty
docker build --platform=linux/amd64 --provenance=false --sbom=false -t dash-ai-api:<SHA> .
test "$(docker image inspect dash-ai-api:<SHA> --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
deploy/container/smoke.sh dash-ai-api:<SHA>                 # local container smoke, fake providers only
REPO=<ApiRepositoryUri output>
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin "${REPO%%/*}"
docker tag dash-ai-api:<SHA> "$REPO:<SHA>"                  # tag = full commit SHA (immutable)
docker push "$REPO:<SHA>"
aws ecr describe-images --region eu-west-1 --repository-name dash-ai-staging/api \
  --image-ids imageTag=<SHA> --query 'imageDetails[0].imageDigest' --output text   # → sha256:…
docker buildx imagetools inspect "$REPO@<digest>"           # one manifest, linux/amd64
```

(`--provenance=false --sbom=false` keeps a single linux/amd64 manifest, so the digest names exactly
the image that was smoke-tested. **STAGING-EXECUTION REQUIRED:** confirm with the `imagetools`
output.) Check the ECR scan result (`aws ecr describe-image-scan-findings`) and record it.

Then create `dash-ai-staging-service` with `ImageDigest=<digest>` and **`DesiredCount=0`**
(`CAPABILITY_NAMED_IAM`). This registers the task definitions and the service without starting a
task: the API refuses to start on an unmigrated database (`DATABASE_AUTO_MIGRATE=false`), and
`DATABASE_URL` does not exist until Phase 8. Deployment identity = commit SHA + image digest; the tag
is a label only and `latest` is never used.

### PHASE 6 — Read-only migration-history classification

```sh
SUBNETS=<PublicSubnetIds output>; OPS_SG=<OpsSecurityGroupId output>
aws ecs run-task --region eu-west-1 --cluster dash-ai-staging --launch-type FARGATE --count 1 \
  --task-definition dash-ai-staging-db-classify \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${OPS_SG}],assignPublicIp=ENABLED}"
aws ecs wait tasks-stopped --region eu-west-1 --cluster dash-ai-staging --tasks <task arn>
aws logs tail /dash-ai/staging/api --region eu-west-1 --log-stream-name-prefix ops/db-classify --since 30m
```

The task connects as the RDS master user over verified TLS and runs, inside `BEGIN TRANSACTION READ
ONLY … ROLLBACK`, exactly:

```sql
SELECT id, name
FROM schema_migrations
WHERE id >= 10
ORDER BY id;
```

It prints one JSON line: `transactionReadOnly` (must be `"on"`), and either `rows` or the SQL error
(`sqlstate`). A brand-new database prints `"sqlstate":"42P01"` (relation does not exist).

### PHASE 7 — Classify, report to the owner, STOP

Classify by hand against `apps/api/src/store/migrations.ts` (10 `inference_ledger`,
11 `inference_ledger_integrity`, 12 `spend_reservations`, 13 `spend_reservation_attempts`):

- **A** compatible adopted prefix, no gaps · **B** fresh database / no 10+ history (expected here) ·
  **C** collision, wrong adopted name or unknown newer migration · **D** partial sequence, gap or a
  schema-query error other than "relation does not exist".
- **C or D: STOP.** No migration, no deployment, no repair; write a recovery plan for the owner.
- **A or B: report the exact output and classification to the owner and STOP.** A or B does not
  authorize a migration.

### PHASE 8 — Separate owner approval: snapshot, application role, migrations

Only after the owner approves this phase outside Claude:

1. Manual snapshot:
   `aws rds create-db-snapshot --region eu-west-1 --db-instance-identifier dash-ai-staging-postgres --db-snapshot-identifier dash-ai-staging-pre-migration-<yyyymmdd>`,
   then `aws rds wait db-snapshot-available …`.
2. Create `/dash-ai/staging/DATABASE_URL` (§4) with a new `openssl rand -hex 32` password.
3. Run the `dash-ai-staging-db-app-role` task (same `run-task` form as Phase 6). It checks that the
   URL names exactly this database and user `dash_app` with no query parameters, refuses if `dash_app`
   exists, creates it with a SCRAM verifier (the password never reaches the server in clear), grants
   it to the master user and makes it owner of `dash_staging`.
4. Migrate with the API task definition and a command override (the API's own environment and
   secrets; `sg api` reaches the database):
   ```sh
   API_SG=<ApiSecurityGroupId output>
   aws ecs run-task --region eu-west-1 --cluster dash-ai-staging --launch-type FARGATE --count 1 \
     --task-definition dash-ai-staging-api \
     --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/migrate-cli.js"]}]}' \
     --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${API_SG}],assignPublicIp=ENABLED}"
   ```
   Then run it again: it must print "Database is up to date". On failure follow
   docs/staging-runbook.md §4 step 6 (do not edit the migration or mark it applied).
5. Run the Phase 6 classification again: it must show 10–13 with the names above.

### PHASE 9 — Fake-provider staging smoke

Update the service stack to `DesiredCount=1` (change set). Then:

- Start-up log: `"backend":"redis"`, exactly two `PROVIDER_MODE=fake` warnings, nothing else at warn
  or above; `https://<staging host>/ready` → `{"status":"ready",…}`; `/health` 200; `/metrics` → 404.
- TLS: HTTP redirects to HTTPS; HSTS present; certificate valid; database TLS verified (no
  `no-verify` warning); Redis over `rediss://` connects with verification on.
- The smoke list in docs/staging-runbook.md §6 and the TRUST_PROXY test in §3 (steps 1–6, including
  a direct connection to the task's public IP on 8787 that must fail).
- Logs: CloudWatch Logs Insights searches for the test emails, message text, the database URL and
  token values find nothing.

### PHASE 10 — Multi-instance test (1 → 2 tasks)

Update the service stack to `DesiredCount=2` (change set; record the time). Run the multi-instance
blocks: shared rate limits, stream slots across tasks, cross-instance Stop, account deletion across
instances, Automates with no duplicate run, graceful drain during a rolling replacement. Targeting a
specific task needs ECS Exec: a separate change set with `EnableExecuteCommand=true`, then
`aws ecs execute-command --region eu-west-1 --cluster dash-ai-staging --task <id> --container api --interactive --command "/bin/sh"`
(needs the Session Manager plugin on the workstation). The image has no `curl`; inside the task use
`node -e 'fetch("http://127.0.0.1:8787/…").then(…)'`.

### PHASE 11 — Return to 1 task

Update the service stack to `DesiredCount=1` and `EnableExecuteCommand=false` (change set), or
`DesiredCount=0` to end the session. The alarm `dash-ai-staging-second-task-left-running` emails if
two healthy tasks run for 3 hours.

## 6. Diagnostics (cheap, AWS-native)

- **Application logs:** `/dash-ai/staging/api`, streams `api/…` (API) and `ops/…` (one-off tasks),
  14 days. `aws logs tail /dash-ai/staging/api --follow --region eu-west-1`.
- **Start-up failure:** `aws ecs describe-tasks … --query 'tasks[].{stop:stoppedReason,containers:containers[].reason}'`
  shows image pull, secret-injection and exit-code failures before any log line exists; the API's
  own start-up refusal (missing migration, configuration) is the last log line before exit.
- **ALB health:** `aws elbv2 describe-target-health --target-group-arn <ApiTargetGroupArn>` (reason
  codes for unhealthy targets); alarms for unhealthy targets, API 5xx and ALB 5xx.
- **Metrics:** `/metrics` is blocked at the ALB; read it inside a task with ECS Exec and
  `METRICS_TOKEN`. No metrics platform is paid for.
- **Alarms (8, ≈ $0.80/month):** error-level API log lines; unhealthy targets ≥ 1 for 2 min; > 5 API 5xx in
  5 min; any ALB 5xx; second task left running 3 h; RDS free storage < 4 GiB; RDS connections > 80;
  Redis memory > 80 %. All go to the SNS email topic.

## 7. Cost

**AWS Budgets only sends notifications; it is not a spending cap.** The budget is account-wide (it also
sees resources created outside these stacks), with notifications at **$40 actual**, **$50 forecast**
and **$60 actual**. $60/month is an intervention threshold: at that point sessions stop until the
owner reviews. List prices for eu-west-1 as known at planning time, **not fetched live**; re-check in
the AWS Pricing Calculator (±15 %), excluding tax and credits.

| Cost driver | Basis | $/month |
|---|---|---|
| ALB hours | $0.0252/h, always on while it exists | 18.40 |
| ALB LCUs | low staging traffic | 1–6 |
| Public IPv4, ALB (2 AZs) | 2 × $0.005/h, while the ALB exists | 7.30 |
| Public IPv4, API tasks | $0.005/h per **running** task | 0.30 per 60 task-hours |
| Fargate 0.5 vCPU / 2 GB x86 | ≈ $0.029/h per running task | 1.75 per 60 task-hours (≈ 21 if 24/7) |
| RDS db.t4g.micro single-AZ | ≈ $0.018/h | 13.15 |
| RDS gp3 20 GiB (autoscaling cap 50) | ≈ $0.127/GiB-month | 2.55 (up to 6.35) |
| RDS backups (7 days) + manual snapshots | within the free allowance up to the DB size; snapshots beyond it are billed | 0–1 |
| ElastiCache cache.t4g.micro | ≈ $0.018/h while it exists (cannot be stopped) | 13.15 if kept; ≈ 1.10 per 60 h if recreated per session |
| Secrets Manager | 1 RDS-managed master secret | 0.40 |
| SSM Parameter Store (standard) | 6 SecureString parameters | 0 |
| CloudWatch Logs | < 1 GB ingested at $0.57/GB, 14-day retention | ≈ 0.50 |
| CloudWatch alarms | 8 × $0.10 | 0.80 |
| ECR storage | ≈ 0.3 GB per image, lifecycle keeps 15 | ≈ 0.50 |
| ACM, VPC, subnets, SGs, SNS email, Budgets (first 2) | no charge | 0 |

Patterns: ALB + RDS always on, API and Redis only during sessions (~60 h): **≈ $50–55/month**.
Redis kept 24/7 with API only in sessions: ≈ $60–65. One API task and Redis 24/7: ≈ $85. Two tasks
24/7: ≈ $110.

## 8. Shutting staging down, and what it costs afterwards

Nothing is automated: no scheduled shutdown or deletion exists (deliberately).

- **API (cheap, instant):** service stack `DesiredCount=0`. Stops Fargate and task-IPv4 charges.
  Stateless; nothing is lost.
- **Redis:** ElastiCache cannot be stopped. To stop its charge between sessions, set the API to
  `DesiredCount=0` first, then update the data stack with `RedisEnabled=false` (change set: it must
  show only the Redis replication group, its alarm and outputs being removed, never the database).
  Its contents are disposable by design. `RedisEnabled=true` recreates it with the same id, so the
  endpoint name should stay the same (confirm on the first recreate; otherwise update `REDIS_URL`).
- **RDS:** `aws rds stop-db-instance` stops instance charges for at most **7 days**; AWS then starts it
  again automatically. Storage and backups are still billed while stopped.
- **ALB and its public IPv4:** cannot be paused; they cost ≈ $26/month while they exist. Deleting the
  edge stack removes them; recreating gives a new ALB DNS name (the staging CNAME must be updated) and
  needs the certificate again.
- **Everything (destroy):** delete in reverse order: service → edge → data → foundation. The data
  stack needs termination protection off and the instance's deletion protection off (a deliberate,
  reviewed `DeletionProtection: false` change set) and leaves a **final snapshot**, which keeps
  costing storage until deleted by hand. The ECR repository and its images are retained (delete
  manually if wanted). SSM parameters are free but should be deleted with the environment. Deleting
  the database is irreversible apart from that snapshot.

## 9. Validation (offline, no AWS)

`deploy/aws/validate.sh [--ops-db]`, also run by the CI job `infrastructure` (no AWS credentials):

1. **cfn-lint** (pinned with hashes in `deploy/aws/requirements.txt`) on all four templates.
2. **Policy tests** (`deploy/aws/tests/test_templates.py`): staging-only guards; eu-west-1 only;
   X86_64/LINUX/Fargate; `linux/amd64` image build; image only by digest from the private immutable
   repository; port 8787; task size 0.5 vCPU / 2 GB, default 1 task, 0–2 allowed; `/ready` health and
   drain timings consistent with the API code; container hardening; no NAT, no endpoints, private
   subnets without an internet route; internet ingress only to the ALB; API only from the ALB;
   database only from API/ops, Redis only from API; RDS private, encrypted, TLS-forced, 7-day backups,
   PG 16; Redis 7, TLS required, AUTH from SSM, single node, cluster mode off; HTTPS/HSTS/XFF append
   with `TRUST_PROXY=1`; task environment identical to the repository's staging model plus the first
   bring-up overlay; fake providers only, Bedrock and push off; exactly the 5 runtime secrets; no
   provider/AWS/Firebase credential; no Bedrock or other AI-service permission and no default task
   role; least-privilege IAM; no migration CLI or custom resource anywhere; classification script
   sends only the read-only statements; no literal secret; parameter examples match the templates;
   cost shape and budget thresholds.
3. **One-off database scripts** (`deploy/aws/tests/test_ops_scripts.py`, with `--ops-db`): the exact
   scripts from the template, run with Node and the API's `pg` client against a local PostgreSQL 16
   that accepts TLS only: fresh database → `42P01` inside a read-only transaction; refused without the
   CA; every app-role guard; role created with a SCRAM verifier and the password absent from the
   server log; second run refused; the real `migrate-cli` as `dash_app` twice; classification then
   shows 10–13.

Not validated offline (needs AWS, so left for the approved phases): CloudFormation's own
service-side validation, ACM issuance, ALB listener attributes being available in the account, the
ElastiCache TLS chain, ECS Exec with dropped capabilities, and real costs.
