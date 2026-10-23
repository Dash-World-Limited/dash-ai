# DASH AI staging infrastructure (AWS CloudFormation, eu-west-1)

Staging only. Nothing here has been deployed. Procedure, security model, cost and the Phase 1–11
approval gates: [docs/aws-staging.md](../../docs/aws-staging.md). Decision: ADR 0019.

| Path | What |
|---|---|
| `templates/10-foundation.yaml` | VPC (no NAT), security groups, ECR, log group, ECS cluster, alarm topic, gross-usage budget, cost anomaly alerts |
| `templates/20-data.yaml` | RDS PostgreSQL 16 (empty database, optional daily stop), ElastiCache Redis OSS 7.1 (per session) |
| `templates/30-edge.yaml` | ACM certificate, ALB, target group, listeners |
| `templates/40-service.yaml` | IAM, API task definition, one-off database task definitions, the ECS service only while `ServiceEnabled=true` |
| `parameters/*.example.json` | Parameter files with placeholders (copy outside the repository and fill in) |
| `staging-bringup.sh` | Owner helper for Phases 3–6 (run on the owner's workstation; each AWS step separate) |
| `validate.sh` | Offline validation: cfn-lint, policy tests, `--ops-db` database script tests |
| `tests/` | The tests and a throwaway local TLS PostgreSQL helper |
| `requirements.txt` | cfn-lint and dependencies, pinned with hashes |

Deploy only with reviewed change sets, never `aws cloudformation deploy` straight to execution.
