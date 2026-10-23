#!/usr/bin/env bash
# DASH AI staging bring-up helper (Phases 3-6 of docs/aws-staging.md), session-based layout (ADR 0020).
# Requires the merged credit-conservation PR: set EXPECTED_SHA to the commit DAVID merged.
#
# RUN ONLY ON THE OWNER'S TRUSTED WORKSTATION, with a short-lived MFA/SSO session
# (aws sso login --profile <profile>). Never with static access keys. Never in an AI session's env.
#
# Every AWS mutation is a separate, explicitly named step. Change sets are CREATED and REVIEWED first;
# EXECUTION asks you to type a confirmation. Nothing here runs a migration, creates DATABASE_URL,
# creates dash_app, starts the API (DesiredCount stays 0), touches DNS, providers or Firebase.
#
# Usage:   ./staging-bringup.sh <step>
# Steps, in order (each stops when it is done):
#   preflight                       read-only: identity, account, region, repo SHA, existing state
#   params                          writes filled parameter files outside the repository (no AWS call)
#   cs-create foundation|data|edge|service   creates a change set (no resource is created yet)
#   cs-review foundation|data|edge|service   read-only: prints and checks the change set
#   cs-execute foundation|data|edge|service  EXECUTES the reviewed change set (asks to confirm)
#   secrets                         creates the 4 initial SecureString parameters (never overwrites)
#   data-protect                    enables termination protection on the data stack
#   data-verify                     read-only: RDS/Redis privacy, TLS, encryption, backups
#   redis-url                       creates /dash-ai/staging/REDIS_URL (rediss://), value never printed
#   edge-dns                        read-only: ACM status + the validation CNAME the owner must publish
#   edge-wait                       waits for the edge stack after the CNAME is published
#   edge-verify                     read-only: listeners, TLS policy, HSTS, security-group ingress
#   redis on|off                    rewrites the data parameters (RedisEnabled) for the next cs-create data
#   edge-delete                     deletes the edge stack (ALB, cert, edge alarms; no data; asks to confirm)
#   db-start | db-stop              starts / stops the RDS instance (data is kept)
#   rds-ca                          PHASE 4 gate: independent RDS CA bundle provenance check
#   image                           PHASE 5: build, smoke, push by SHA tag, digest, ECR scan
#   service-verify                  read-only: service desired/running = 0, task definition checks
#   classify                        PHASE 6: the read-only migration-history task, then prints the log
#
# Required environment (non-secret):
#   DASH_REPO            path to a clean checkout of Dash-World-Limited/dash-ai at the SHA below
#   EXPECTED_ACCOUNT_ID  the 12-digit staging account id
#   AWS_PROFILE          the SSO profile to use
#   ALERT_EMAIL          (params) the alert email
#   STAGING_HOSTNAME     (params) the staging API hostname, must contain "staging"
#   HOSTED_ZONE_ID       (params, optional) only if the owner approves ACM writing the record in Route 53
#   DASH_STAGING_DIR     (optional) working directory outside the repo, default ~/dash-ai-staging
set -euo pipefail

R=eu-west-1
SHA="${EXPECTED_SHA:?set EXPECTED_SHA to the merged commit of the credit-conservation PR}"
ENV_NAME=staging
WORK_DIR="${DASH_STAGING_DIR:-$HOME/dash-ai-staging}"
PARAMS="$WORK_DIR/params"
REVIEW="$WORK_DIR/review"
export AWS_REGION=$R AWS_DEFAULT_REGION=$R AWS_PAGER=""

