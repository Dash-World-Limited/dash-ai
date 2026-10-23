# ADR 0020: Session-based staging for AWS credit conservation

**Status:** accepted (merged by the owner on 2026-10-23 in PR #22, merge commit `b7471ce`). Nothing has been provisioned.

## Context

Staging (ADR 0019, docs/aws-staging.md) runs on limited AWS promotional credits. The owner requires the
minimum viable topology that still proves DASH AI correctly: real PostgreSQL, real Redis, the real API,
secure networking, migration safety, fake providers only, Web/Android testing against staging, and
multi-instance testing when needed. No trade-off of security, data integrity, migration safety or
distributed correctness is allowed.

Live eu-west-1 prices (AWS Price List API, 2026-10-23) put the reviewed always-on shape at about
$56/month **with the API switched off**. The ALB with its two public IPv4 addresses (~$26), Redis
(~$12) and RDS (~$15) are all charged hourly whether or not anyone is testing.

Two defects against the credit requirement:

1. The budget did not set `CostTypes`. AWS Budgets includes credits by default, so while credits pay
   for usage the budget sees roughly $0 and never notifies.
2. The service stack hard-imported the ALB target group. The ALB could therefore never be removed
   while the service stack existed, even though the one-off database tasks (classification,
   migration) do not use the ALB.

## Decision

Staging becomes **session-based**: only the network, image registry, database storage and secrets
persist. Hourly resources exist during test sessions only.

1. **Budget measures gross usage**: `IncludeCredit: false` and `IncludeRefund: false`. The thresholds
   are parameters, defaulting to $10 actual, $15 forecast and $25 actual, with a $60 maximum.
2. **Cost Anomaly Detection** (no charge): an AWS-services monitor plus a daily email. It is
   switchable because an account can hold only one such monitor.
3. **`ServiceEnabled` on the service stack** (default `false`). With `false`, the stack keeps the IAM
   roles and the three task definitions but creates no ECS service, so no API task can start and the
   stack does not need the edge stack. The edge stack (ALB, certificate, listeners, alarms) is created
   for a session and deleted afterwards. Phases 5–7 run with no ALB.
4. **Daily database stop** (`DatabaseAutoStop`, default `true`): an EventBridge Scheduler schedule
   calls `rds:StopDBInstance` on this one instance at 01:00 UTC. This counters AWS's automatic restart
   of a stopped instance after 7 days. No Lambda is involved, and the role can only stop this instance.
   A stop never deletes data. Deletion protection and the snapshot-on-delete policy are unchanged.
5. Redis already had `RedisEnabled`; it is now off between sessions.
6. **Session-left-running alarm**: it fires when an API task has been healthy behind the ALB for 8 hours.
7. The ECR lifecycle keeps the 5 most recent images instead of 15.

Unchanged: VPC/SG design, TLS everywhere, private RDS/Redis, IAM for the API and ops tasks, the
digest-pinned hardened image, the environment (fake providers, Bedrock/paid/free-pool off, push none),
`DATABASE_AUTO_MIGRATE=false`, the migration gates (Phases 6–8), the 0/1/2 task counts and the
multi-instance test.

## Consequences

- Idle burn is about $3.40/month (database storage, master secret, a few alarms). A session costs
  about $0.111/hour with 1 task and $0.145/hour with 2.
- Starting a session takes about 15–25 minutes (start RDS, create Redis, create the edge stack, owner
  CNAME update). The ACM validation record stays valid in DNS, so the certificate is reissued without
  owner action. The ALB DNS name changes per session.
- A session still running at 01:00 UTC loses its database until it is started again.
- Alternatives rejected (API Gateway, CloudFront, an EC2 proxy, App Runner, Lightsail, Aurora
  Serverless v2, self-hosted data stores, ElastiCache Serverless, Valkey, Spot/ARM64, IPv6-only ALB):
  `reports/aws-staging-bringup/credit-conservation-review.md` in the project files, summarised in
  docs/aws-staging.md §7.
