# ADR 0019 — Staging infrastructure as code: AWS CloudFormation, deployed by reviewed change sets

**Status:** proposed (PR #21, draft; awaiting the owner's approval outside Claude). Nothing has been
provisioned.

## Context

The owner approved an AWS eu-west-1 staging topology (ALB → ECS Fargate → RDS PostgreSQL 16 +
ElastiCache Redis OSS 7.1, no NAT gateway, ~$50–55/month; `reports/staging-provisioning-plan.md`) and
the container image (PR #20). The repository had no infrastructure-as-code tool. Requirements: one
tool, reproducible and reviewable, region and environment locked, validated without AWS credentials,
and no path where one command provisions, migrates and deploys.

## Decision

1. **AWS CloudFormation, plain YAML** (`deploy/aws/templates/`), four stacks split along the approval
   gates: foundation, data, edge, service (docs/aws-staging.md).
2. **Deployed only through change sets** that the owner creates, reviews and executes with a
   short-lived identity on a trusted workstation. No pipeline deploys staging.
3. **Offline validation** in CI: cfn-lint (hash-pinned) and Python policy tests over the decoded
   templates, plus the embedded one-off database scripts run against a local TLS PostgreSQL 16.
4. **Guards in every template:** `Rules` that fail outside eu-west-1 or outside the named account, and
   `EnvironmentName` that only allows `staging`.
5. **No code runs at deploy time** (no Lambda or custom resources), so provisioning can never migrate.
   Migrations stay a separate, manually started task after a separate approval.

## Alternatives considered

- **AWS CDK (TypeScript):** typed and testable, but `cdk deploy` needs a bootstrap stack whose default
  deployment role has administrator rights, and it adds `aws-cdk-lib` to a pnpm workspace whose
  lockfile the Dockerfile installs from. Rejected for this size of environment.
- **Terraform/OpenTofu:** a mature option, but it needs a remote state backend (S3 + locking) that
  would itself be provisioned and secured first, and its plan needs AWS credentials. Not justified for
  four small stacks.

## Consequences

- Each template stays under the 51,200-byte `--template-body` limit, so no S3 artifact bucket is
  needed (a test enforces it).
- CloudFormation drift is possible if someone changes resources by hand; the runbook makes every change a
  change set, including desired-count changes.
- Production would get its own templates or parameters through a separate decision; these templates
  refuse anything but staging.