die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
ok() { printf 'OK    %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }
need() { [ -n "${!1:-}" ] || die "set $1 first"; }
awsr() { aws --region "$R" "$@"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
secure_rm() { shred -u "$1" 2>/dev/null || rm -P "$1" 2>/dev/null || rm -f "$1"; }
confirm() { # confirm "<exact phrase>"
  printf '\nType exactly:  %s\n> ' "$1"; read -r answer
  [ "$answer" = "$1" ] || die "confirmation did not match; nothing was executed"
}

stack_name() { echo "dash-ai-$ENV_NAME-$1"; }
template_for() {
  case "$1" in
    foundation) echo 10-foundation.yaml ;; data) echo 20-data.yaml ;;
    edge) echo 30-edge.yaml ;; service) echo 40-service.yaml ;;
    *) die "unknown stack '$1' (foundation|data|edge|service)" ;;
  esac
}
# Resource counts of the reviewed templates for this configuration
# (RedisEnabled=true, no Route 53 validation, EnableExecuteCommand=false).
# foundation incl. the anomaly monitor; data incl. Redis and the daily DB stop; service with ServiceEnabled=false.
expected_adds() { case "$1" in foundation) echo 37 ;; data) echo 11 ;; edge) echo 11 ;; service) echo 5 ;; esac; }
# Removals a reviewed UPDATE may contain (parking Redis, ending a session). Never the database.
allowed_removals() { case "$1" in data) echo "Redis RedisMemoryAlarm" ;; service) echo "ApiService" ;; esac; }
allowed_types() {
  case "$1" in
    foundation) echo "AWS::EC2::VPC AWS::EC2::InternetGateway AWS::EC2::VPCGatewayAttachment AWS::EC2::Subnet AWS::EC2::RouteTable AWS::EC2::Route AWS::EC2::SubnetRouteTableAssociation AWS::EC2::SecurityGroup AWS::EC2::SecurityGroupIngress AWS::EC2::SecurityGroupEgress AWS::ECR::Repository AWS::Logs::LogGroup AWS::Logs::MetricFilter AWS::CloudWatch::Alarm AWS::ECS::Cluster AWS::SNS::Topic AWS::SNS::Subscription AWS::Budgets::Budget AWS::CE::AnomalyMonitor AWS::CE::AnomalySubscription" ;;
    data) echo "AWS::RDS::DBSubnetGroup AWS::RDS::DBParameterGroup AWS::RDS::DBInstance AWS::CloudWatch::Alarm AWS::ElastiCache::SubnetGroup AWS::ElastiCache::ParameterGroup AWS::ElastiCache::ReplicationGroup AWS::IAM::Role AWS::Scheduler::Schedule" ;;
    edge) echo "AWS::CertificateManager::Certificate AWS::ElasticLoadBalancingV2::LoadBalancer AWS::ElasticLoadBalancingV2::TargetGroup AWS::ElasticLoadBalancingV2::Listener AWS::ElasticLoadBalancingV2::ListenerRule AWS::CloudWatch::Alarm" ;;
    service) echo "AWS::IAM::Role AWS::ECS::TaskDefinition AWS::ECS::Service" ;;
  esac
}
stack_status() { awsr cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ABSENT; }
output_of() { awsr cloudformation describe-stacks --stack-name "$(stack_name "$1")" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
param_exists() { [ "$(awsr ssm describe-parameters --parameter-filters "Key=Name,Values=$1" --query 'length(Parameters)' --output text)" != "0" ]; }

check_identity() {
  need EXPECTED_ACCOUNT_ID; need AWS_PROFILE
  local acct arn
  acct="$(awsr sts get-caller-identity --query Account --output text)" || die "no valid AWS session (aws sso login --profile $AWS_PROFILE)"
  arn="$(awsr sts get-caller-identity --query Arn --output text)"
  [ "$acct" = "$EXPECTED_ACCOUNT_ID" ] || die "session account $acct is not EXPECTED_ACCOUNT_ID"
  case "$arn" in *:assumed-role/*) ;; *) die "identity $arn is not a short-lived assumed role (SSO). Static IAM user keys are not allowed." ;; esac
  ok "account ${acct:0:4}****${acct:8:4}, short-lived role session, region $R"
}
check_repo() {
  need DASH_REPO
  [ "$(git -C "$DASH_REPO" rev-parse HEAD)" = "$SHA" ] || die "DASH_REPO is not at $SHA (git -C \$DASH_REPO checkout --detach $SHA)"
  [ -z "$(git -C "$DASH_REPO" status --porcelain)" ] || die "DASH_REPO working tree is not clean"
  ok "repository at $SHA, clean"
}
check_no_database_url() {
  if param_exists "/dash-ai/$ENV_NAME/DATABASE_URL"; then die "/dash-ai/$ENV_NAME/DATABASE_URL exists; it must not exist before Phase 8"; fi
  ok "DATABASE_URL does not exist (required before Phase 8)"
}

step_preflight() {
  command -v aws >/dev/null || die "AWS CLI v2 not installed"
  aws --version 2>&1 | grep -q 'aws-cli/2' || die "AWS CLI v2 required"
  command -v git >/dev/null && command -v openssl >/dev/null || die "git and openssl are required"
  check_identity; check_repo
  for s in foundation data edge service; do info "$(stack_name $s): $(stack_status "$(stack_name $s)")"; done
  info "existing parameters under /dash-ai/$ENV_NAME/ (names only):"
  awsr ssm describe-parameters --parameter-filters "Key=Path,Option=Recursive,Values=/dash-ai/$ENV_NAME" --query 'Parameters[].[Name,Type]' --output text | sed 's/^/        /'
  check_no_database_url
  info "existing budgets in the account (the staging budget is account-wide):"
  awsr budgets describe-budgets --account-id "$EXPECTED_ACCOUNT_ID" --query 'Budgets[].BudgetName' --output text 2>/dev/null | sed 's/^/        /' || true
  ok "preflight finished; nothing was changed"
}

step_params() {
  need EXPECTED_ACCOUNT_ID; need ALERT_EMAIL; need STAGING_HOSTNAME
  echo "$STAGING_HOSTNAME" | grep -Eq '^([a-z0-9-]+\.)*[a-z0-9-]*staging[a-z0-9-]*(\.[a-z0-9-]+)+$' || die "STAGING_HOSTNAME must be lower-case and contain 'staging'"
  echo "$ALERT_EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || die "ALERT_EMAIL is not an email address"
  local zone="${HOSTED_ZONE_ID:-}"
  mkdir -p "$PARAMS" "$REVIEW"; chmod 700 "$WORK_DIR" "$PARAMS" "$REVIEW"
  cat >"$PARAMS/foundation.json" <<EOF
[
  { "ParameterKey": "EnvironmentName", "ParameterValue": "staging" },
  { "ParameterKey": "ExpectedAccountId", "ParameterValue": "$EXPECTED_ACCOUNT_ID" },
  { "ParameterKey": "AlertEmail", "ParameterValue": "$ALERT_EMAIL" },
  { "ParameterKey": "VpcCidr", "ParameterValue": "10.40.0.0/16" },
  { "ParameterKey": "BudgetLimitUsd", "ParameterValue": "${BUDGET_LIMIT_USD:-25}" },
  { "ParameterKey": "BudgetActualWarningUsd", "ParameterValue": "${BUDGET_ACTUAL_WARNING_USD:-10}" },
  { "ParameterKey": "BudgetForecastWarningUsd", "ParameterValue": "${BUDGET_FORECAST_WARNING_USD:-15}" },
  { "ParameterKey": "CostAnomalyMonitorEnabled", "ParameterValue": "${COST_ANOMALY_MONITOR:-true}" },
  { "ParameterKey": "CostAnomalyThresholdUsd", "ParameterValue": "3" }
]
EOF
  cat >"$PARAMS/data.json" <<EOF
[
  { "ParameterKey": "EnvironmentName", "ParameterValue": "staging" },
  { "ParameterKey": "ExpectedAccountId", "ParameterValue": "$EXPECTED_ACCOUNT_ID" },
  { "ParameterKey": "PostgresEngineVersion", "ParameterValue": "16" },
  { "ParameterKey": "RedisEnabled", "ParameterValue": "true" },
  { "ParameterKey": "RedisAuthTokenParameterName", "ParameterValue": "/dash-ai/staging/REDIS_AUTH_TOKEN" },
  { "ParameterKey": "DatabaseAutoStop", "ParameterValue": "${DATABASE_AUTO_STOP:-true}" }
]
EOF
  cat >"$PARAMS/edge.json" <<EOF
[
  { "ParameterKey": "EnvironmentName", "ParameterValue": "staging" },
  { "ParameterKey": "ExpectedAccountId", "ParameterValue": "$EXPECTED_ACCOUNT_ID" },
  { "ParameterKey": "StagingApiHostname", "ParameterValue": "$STAGING_HOSTNAME" },
  { "ParameterKey": "CertificateValidationHostedZoneId", "ParameterValue": "$zone" }
]
EOF
  ok "parameter files written to $PARAMS (service.json is written by the 'image' step, with the digest)"
}

step_cs_create() {
  local s="$1" st tpl type name caps=()
  check_identity; check_repo
  st="$(stack_name "$s")"; tpl="$DASH_REPO/deploy/aws/templates/$(template_for "$s")"
  [ -f "$PARAMS/$s.json" ] || die "missing $PARAMS/$s.json (run params / image first)"
  case "$s" in
    data) for p in REDIS_AUTH_TOKEN DATA_ENCRYPTION_KEY METRICS_TOKEN OPERATOR_TOKEN; do param_exists "/dash-ai/$ENV_NAME/$p" || die "create the initial secrets first (step: secrets)"; done ;;
    edge) case "$(stack_status "$(stack_name data)")" in CREATE_COMPLETE|UPDATE_COMPLETE) ;; *) die "data stack is not complete" ;; esac
          param_exists "/dash-ai/$ENV_NAME/REDIS_URL" || die "create REDIS_URL first (step: redis-url)" ;;
    service) caps=(--capabilities CAPABILITY_NAMED_IAM); check_no_database_url
             grep -q '"ServiceEnabled", "ParameterValue": "false"' "$PARAMS/service.json" \
               || case "$(stack_status "$(stack_name edge)")" in CREATE_COMPLETE|UPDATE_COMPLETE) ;; *) die "ServiceEnabled=true needs the edge stack" ;; esac ;;
  esac
  case "$(stack_status "$st")" in ABSENT|REVIEW_IN_PROGRESS) type=CREATE ;; *) type=UPDATE ;; esac
  name="$s-$(date -u +%Y%m%dT%H%M%SZ)"
  awsr cloudformation create-change-set --stack-name "$st" --change-set-name "$name" --change-set-type "$type" \
    --template-body "file://$tpl" --parameters "file://$PARAMS/$s.json" ${caps[@]+"${caps[@]}"} \
    --tags Key=Project,Value=dash-ai Key=Environment,Value=staging >/dev/null
  echo "$name" >"$REVIEW/$s.changeset"; echo "$type" >"$REVIEW/$s.type"
  awsr cloudformation wait change-set-create-complete --stack-name "$st" --change-set-name "$name" || {
    awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query '[Status,StatusReason]' --output text
    die "change set creation failed (see the reason above); nothing was created"; }
  ok "change set $name ($type) created for $st; NOTHING executed. Next: cs-review $s"
}

step_cs_review() {
  local s="$1" st name f bad adds types t
  check_identity
  st="$(stack_name "$s")"; name="$(cat "$REVIEW/$s.changeset")"; f="$REVIEW/$s-$name.json"
  awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --include-property-values >"$f" 2>/dev/null \
    || awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" >"$f"
  awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" \
    --query 'Changes[].ResourceChange.[Action,ResourceType,LogicalResourceId,Replacement]' --output table
  [ "$(awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query 'ExecutionStatus' --output text)" = AVAILABLE ] || die "change set is not AVAILABLE"
  awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query 'Parameters[].[ParameterKey,ParameterValue]' --output text | sed 's/^/      param  /'
  [ "$(awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query "length(Changes[?ResourceChange.Replacement=='True' || ResourceChange.Replacement=='Conditional'])" --output text)" = 0 ] \
    || die "change set REPLACES resources: do not execute; report to the owner"
  for bad in $(awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query "Changes[?ResourceChange.Action=='Remove'].ResourceChange.LogicalResourceId" --output text); do
    case " $(allowed_removals "$s") " in *" $bad "*) info "reviewed removal: $bad" ;; *) die "change set REMOVES $bad: do not execute; report to the owner" ;; esac
  done
  if [ "$(awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query 'length(Changes[?ResourceChange.Action!=`Add`])' --output text)" = 0 ]; then
    adds="$(awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query 'length(Changes)' --output text)"
    [ "$adds" = "$(expected_adds "$s")" ] || die "$adds resources to add, the reviewed template has $(expected_adds "$s"): report to the owner"
    ok "$adds additions, matching the reviewed template"
  else
    info "UPDATE change set: review every Modify line above by hand"
  fi
  types="$(awsr cloudformation describe-change-set --stack-name "$st" --change-set-name "$name" --query 'Changes[].ResourceChange.ResourceType' --output text | tr '\t' '\n' | sort -u)"
  for t in $types; do case " $(allowed_types "$s") " in *" $t "*) ;; *) die "unexpected resource type $t: report to the owner" ;; esac; done
  ok "only the reviewed resource types"
  if grep -Eiq '(^|[^a-z])prod([^a-z]|uction\.)' "$f"; then
    info "lines mentioning prod (NODE_ENV=production is expected; anything else is a STOP):"
    grep -Eio '.{0,60}prod.{0,60}' "$f" | grep -v '"production"' | sed 's/^/        /' || true
  fi
  ok "full change set saved to $f (contains no secret values). Execute only after reading it: cs-execute $s"
}

step_cs_execute() {
  local s="$1" st name
  check_identity
  st="$(stack_name "$s")"; name="$(cat "$REVIEW/$s.changeset")"
  [ -f "$REVIEW/$s-$name.json" ] || die "review the change set first (cs-review $s)"
  confirm "EXECUTE $st $name"
  awsr cloudformation execute-change-set --stack-name "$st" --change-set-name "$name"
  if [ "$s" = edge ]; then
    ok "edge change set executing. The stack waits for the ACM certificate: run edge-dns now, publish the record, then edge-wait"
    return
  fi
  info "waiting for $st (data takes ~10-20 minutes)..."
  if [ "$(cat "$REVIEW/$s.type")" = CREATE ]; then awsr cloudformation wait stack-create-complete --stack-name "$st"
  else awsr cloudformation wait stack-update-complete --stack-name "$st"; fi
  info "status: $(stack_status "$st")"
  awsr cloudformation describe-stacks --stack-name "$st" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text | sed 's/^/      out  /'
  if [ "$s" = foundation ]; then info "CONFIRM the SNS subscription email sent to the alert address."; fi
}

put_secret() { # put_secret NAME GENERATOR...
  local name="/dash-ai/$ENV_NAME/$1" f; shift
  if param_exists "$name"; then info "$name already exists: left unchanged (never overwritten)"; return; fi
  umask 077; f="$(mktemp)"
  "$@" | tr -d '\n' >"$f"
  if [ "$name" = "/dash-ai/$ENV_NAME/DATA_ENCRYPTION_KEY" ]; then
    printf '\nESCROW NOW: open %s locally and copy the key into your offline escrow\n(password manager vault / sealed offline copy). Never paste it into a chat, ticket or repository.\nPress Enter when the escrow copy is saved... ' "$f"; read -r _
  fi
  awsr ssm put-parameter --name "$name" --type SecureString --value "file://$f" >/dev/null
  secure_rm "$f"
  ok "$name created (SecureString, value not shown)"
}
step_secrets() {
  check_identity
  [ "$(stack_status "$(stack_name foundation)")" = CREATE_COMPLETE ] || die "foundation stack first"
  put_secret REDIS_AUTH_TOKEN openssl rand -hex 32
  put_secret DATA_ENCRYPTION_KEY openssl rand -base64 32
  put_secret METRICS_TOKEN openssl rand -hex 24
  put_secret OPERATOR_TOKEN openssl rand -hex 32
  check_no_database_url
}

step_data_protect() {
  check_identity
  awsr cloudformation update-termination-protection --stack-name "$(stack_name data)" --enable-termination-protection >/dev/null
  [ "$(awsr cloudformation describe-stacks --stack-name "$(stack_name data)" --query 'Stacks[0].EnableTerminationProtection' --output text)" = True ] || die "termination protection not enabled"
  ok "termination protection enabled on $(stack_name data)"
}

step_data_verify() {
  check_identity
  local db=dash-ai-$ENV_NAME-postgres q pg
  q='DBInstances[0].[PubliclyAccessible,StorageEncrypted,MultiAZ,DeletionProtection,BackupRetentionPeriod,Engine,EngineVersion,DBInstanceClass,CACertificateIdentifier,DBName]'
  awsr rds describe-db-instances --db-instance-identifier "$db" --query "$q" --output text | sed 's/^/      rds  /'
  [ "$(awsr rds describe-db-instances --db-instance-identifier "$db" --query 'DBInstances[0].PubliclyAccessible' --output text)" = False ] || die "RDS is publicly accessible"
  [ "$(awsr rds describe-db-instances --db-instance-identifier "$db" --query 'DBInstances[0].StorageEncrypted' --output text)" = True ] || die "RDS storage not encrypted"
  pg="$(awsr rds describe-db-instances --db-instance-identifier "$db" --query 'DBInstances[0].DBParameterGroups[0].DBParameterGroupName' --output text)"
  [ "$(awsr rds describe-db-parameters --db-parameter-group-name "$pg" --query "Parameters[?ParameterName=='rds.force_ssl'].ParameterValue" --output text)" = 1 ] || die "rds.force_ssl is not 1"
  ok "RDS private, encrypted, force_ssl=1"
  q='ReplicationGroups[0].[Status,ClusterEnabled,TransitEncryptionEnabled,TransitEncryptionMode,AuthTokenEnabled,AtRestEncryptionEnabled,AutomaticFailover,MultiAZ,length(MemberClusters)]'
  awsr elasticache describe-replication-groups --replication-group-id "dash-ai-$ENV_NAME-redis" --query "$q" --output text | sed 's/^/      redis  /'
  [ "$(awsr elasticache describe-replication-groups --replication-group-id "dash-ai-$ENV_NAME-redis" --query 'ReplicationGroups[0].TransitEncryptionMode' --output text)" = required ] || die "Redis TLS is not required"
  [ "$(awsr elasticache describe-replication-groups --replication-group-id "dash-ai-$ENV_NAME-redis" --query 'ReplicationGroups[0].AuthTokenEnabled' --output text)" = True ] || die "Redis AUTH is not enabled"
  ok "Redis private subnets, TLS required, AUTH on (single node expected above: 1)"
  info "termination protection: $(awsr cloudformation describe-stacks --stack-name "$(stack_name data)" --query 'Stacks[0].EnableTerminationProtection' --output text)"
}

step_redis_url() {
  check_identity
  local name="/dash-ai/$ENV_NAME/REDIS_URL" addr tf uf token
  if param_exists "$name"; then info "$name already exists: left unchanged"; return; fi
  addr="$(output_of data RedisAddress)"; [ -n "$addr" ] || die "no RedisAddress output"
  umask 077; tf="$(mktemp)"; uf="$(mktemp)"
  awsr ssm get-parameter --name "/dash-ai/$ENV_NAME/REDIS_AUTH_TOKEN" --with-decryption --query Parameter.Value --output text >"$tf"
  token="$(tr -d '\n' <"$tf")"
  printf 'rediss://:%s@%s:6379' "$token" "$addr" >"$uf"   # printf is a shell builtin: not in the process list
  unset token
  awsr ssm put-parameter --name "$name" --type SecureString --value "file://$uf" >/dev/null
  secure_rm "$tf"; secure_rm "$uf"
  ok "$name created (rediss://, value not shown)"
}

step_edge_dns() {
  check_identity
  local arn
  arn="$(awsr cloudformation describe-stack-resource --stack-name "$(stack_name edge)" --logical-resource-id Certificate --query 'StackResourceDetail.PhysicalResourceId' --output text)"
  info "certificate status: $(awsr acm describe-certificate --certificate-arn "$arn" --query 'Certificate.Status' --output text)"
  info "validation record the OWNER publishes at the DNS provider (staging validation name only):"
  awsr acm describe-certificate --certificate-arn "$arn" --query 'Certificate.DomainValidationOptions[].ResourceRecord.[Type,Name,Value]' --output text | sed 's/^/        /'
}
step_edge_wait() {
  check_identity
  awsr cloudformation wait stack-create-complete --stack-name "$(stack_name edge)"
  ok "$(stack_name edge): $(stack_status "$(stack_name edge)")"
  info "LoadBalancerDnsName (owner points $(output_of edge StagingApiHostname) here by CNAME): $(output_of edge LoadBalancerDnsName)"
}
step_edge_verify() {
  check_identity
  local lb ids
  lb="$(awsr cloudformation describe-stack-resource --stack-name "$(stack_name edge)" --logical-resource-id LoadBalancer --query 'StackResourceDetail.PhysicalResourceId' --output text)"
  awsr elbv2 describe-listeners --load-balancer-arn "$lb" --query 'Listeners[].[Protocol,Port,SslPolicy,DefaultActions[0].Type]' --output text | sed 's/^/      listener  /'
  for l in $(awsr elbv2 describe-listeners --load-balancer-arn "$lb" --query "Listeners[?Protocol=='HTTPS'].ListenerArn" --output text); do
    awsr elbv2 describe-listener-attributes --listener-arn "$l" --query 'Attributes[].[Key,Value]' --output text | sed 's/^/      https-attr  /'
  done
  awsr elbv2 describe-load-balancer-attributes --load-balancer-arn "$lb" --query "Attributes[?starts_with(Key,'routing.http')].[Key,Value]" --output text | sed 's/^/      alb-attr  /'
  ids="$(output_of foundation AlbSecurityGroupId),$(output_of foundation ApiSecurityGroupId),$(output_of foundation OpsSecurityGroupId),$(output_of foundation DatabaseSecurityGroupId),$(output_of foundation RedisSecurityGroupId)"
  info "every INBOUND rule of the five staging security groups:"
  awsr ec2 describe-security-group-rules --filters "Name=group-id,Values=$ids" \
    --query 'SecurityGroupRules[?IsEgress==`false`].[GroupId,IpProtocol,FromPort,ToPort,CidrIpv4,ReferencedGroupInfo.GroupId]' --output text | sed 's/^/        /'
  [ "$(awsr ec2 describe-security-group-rules --filters "Name=group-id,Values=$ids" --query "length(SecurityGroupRules[?IsEgress==\`false\` && CidrIpv4!=\`null\` && GroupId!='$(output_of foundation AlbSecurityGroupId)'])" --output text)" = 0 ] \
    || die "a non-ALB security group has CIDR ingress"
  ok "only the ALB security group admits CIDR (internet) traffic"
}

step_rds_ca() {
  need DASH_REPO
  local d f want got fp
  d="$(mktemp -d)"; f="$d/eu-west-1-bundle.pem"
  curl -fsS --proto '=https' --tlsv1.2 -o "$f" https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem
  want=a11cf9a1d0aadd7db86f92cbaa496466daeb501bf1c5e429d8ce8914a01c15d6
  got="$(sha256 "$f")"; info "downloaded bundle SHA-256: $got"
  [ "$got" = "$want" ] || die "downloaded bundle SHA-256 differs: DO NOT BUILD, PUSH OR DEPLOY; report to the owner"
  [ "$(sha256 "$DASH_REPO/deploy/container/certs/rds-eu-west-1-bundle.pem")" = "$want" ] || die "committed bundle differs from the expected SHA-256"
  fp="$(openssl crl2pkcs7 -nocrl -certfile "$f" | openssl pkcs7 -print_certs | \
    awk '/BEGIN/{c=""} {c=c $0 "\n"} /END/{printf "%s", c | "openssl x509 -noout -fingerprint -sha256"; close("openssl x509 -noout -fingerprint -sha256")}' | sed 's/.*=//' | sort)"
  printf '%s\n' "$fp" | sed 's/^/      fingerprint  /'
  [ "$fp" = "$(printf '%s\n' \
    62:E2:9E:F9:03:10:94:7E:ED:5D:55:46:02:1D:63:60:08:FA:D3:29:FA:B9:EA:31:BA:1A:E7:68:B7:34:F2:9A \
    6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86 \
    88:EC:F0:27:44:8F:71:98:F3:C1:A6:76:24:74:C4:65:8D:AB:35:A1:86:86:AF:6B:65:DE:3C:40:23:C6:D0:B2 | sort)" ] \
    || die "certificate fingerprints differ: DO NOT BUILD, PUSH OR DEPLOY; report to the owner"
  mkdir -p "$REVIEW"
  printf 'RDS CA provenance check PASSED\nwhen: %s\nwho: %s\nmachine: %s\nsha256: %s\n' "$(date -u +%FT%TZ)" "$(id -un)" "$(hostname)" "$got" | tee "$REVIEW/rds-ca-provenance.txt"
  rm -rf "$d"
}

step_image() {
  check_identity; check_repo; check_no_database_url
  [ -f "$REVIEW/rds-ca-provenance.txt" ] || die "Phase 4 (rds-ca) has not passed on this workstation"
  command -v docker >/dev/null || die "Docker with buildx is required"
  local img="dash-ai-api:$SHA" repo digest
  (cd "$DASH_REPO" && docker build --platform=linux/amd64 --provenance=false --sbom=false -t "$img" .)
  [ "$(docker image inspect "$img" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64 ] || die "image is not linux/amd64"
  ok "image is linux/amd64"
  info "built-in environment (must hold NODE_ENV and NODE_EXTRA_CA_CERTS only, no secret):"
  docker image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed 's/^/        /'
  (cd "$DASH_REPO" && deploy/container/smoke.sh "$img") || die "local container smoke test failed: do not push"
  ok "local container smoke test passed (fake providers only)"
  repo="$(output_of foundation ApiRepositoryUri)"
  awsr ecr get-login-password | docker login --username AWS --password-stdin "${repo%%/*}"
  docker tag "$img" "$repo:$SHA"
  docker push "$repo:$SHA"
  docker logout "${repo%%/*}" >/dev/null || true
  digest="$(awsr ecr describe-images --repository-name "dash-ai-$ENV_NAME/api" --image-ids "imageTag=$SHA" --query 'imageDetails[0].imageDigest' --output text)"
  echo "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || die "could not resolve the image digest"
  echo "$digest" >"$REVIEW/image-digest.txt"
  ok "pushed $repo:$SHA  digest $digest"
  docker buildx imagetools inspect "$repo@$digest" | sed 's/^/        /' || info "imagetools inspect unavailable; check the manifest by hand"
  awsr ecr wait image-scan-complete --repository-name "dash-ai-$ENV_NAME/api" --image-id "imageDigest=$digest" || true
  info "ECR scan (basic) severity counts:"
  awsr ecr describe-image-scan-findings --repository-name "dash-ai-$ENV_NAME/api" --image-id "imageDigest=$digest" \
    --query '[imageScanStatus.status,imageScanFindings.findingSeverityCounts]' --output json | sed 's/^/        /'
  awsr ecr describe-image-scan-findings --repository-name "dash-ai-$ENV_NAME/api" --image-id "imageDigest=$digest" \
    --query 'imageScanFindings.findings[?severity==`CRITICAL`||severity==`HIGH`].[severity,name,attributes[?key==`package_name`].value|[0]]' --output text \
    >"$REVIEW/ecr-scan-high-critical.txt" || true
  info "HIGH/CRITICAL list saved to $REVIEW/ecr-scan-high-critical.txt"
  cat >"$PARAMS/service.json" <<EOF
[
  { "ParameterKey": "EnvironmentName", "ParameterValue": "staging" },
  { "ParameterKey": "ExpectedAccountId", "ParameterValue": "$EXPECTED_ACCOUNT_ID" },
  { "ParameterKey": "ImageDigest", "ParameterValue": "$digest" },
  { "ParameterKey": "DesiredCount", "ParameterValue": "0" },
  { "ParameterKey": "ApiTaskCpu", "ParameterValue": "512" },
  { "ParameterKey": "EnableExecuteCommand", "ParameterValue": "false" },
  { "ParameterKey": "ServiceEnabled", "ParameterValue": "false" }
]
EOF
  ok "service parameters written with ServiceEnabled=false and DesiredCount=0 (no ECS service). Next: cs-create service, cs-review service, cs-execute service"
}

step_service_verify() {
  check_identity; check_no_database_url
  local c=dash-ai-$ENV_NAME td
  [ "$(awsr ecs describe-services --cluster "$c" --services "dash-ai-$ENV_NAME-api" --query "length(services[?status=='ACTIVE'])" --output text)" = 0 ] \
    || die "an ACTIVE ECS service exists; before Phase 9 there must be none (ServiceEnabled=false)"
  ok "no ECS service exists: no API task can start (desired count is 0 by construction)"
  td="dash-ai-$ENV_NAME-api"
  awsr ecs describe-task-definition --task-definition "$td" --query 'taskDefinition.[revision,cpu,memory,runtimePlatform.cpuArchitecture,runtimePlatform.operatingSystemFamily,taskRoleArn,containerDefinitions[0].image,containerDefinitions[0].user,containerDefinitions[0].readonlyRootFilesystem,containerDefinitions[0].privileged,containerDefinitions[0].linuxParameters.capabilities.drop]' --output text | sed 's/^/      task  /'
  awsr ecs describe-task-definition --task-definition "$td" --query "taskDefinition.containerDefinitions[0].environment[?contains(['PROVIDER_MODE','PAID_PROVIDERS_ENABLED','FREE_POOL_ENABLED','BEDROCK_ENABLED','PUSH_TRANSPORT','DATABASE_AUTO_MIGRATE','TRUST_PROXY'],name)].[name,value]" --output text | sed 's/^/      env  /'
  awsr ecs describe-task-definition --task-definition "$td" --query 'taskDefinition.containerDefinitions[0].secrets[].name' --output text | sed 's/^/      secret-names  /'
  for f in "$td" "dash-ai-$ENV_NAME-db-classify" "dash-ai-$ENV_NAME-db-app-role"; do
    case "$(awsr ecs describe-task-definition --task-definition "$f" --query 'taskDefinition.containerDefinitions[0].image' --output text)" in
      *@sha256:*) ok "$f image referenced by digest" ;; *) die "$f image is not referenced by digest" ;; esac
  done
}

step_redis() {
  local v
  case "${1:-}" in on) v=true ;; off) v=false ;; *) die "redis on|off" ;; esac
  [ -f "$PARAMS/data.json" ] || die "run params first"
  python3 - "$PARAMS/data.json" "$v" <<'PY'
import json, sys
p, v = sys.argv[1], sys.argv[2]
d = json.load(open(p))
for e in d:
    if e["ParameterKey"] == "RedisEnabled": e["ParameterValue"] = v
json.dump(d, open(p, "w"), indent=2)
PY
  ok "data parameters: RedisEnabled=$v. Next: cs-create data, cs-review data (only Redis + its alarm may change), cs-execute data"
}

step_edge_delete() {
  check_identity
  [ "$(awsr ecs describe-services --cluster "dash-ai-$ENV_NAME" --services "dash-ai-$ENV_NAME-api" --query "length(services[?status=='ACTIVE'])" --output text)" = 0 ] \
    || die "the ECS service still exists: update the service stack with ServiceEnabled=false first"
  confirm "DELETE $(stack_name edge)"
  awsr cloudformation delete-stack --stack-name "$(stack_name edge)"
  awsr cloudformation wait stack-delete-complete --stack-name "$(stack_name edge)"
  ok "edge stack deleted (ALB, listeners, certificate, edge alarms). Leave the ACM validation CNAME in DNS."
}

step_db() {
  check_identity
  local db=dash-ai-$ENV_NAME-postgres
  case "$1" in
    start) awsr rds start-db-instance --db-instance-identifier "$db" >/dev/null; awsr rds wait db-instance-available --db-instance-identifier "$db" ;;
    stop) awsr rds stop-db-instance --db-instance-identifier "$db" >/dev/null ;;
  esac
  info "database status: $(awsr rds describe-db-instances --db-instance-identifier "$db" --query 'DBInstances[0].DBInstanceStatus' --output text)"
}

step_classify() {
  check_identity; check_no_database_url
  local c=dash-ai-$ENV_NAME subnets ops task code
  [ "$(awsr ecs describe-services --cluster "$c" --services "dash-ai-$ENV_NAME-api" --query "length(services[?status=='ACTIVE' && desiredCount!=\`0\`])" --output text)" = 0 ] || die "an API service with desired count above 0 exists"
  [ "$(awsr rds describe-db-instances --db-instance-identifier "dash-ai-$ENV_NAME-postgres" --query 'DBInstances[0].DBInstanceStatus' --output text)" = available ] || die "database is not available (db-start first)"
  subnets="$(output_of foundation PublicSubnetIds)"; ops="$(output_of foundation OpsSecurityGroupId)"
  confirm "RUN READ-ONLY CLASSIFICATION"
  task="$(awsr ecs run-task --cluster "$c" --launch-type FARGATE --count 1 --task-definition "dash-ai-$ENV_NAME-db-classify" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$ops],assignPublicIp=ENABLED}" \
    --query 'tasks[0].taskArn' --output text)"
  info "task $task; waiting for it to stop..."
  awsr ecs wait tasks-stopped --cluster "$c" --tasks "$task"
  code="$(awsr ecs describe-tasks --cluster "$c" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)"
  awsr ecs describe-tasks --cluster "$c" --tasks "$task" --query 'tasks[0].[stoppedReason,containers[0].reason]' --output text | sed 's/^/      stop  /'
  info "exit code: $code; log line (paste this exact JSON into the thread):"
  awsr logs tail "/dash-ai/$ENV_NAME/api" --log-stream-name-prefix "ops/db-classify/${task##*/}" --since 1h --format short | tee "$REVIEW/phase6-classification.txt"
}

step="${1:-}"; shift || true
case "$step" in
  preflight) step_preflight ;;
  params) step_params ;;
  cs-create) step_cs_create "${1:?stack}" ;;
  cs-review) step_cs_review "${1:?stack}" ;;
  cs-execute) step_cs_execute "${1:?stack}" ;;
  secrets) step_secrets ;;
  data-protect) step_data_protect ;;
  data-verify) step_data_verify ;;
  redis-url) step_redis_url ;;
  edge-dns) step_edge_dns ;;
  edge-wait) step_edge_wait ;;
  edge-verify) step_edge_verify ;;
  redis) step_redis "${1:-}" ;;
  edge-delete) step_edge_delete ;;
  db-start) step_db start ;;
  db-stop) step_db stop ;;
  rds-ca) step_rds_ca ;;
  image) step_image ;;
  service-verify) step_service_verify ;;
  classify) step_classify ;;
  *) sed -n '2,40p' "$0"; exit 2 ;;
esac
