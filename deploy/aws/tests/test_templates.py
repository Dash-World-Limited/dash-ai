"""Offline policy tests for the DASH AI staging CloudFormation templates.

They read the templates (and the repository files the templates must agree with) and never call AWS:
no credentials, no network. Run with deploy/aws/validate.sh, which also runs cfn-lint.
"""

import json
import re
import unittest
from pathlib import Path

from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
TEMPLATES = ROOT / "deploy" / "aws" / "templates"
NAMES = ["10-foundation.yaml", "20-data.yaml", "30-edge.yaml", "40-service.yaml"]

# Resource types these four stacks may create. Anything else (NAT gateways, VPC endpoints, EKS,
# EC2 instances, Lambda/custom resources that could run code at deploy time...) fails the test.
ALLOWED_TYPES = {
    "AWS::EC2::VPC", "AWS::EC2::InternetGateway", "AWS::EC2::VPCGatewayAttachment", "AWS::EC2::Subnet",
    "AWS::EC2::RouteTable", "AWS::EC2::Route", "AWS::EC2::SubnetRouteTableAssociation",
    "AWS::EC2::SecurityGroup", "AWS::EC2::SecurityGroupIngress", "AWS::EC2::SecurityGroupEgress",
    "AWS::ECR::Repository", "AWS::Logs::LogGroup", "AWS::Logs::MetricFilter", "AWS::CloudWatch::Alarm",
    "AWS::ECS::Cluster", "AWS::SNS::Topic", "AWS::SNS::Subscription", "AWS::Budgets::Budget",
    "AWS::RDS::DBSubnetGroup", "AWS::RDS::DBParameterGroup", "AWS::RDS::DBInstance",
    "AWS::ElastiCache::SubnetGroup", "AWS::ElastiCache::ParameterGroup", "AWS::ElastiCache::ReplicationGroup",
    "AWS::CertificateManager::Certificate", "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::ElasticLoadBalancingV2::TargetGroup", "AWS::ElasticLoadBalancingV2::Listener",
    "AWS::ElasticLoadBalancingV2::ListenerRule", "AWS::IAM::Role", "AWS::ECS::TaskDefinition", "AWS::ECS::Service",
    # Credit conservation (ADR 0020): free cost-anomaly alerts and the daily database stop.
    "AWS::CE::AnomalyMonitor", "AWS::CE::AnomalySubscription", "AWS::Scheduler::Schedule",
}

API_SECRETS = {"DATABASE_URL", "REDIS_URL", "DATA_ENCRYPTION_KEY", "METRICS_TOKEN", "OPERATOR_TOKEN"}
MANDATED_QUERY = "SELECT id, name FROM schema_migrations WHERE id >= 10 ORDER BY id"


def load(name):
    template, matches = decode(str(TEMPLATES / name))
    if matches:
        raise AssertionError(f"{name} does not parse: {matches}")
    return template


T = {name: load(name) for name in NAMES}
FOUNDATION, DATA, EDGE, SERVICE = (T[n]["Resources"] for n in NAMES)


def resources(of_type):
    return [(n, r) for t in T.values() for n, r in t["Resources"].items() if r["Type"] == of_type]


def walk(value):
    """Every scalar and dict node in a decoded template."""
    yield value
    if isinstance(value, dict):
        for v in value.values():
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)


def env_file(path):
    """Values from an env template, and the keys listed in its SECRETS section."""
    values, secrets, in_secrets = {}, set(), False
    for line in (ROOT / path).read_text().splitlines():
        s = line.strip()
        if s.startswith("# ---"):
            in_secrets = "SECRETS" in s
            continue
        if not s or s.startswith("#"):
            continue
        key, value = s.split("=", 1)
        values[key] = value
        if in_secrets:
            secrets.add(key)
    return values, secrets


def api_container():
    (container,) = SERVICE["ApiTaskDefinition"]["Properties"]["ContainerDefinitions"]
    return container


def api_env():
    return {e["Name"]: e["Value"] for e in api_container()["Environment"]}


def ref(name):
    return {"Ref": name}


def imported(export):
    return {"Fn::ImportValue": {"Fn::Sub": f"dash-ai-${{EnvironmentName}}-{export}"}}


class Guards(unittest.TestCase):
    """1-3: syntax, staging-only, region locked."""

    def test_every_template_parses_and_fits_a_direct_upload(self):
        for name in NAMES:
            self.assertIn("Resources", T[name])
            # --template-body limit, so no S3 bucket or CDK bootstrap stack is needed to deploy.
            self.assertLess((TEMPLATES / name).stat().st_size, 51_200, name)

    def test_region_account_and_environment_are_locked(self):
        for name, t in T.items():
            rules = t["Rules"]
            self.assertEqual(rules["StagingRegionOnly"]["Assertions"][0]["Assert"], {"Fn::Equals": [ref("AWS::Region"), "eu-west-1"]}, name)
            self.assertEqual(rules["ExpectedAccountOnly"]["Assertions"][0]["Assert"], {"Fn::Equals": [ref("AWS::AccountId"), ref("ExpectedAccountId")]}, name)
            self.assertEqual(t["Parameters"]["EnvironmentName"]["AllowedValues"], ["staging"], name)
            self.assertNotIn("Default", t["Parameters"]["ExpectedAccountId"], name)
            self.assertIn("STAGING", t["Description"], name)

    def test_no_other_region_is_named(self):
        for name in NAMES:
            regions = set(re.findall(r"\b(?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d\b", (TEMPLATES / name).read_text()))
            self.assertLessEqual(regions, {"eu-west-1"}, name)

    def test_only_expected_resource_types(self):
        for name, t in T.items():
            for logical, r in t["Resources"].items():
                self.assertIn(r["Type"], ALLOWED_TYPES, f"{name}:{logical}")

    def test_staging_hostname_must_say_staging(self):
        pattern = re.compile(EDGE_PARAMS()["StagingApiHostname"]["AllowedPattern"])
        self.assertTrue(pattern.fullmatch("api.staging.example.com"))
        self.assertTrue(pattern.fullmatch("dash-staging-api.example.com"))
        self.assertFalse(pattern.fullmatch("api.example.com"))
        self.assertFalse(pattern.fullmatch("staging"))


def EDGE_PARAMS():
    return T["30-edge.yaml"]["Parameters"]


class Compute(unittest.TestCase):
    """4-6, 18-20: architecture, image, port, task count, health."""

    def task_definitions(self):
        return resources("AWS::ECS::TaskDefinition")

    def test_every_task_is_linux_x86_64_fargate(self):
        self.assertEqual(len(self.task_definitions()), 3)
        for name, td in self.task_definitions():
            p = td["Properties"]
            self.assertEqual(p["RuntimePlatform"], {"OperatingSystemFamily": "LINUX", "CpuArchitecture": "X86_64"}, name)
            self.assertEqual(p["RequiresCompatibilities"], ["FARGATE"], name)
            self.assertEqual(p["NetworkMode"], "awsvpc", name)

    def test_image_is_the_staging_repository_pinned_by_digest(self):
        params = T["40-service.yaml"]["Parameters"]
        digest = re.compile(params["ImageDigest"]["AllowedPattern"])
        self.assertTrue(digest.fullmatch("sha256:" + "a" * 64))
        self.assertFalse(digest.fullmatch("latest"))
        self.assertFalse(digest.fullmatch("sha256:" + "A" * 64))
        self.assertNotIn("Default", params["ImageDigest"])
        for name, td in self.task_definitions():
            for c in td["Properties"]["ContainerDefinitions"]:
                self.assertEqual(c["Image"], {"Fn::Sub": ["${Repository}@${ImageDigest}", {"Repository": imported("ApiRepositoryUri")}]}, name)
        repo = FOUNDATION["ApiRepository"]["Properties"]
        self.assertEqual(repo["ImageTagMutability"], "IMMUTABLE")
        self.assertTrue(repo["ImageScanningConfiguration"]["ScanOnPush"])
        self.assertNotIn("RepositoryPolicyText", repo)  # private: no cross-account or public pull

    def test_container_image_is_built_for_linux_amd64(self):
        self.assertIn("--platform=linux/amd64", (ROOT / "Dockerfile").read_text())
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        self.assertIn("docker build --platform=linux/amd64", ci)
        self.assertIn("\"linux/amd64\"", ci)

    def test_api_port_is_8787_everywhere(self):
        c = api_container()
        self.assertEqual(c["PortMappings"], [{"ContainerPort": 8787, "Protocol": "tcp"}])
        self.assertEqual(api_env()["PORT"], "8787")
        self.assertEqual(EDGE["ApiTargetGroup"]["Properties"]["Port"], 8787)
        self.assertEqual(SERVICE["ApiService"]["Properties"]["LoadBalancers"][0]["ContainerPort"], 8787)
        self.assertIn("EXPOSE 8787", (ROOT / "Dockerfile").read_text())

    def test_task_size_and_count(self):
        params = T["40-service.yaml"]["Parameters"]
        self.assertEqual(params["ApiTaskCpu"]["Default"], 512)
        self.assertEqual(SERVICE["ApiTaskDefinition"]["Properties"]["Memory"], "2048")
        self.assertEqual(params["DesiredCount"]["Default"], 1)
        self.assertEqual(params["DesiredCount"]["AllowedValues"], [0, 1, 2])
        svc = SERVICE["ApiService"]["Properties"]
        self.assertEqual(svc["DesiredCount"], ref("DesiredCount"))
        self.assertEqual(svc["LaunchType"], "FARGATE")
        self.assertEqual(svc["DeploymentConfiguration"]["MaximumPercent"], 200)
        self.assertEqual(svc["DeploymentConfiguration"]["MinimumHealthyPercent"], 100)
        self.assertEqual(svc["DeploymentConfiguration"]["DeploymentCircuitBreaker"], {"Enable": True, "Rollback": True})

    def test_health_and_drain_match_the_api(self):
        tg = EDGE["ApiTargetGroup"]["Properties"]
        self.assertEqual(tg["HealthCheckPath"], "/ready")
        self.assertEqual(tg["Matcher"], {"HttpCode": "200"})
        system = (ROOT / "apps" / "api" / "src" / "routes" / "system.ts").read_text()
        self.assertIn('app.get("/ready"', system)
        self.assertIn("reply.code(database && !draining ? 200 : 503)", system)
        attrs = {a["Key"]: a["Value"] for a in tg["TargetGroupAttributes"]}
        drain_ms = int(api_env()["SHUTDOWN_DRAIN_MS"])
        deregistration = int(attrs["deregistration_delay.timeout_seconds"])
        stop_timeout = api_container()["StopTimeout"]
        self.assertLess(drain_ms / 1000, deregistration)
        self.assertLess(deregistration, stop_timeout)
        self.assertEqual(attrs["stickiness.enabled"], "false")
        lb = {a["Key"]: a["Value"] for a in EDGE["LoadBalancer"]["Properties"]["LoadBalancerAttributes"]}
        self.assertGreater(int(lb["idle_timeout.timeout_seconds"]) * 1000, int(api_env()["PROVIDER_TIMEOUT_MS"]))

    def test_container_hardening(self):
        for name, td in self.task_definitions():
            p = td["Properties"]
            self.assertNotIn("Volumes", p, name)
            self.assertNotIn("PidMode", p, name)
            for c in p["ContainerDefinitions"]:
                self.assertEqual(c["User"], "1000:1000", name)
                self.assertEqual(c["LinuxParameters"]["Capabilities"], {"Drop": ["ALL"]}, name)
                self.assertNotIn("Add", c["LinuxParameters"]["Capabilities"], name)
                for forbidden in ("Privileged", "MountPoints", "VolumesFrom", "DockerSecurityOptions", "RepositoryCredentials"):
                    self.assertNotIn(forbidden, c, f"{name}: {forbidden}")
                self.assertNotIn("docker.sock", json.dumps(c), name)
        api = api_container()
        # Read-only unless the owner turns ECS Exec on for a diagnostic revision.
        self.assertEqual(api["ReadonlyRootFilesystem"], {"Fn::If": ["ExecEnabled", False, True]})
        self.assertEqual(T["40-service.yaml"]["Parameters"]["EnableExecuteCommand"]["Default"], "false")
        self.assertFalse(api["LinuxParameters"]["InitProcessEnabled"])  # node stays PID 1
        self.assertEqual(api["Command"], ["node", "dist/index.js"])
        for name in ("DbClassifyTaskDefinition", "DbAppRoleTaskDefinition"):
            (c,) = SERVICE[name]["Properties"]["ContainerDefinitions"]
            self.assertIs(c["ReadonlyRootFilesystem"], True, name)


class Network(unittest.TestCase):
    """7-10: private data stores, ALB -> ECS only, data stores reachable from ECS only."""

    def test_no_nat_no_endpoints_and_private_subnets_have_no_internet_route(self):
        routes = resources("AWS::EC2::Route")
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0][1]["Properties"]["RouteTableId"], ref("PublicRouteTable"))
        for name in ("PrivateSubnetARoutes", "PrivateSubnetBRoutes"):
            self.assertEqual(FOUNDATION[name]["Properties"]["RouteTableId"], ref("PrivateRouteTable"))
        for name, subnet in resources("AWS::EC2::Subnet"):
            self.assertIs(subnet["Properties"]["MapPublicIpOnLaunch"], False, name)

    def test_internet_ingress_only_reaches_the_alb_on_80_and_443(self):
        for name, sg in resources("AWS::EC2::SecurityGroup"):
            for rule in sg["Properties"].get("SecurityGroupIngress", []):
                self.assertEqual(name, "AlbSecurityGroup", "only the ALB group has CIDR ingress")
                self.assertEqual(rule["CidrIp"], "0.0.0.0/0")
                self.assertIn(rule["FromPort"], (80, 443))
                self.assertEqual(rule["FromPort"], rule["ToPort"])
        for name, rule in resources("AWS::EC2::SecurityGroupIngress"):
            self.assertNotIn("CidrIp", rule["Properties"], name)
            self.assertNotIn("CidrIpv6", rule["Properties"], name)
            self.assertIn("SourceSecurityGroupId", rule["Properties"], name)

    def ingress_into(self, group):
        return [r["Properties"] for _, r in resources("AWS::EC2::SecurityGroupIngress") if r["Properties"]["GroupId"] == ref(group)]

    def test_api_accepts_only_the_alb_on_8787(self):
        self.assertNotIn("SecurityGroupIngress", FOUNDATION["ApiSecurityGroup"]["Properties"])
        (rule,) = self.ingress_into("ApiSecurityGroup")
        self.assertEqual((rule["IpProtocol"], rule["FromPort"], rule["ToPort"], rule["SourceSecurityGroupId"]), ("tcp", 8787, 8787, ref("AlbSecurityGroup")))
        egress = [r["Properties"] for _, r in resources("AWS::EC2::SecurityGroupEgress") if r["Properties"]["GroupId"] == ref("AlbSecurityGroup")]
        self.assertEqual([(e["FromPort"], e["DestinationSecurityGroupId"]) for e in egress], [(8787, ref("ApiSecurityGroup"))])
        net = SERVICE["ApiService"]["Properties"]["NetworkConfiguration"]["AwsvpcConfiguration"]
        self.assertEqual(net["SecurityGroups"], [imported("ApiSecurityGroupId")])

    def test_database_and_redis_accept_only_ecs_tasks(self):
        db = {(r["FromPort"], json.dumps(r["SourceSecurityGroupId"])) for r in self.ingress_into("DatabaseSecurityGroup")}
        self.assertEqual(db, {(5432, json.dumps(ref("ApiSecurityGroup"))), (5432, json.dumps(ref("OpsSecurityGroup")))})
        redis = [(r["FromPort"], r["SourceSecurityGroupId"]) for r in self.ingress_into("RedisSecurityGroup")]
        self.assertEqual(redis, [(6379, ref("ApiSecurityGroup"))])
        for group in ("DatabaseSecurityGroup", "RedisSecurityGroup", "AlbSecurityGroup"):
            (placeholder,) = FOUNDATION[group]["Properties"]["SecurityGroupEgress"]
            self.assertEqual(placeholder["CidrIp"], "127.0.0.1/32", group)
        self.assertEqual(self.ingress_into("OpsSecurityGroup"), [])

    def test_rds_is_private_encrypted_and_tls_only(self):
        db = DATA["Database"]
        p = db["Properties"]
        self.assertIs(p["PubliclyAccessible"], False)
        self.assertEqual(p["Engine"], "postgres")
        self.assertTrue(re.fullmatch(T["20-data.yaml"]["Parameters"]["PostgresEngineVersion"]["AllowedPattern"], "16"))
        self.assertFalse(re.fullmatch(T["20-data.yaml"]["Parameters"]["PostgresEngineVersion"]["AllowedPattern"], "17"))
        self.assertIs(p["MultiAZ"], False)
        self.assertIs(p["StorageEncrypted"], True)
        self.assertEqual(p["BackupRetentionPeriod"], 7)
        self.assertIs(p["DeletionProtection"], True)
        self.assertIs(p["ManageMasterUserPassword"], True)
        self.assertNotIn("MasterUserPassword", p)
        self.assertEqual(p["CACertificateIdentifier"], "rds-ca-rsa2048-g1")
        self.assertEqual(db["DeletionPolicy"], "Snapshot")
        self.assertEqual(DATA["DatabaseParameterGroup"]["Properties"]["Parameters"]["rds.force_ssl"], "1")
        self.assertEqual(p["VPCSecurityGroups"], [imported("DatabaseSecurityGroupId")])
        self.assertIn("PrivateSubnetIds", json.dumps(DATA["DatabaseSubnetGroup"]["Properties"]["SubnetIds"]))

    def test_redis_is_private_single_node_tls_and_auth(self):
        p = DATA["Redis"]["Properties"]
        self.assertEqual(p["Engine"], "redis")
        self.assertTrue(p["EngineVersion"].startswith("7."))
        self.assertEqual(p["ClusterMode"], "disabled")
        self.assertEqual(p["NumCacheClusters"], 1)
        self.assertIs(p["AutomaticFailoverEnabled"], False)
        self.assertIs(p["TransitEncryptionEnabled"], True)
        self.assertEqual(p["TransitEncryptionMode"], "required")
        self.assertIs(p["AtRestEncryptionEnabled"], True)
        self.assertEqual(p["AuthToken"], {"Fn::Sub": "{{resolve:ssm-secure:${RedisAuthTokenParameterName}}}"})
        self.assertEqual(p["SecurityGroupIds"], [imported("RedisSecurityGroupId")])
        self.assertIn("PrivateSubnetIds", json.dumps(DATA["RedisSubnetGroup"]["Properties"]["SubnetIds"]))
        self.assertEqual(DATA["RedisParameterGroup"]["Properties"]["Properties"], {"maxmemory-policy": "noeviction"})
        # Removable between sessions without touching the database.
        self.assertEqual(T["20-data.yaml"]["Parameters"]["RedisEnabled"]["Default"], "true")
        for name, r in DATA.items():
            self.assertEqual(r.get("Condition") == "WithRedis", name in {"Redis", "RedisMemoryAlarm"}, name)

    def test_https_entry_point_and_single_trusted_proxy(self):
        https = EDGE["HttpsListener"]["Properties"]
        self.assertEqual(https["Protocol"], "HTTPS")
        self.assertTrue(https["SslPolicy"].startswith("ELBSecurityPolicy-TLS13-1-2"))
        attrs = {a["Key"]: a["Value"] for a in https["ListenerAttributes"]}
        self.assertTrue(attrs["routing.http.response.strict_transport_security.header_value"].startswith("max-age="))
        http = EDGE["HttpListener"]["Properties"]
        self.assertEqual([a["Type"] for a in http["DefaultActions"]], ["redirect"])
        self.assertEqual(http["DefaultActions"][0]["RedirectConfig"]["Protocol"], "HTTPS")
        lb = {a["Key"]: a["Value"] for a in EDGE["LoadBalancer"]["Properties"]["LoadBalancerAttributes"]}
        self.assertEqual(lb["routing.http.xff_header_processing.mode"], "append")
        self.assertEqual(lb["routing.http.drop_invalid_header_fields.enabled"], "true")
        self.assertEqual(api_env()["TRUST_PROXY"], "1")
        self.assertEqual(EDGE["LoadBalancer"]["Properties"]["Scheme"], "internet-facing")
        self.assertEqual(EDGE["MetricsNotFoundRule"]["Properties"]["Actions"][0]["FixedResponseConfig"]["StatusCode"], "404")


class Configuration(unittest.TestCase):
    """11-16: first bring-up config, Bedrock off, no provider or Firebase credentials, no migration."""

    def test_environment_is_the_repository_staging_model(self):
        values, secrets = env_file("deploy/staging/staging.env.example")
        overlay, _ = env_file("deploy/staging/first-bringup.env.example")
        values.update(overlay)
        expected = {k: v for k, v in values.items() if v != "" and k not in secrets}
        self.assertEqual(api_env(), expected)
        self.assertLessEqual({s["Name"] for s in api_container()["Secrets"]}, secrets)

    def test_fake_providers_only_bedrock_and_push_off(self):
        env = api_env()
        self.assertEqual(env["PROVIDER_MODE"], "fake")
        self.assertEqual(env["PAID_PROVIDERS_ENABLED"], "false")
        self.assertEqual(env["FREE_POOL_ENABLED"], "false")
        self.assertEqual(env["BEDROCK_ENABLED"], "false")
        self.assertEqual(env["PUSH_TRANSPORT"], "none")
        self.assertEqual(env["PROVIDER_DETAILS"], "hidden")
        self.assertNotIn("COMPATIBLE_PROVIDERS", env)
        self.assertNotIn("MODEL_PRICES", env)

    def test_only_the_five_runtime_secrets_and_no_provider_or_firebase_credential(self):
        secrets = {s["Name"] for s in api_container()["Secrets"]}
        self.assertEqual(secrets, API_SECRETS)
        for s in api_container()["Secrets"]:
            self.assertEqual(s["ValueFrom"], {"Fn::Sub": f"arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:${{AWS::AccountId}}:parameter/dash-ai/${{EnvironmentName}}/{s['Name']}"})
        for name in NAMES:
            text = (TEMPLATES / name).read_text()
            for forbidden in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BEDROCK_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "FCM_SERVICE_ACCOUNT", "firebase", "google-services"):
                self.assertNotIn(forbidden, text, f"{name}: {forbidden}")

    def test_no_bedrock_or_ai_service_permission_and_no_default_task_role(self):
        td = SERVICE["ApiTaskDefinition"]["Properties"]
        self.assertEqual(td["TaskRoleArn"], {"Fn::If": ["ExecEnabled", {"Fn::GetAtt": ["ApiExecSessionTaskRole", "Arn"]}, ref("AWS::NoValue")]})
        self.assertEqual(SERVICE["ApiExecSessionTaskRole"]["Condition"], "ExecEnabled")
        for name in ("DbClassifyTaskDefinition", "DbAppRoleTaskDefinition"):
            self.assertNotIn("TaskRoleArn", SERVICE[name]["Properties"], name)
        for name in NAMES:
            text = (TEMPLATES / name).read_text().lower()
            for service in ("bedrock", "sagemaker", "comprehend", "polly", "transcribe"):
                self.assertNotIn(service + ":", text, f"{name}: {service}")

    def test_iam_is_least_privilege(self):
        roles = resources("AWS::IAM::Role")
        self.assertEqual({n for n, _ in roles}, {"ApiExecutionRole", "ApiExecSessionTaskRole", "OpsExecutionRole", "DatabaseAutoStopRole"})
        wildcard_ok = {"ecr:GetAuthorizationToken", "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"}
        for name, role in roles:
            p = role["Properties"]
            self.assertNotIn("ManagedPolicyArns", p, name)
            (trust,) = p["AssumeRolePolicyDocument"]["Statement"]
            service = "scheduler.amazonaws.com" if name == "DatabaseAutoStopRole" else "ecs-tasks.amazonaws.com"
            self.assertEqual(trust["Principal"], {"Service": service}, name)
            self.assertIn("aws:SourceAccount", trust["Condition"]["StringEquals"], name)
            for policy in p["Policies"]:
                for st in policy["PolicyDocument"]["Statement"]:
                    self.assertEqual(st["Effect"], "Allow", name)
                    actions = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
                    for action in actions:
                        self.assertNotIn("*", action, f"{name}: wildcard action {action}")
                    if st["Resource"] == "*":
                        self.assertLessEqual(set(actions), wildcard_ok, f"{name}: {actions} on *")
        api_reads = SERVICE["ApiExecutionRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"][3]
        self.assertEqual(api_reads["Action"], "ssm:GetParameters")
        self.assertEqual(len(api_reads["Resource"]), len(API_SECRETS))
        api_actions = json.dumps(SERVICE["ApiExecutionRole"])
        self.assertNotIn("secretsmanager", api_actions)  # the API never sees the master password

    def test_database_auto_stop_can_only_stop_this_instance(self):
        role = DATA["DatabaseAutoStopRole"]
        self.assertEqual(role["Condition"], "WithDatabaseAutoStop")
        (policy,) = role["Properties"]["Policies"]
        (st,) = policy["PolicyDocument"]["Statement"]
        self.assertEqual(st["Action"], "rds:StopDBInstance")
        self.assertEqual(st["Resource"], {"Fn::Sub": "arn:${AWS::Partition}:rds:${AWS::Region}:${AWS::AccountId}:db:${Database}"})
        schedule = DATA["DatabaseAutoStopSchedule"]
        self.assertEqual(schedule["Condition"], "WithDatabaseAutoStop")
        target = schedule["Properties"]["Target"]
        self.assertEqual(target["Arn"], {"Fn::Sub": "arn:${AWS::Partition}:scheduler:::aws-sdk:rds:stopDBInstance"})
        self.assertEqual(target["Input"], {"Fn::Sub": '{"DbInstanceIdentifier":"${Database}"}'})
        self.assertEqual(target["RetryPolicy"], {"MaximumRetryAttempts": 0})
        # A stop never deletes: the database keeps deletion protection and a snapshot-on-delete policy.
        self.assertIs(DATA["Database"]["Properties"]["DeletionProtection"], True)
        self.assertEqual(DATA["Database"]["DeletionPolicy"], "Snapshot")

    def test_provisioning_never_migrates(self):
        self.assertEqual(api_env()["DATABASE_AUTO_MIGRATE"], "false")
        everything = json.dumps(T)
        self.assertFalse("migrate-cli" in everything or "data-cli" in everything, "a template references a migration CLI")
        services = resources("AWS::ECS::Service")
        self.assertEqual([n for n, _ in services], ["ApiService"])
        # No ECS service at all unless a session turns it on (and it needs the edge stack then).
        self.assertEqual(services[0][1]["Condition"], "WithService")
        self.assertEqual(T["40-service.yaml"]["Parameters"]["ServiceEnabled"]["Default"], "false")
        unconditional = json.dumps({n: r for n, r in SERVICE.items() if r.get("Condition") != "WithService"})
        self.assertNotIn("ApiTargetGroupArn", unconditional)  # the stack does not need the ALB without the service
        self.assertEqual(services[0][1]["Properties"]["TaskDefinition"], ref("ApiTaskDefinition"))
        for name, t in T.items():
            for logical, r in t["Resources"].items():
                self.assertFalse(r["Type"].startswith("Custom::"), f"{name}:{logical}")
        self.assertIn("Creates an EMPTY database", T["20-data.yaml"]["Description"])

    def test_classification_task_is_read_only_and_runs_the_mandated_query(self):
        (c,) = SERVICE["DbClassifyTaskDefinition"]["Properties"]["ContainerDefinitions"]
        script = c["Command"][2]
        self.assertEqual(c["Command"][:2], ["node", "-e"])
        self.assertIn(f'"{MANDATED_QUERY}"', script)
        begin, rollback = script.index('"BEGIN TRANSACTION READ ONLY"'), script.index('"ROLLBACK"')
        self.assertLess(begin, script.index(MANDATED_QUERY))
        self.assertLess(script.index(MANDATED_QUERY), rollback)
        # Every statement the script sends: nothing that could write.
        statements = re.findall(r'client\.query\("([^"]+)"\)', script)
        self.assertEqual(statements, ["BEGIN TRANSACTION READ ONLY", "SHOW transaction_read_only", MANDATED_QUERY, "ROLLBACK"])
        self.assertNotIn("client.query(`", script)
        self.assertIn("rejectUnauthorized: true", script)

    def test_app_role_task_never_sends_the_password_in_clear(self):
        (c,) = SERVICE["DbAppRoleTaskDefinition"]["Properties"]["ContainerDefinitions"]
        script = c["Command"][2]
        self.assertIn("SCRAM-SHA-256$4096:", script)
        self.assertIn("PASSWORD ${client.escapeLiteral(verifier)}", script)
        self.assertNotIn("escapeLiteral(password)", script)
        self.assertIn("rejectUnauthorized: true", script)
        self.assertIn("already exists", script)

    def test_no_literal_secret_in_templates_or_parameter_examples(self):
        for name, t in T.items():
            for key, p in t.get("Parameters", {}).items():
                if p.get("NoEcho"):
                    self.assertNotIn("Default", p, f"{name}:{key}")
            for node in walk(t):
                if isinstance(node, dict):
                    for k in ("MasterUserPassword", "Password", "SecretString", "AccessKeyId", "SecretAccessKey"):
                        self.assertNotIn(k, node, f"{name}: literal {k}")
        for example in (ROOT / "deploy" / "aws" / "parameters").glob("*.json"):
            for entry in json.loads(example.read_text()):
                value = entry["ParameterValue"]
                self.assertTrue(value.startswith("<") or entry["ParameterKey"] in {"EnvironmentName", "DesiredCount", "ApiTaskCpu", "EnableExecuteCommand", "PostgresEngineVersion", "RedisAuthTokenParameterName", "RedisEnabled", "CertificateValidationHostedZoneId", "VpcCidr", "ServiceEnabled", "DatabaseAutoStop", "BudgetLimitUsd", "BudgetActualWarningUsd", "BudgetForecastWarningUsd", "CostAnomalyMonitorEnabled", "CostAnomalyThresholdUsd"}, f"{example.name}: {entry}")


    def test_parameter_examples_match_the_templates(self):
        for stack, name in (("foundation", "10-foundation.yaml"), ("data", "20-data.yaml"), ("edge", "30-edge.yaml"), ("service", "40-service.yaml")):
            entries = json.loads((ROOT / "deploy" / "aws" / "parameters" / f"{stack}.example.json").read_text())
            keys = {e["ParameterKey"] for e in entries}
            params = T[name]["Parameters"]
            self.assertLessEqual(keys, set(params), stack)
            self.assertLessEqual({k for k, p in params.items() if "Default" not in p}, keys, stack)
        service = {e["ParameterKey"]: e["ParameterValue"] for e in json.loads((ROOT / "deploy" / "aws" / "parameters" / "service.example.json").read_text())}
        self.assertEqual(service["DesiredCount"], "0")  # first service deploy (Phase 5) starts no task
        self.assertEqual(service["ServiceEnabled"], "false")  # ... and creates no ECS service at all


class Cost(unittest.TestCase):
    """17: the staging shape stays small; the budget measures gross usage (credits excluded)."""

    def test_sizes(self):
        data = T["20-data.yaml"]["Parameters"]
        self.assertEqual(data["DatabaseInstanceClass"]["AllowedValues"], ["db.t4g.micro"])
        self.assertEqual(data["RedisNodeType"]["AllowedValues"], ["cache.t4g.micro"])
        self.assertLessEqual(data["DatabaseMaxAllocatedStorageGiB"]["MaxValue"], 50)
        self.assertEqual(DATA["Database"]["Properties"]["StorageType"], "gp3")
        self.assertIs(DATA["Database"]["Properties"]["EnablePerformanceInsights"], False)
        self.assertEqual(DATA["Database"]["Properties"]["MonitoringInterval"], 0)
        self.assertEqual(DATA["Redis"]["Properties"]["SnapshotRetentionLimit"], 0)
        self.assertEqual(T["40-service.yaml"]["Parameters"]["ApiTaskCpu"]["AllowedValues"], [512, 1024])
        self.assertEqual(FOUNDATION["Cluster"]["Properties"]["ClusterSettings"], [{"Name": "containerInsights", "Value": "disabled"}])
        self.assertEqual(FOUNDATION["ApiLogGroup"]["Properties"]["RetentionInDays"], 14)
        self.assertIn("countNumber", FOUNDATION["ApiRepository"]["Properties"]["LifecyclePolicy"]["LifecyclePolicyText"])
        lb = {a["Key"]: a["Value"] for a in EDGE["LoadBalancer"]["Properties"]["LoadBalancerAttributes"]}
        self.assertEqual(lb["access_logs.s3.enabled"], "false")
        self.assertEqual(len(resources("AWS::ElasticLoadBalancingV2::LoadBalancer")), 1)
        self.assertEqual(len(resources("AWS::ECS::Service")), 1)

    def test_budget_notifications(self):
        params = T["10-foundation.yaml"]["Parameters"]
        self.assertEqual((params["BudgetActualWarningUsd"]["Default"], params["BudgetForecastWarningUsd"]["Default"], params["BudgetLimitUsd"]["Default"]), (10, 15, 25))
        self.assertEqual(params["BudgetLimitUsd"]["MaxValue"], 60)  # the owner's intervention ceiling
        b = FOUNDATION["MonthlyCostBudget"]["Properties"]
        self.assertEqual(b["Budget"]["BudgetLimit"], {"Amount": ref("BudgetLimitUsd"), "Unit": "USD"})
        got = [(n["Notification"]["NotificationType"], n["Notification"]["Threshold"], n["Notification"]["ThresholdType"]) for n in b["NotificationsWithSubscribers"]]
        self.assertEqual(got, [("ACTUAL", ref("BudgetActualWarningUsd"), "ABSOLUTE_VALUE"), ("FORECASTED", ref("BudgetForecastWarningUsd"), "ABSOLUTE_VALUE"), ("ACTUAL", ref("BudgetLimitUsd"), "ABSOLUTE_VALUE")])
        self.assertIn("does not cap", (TEMPLATES / "10-foundation.yaml").read_text())

    def test_budget_sees_credit_consumption(self):
        # With credits included (the AWS default) the budget would see ~$0 while promotional credits
        # pay, and never notify.
        cost_types = FOUNDATION["MonthlyCostBudget"]["Properties"]["Budget"]["CostTypes"]
        self.assertIs(cost_types["IncludeCredit"], False)
        self.assertIs(cost_types["IncludeRefund"], False)

    def test_cost_anomaly_alerts(self):
        monitor = FOUNDATION["CostAnomalyMonitor"]
        self.assertEqual(monitor["Condition"], "WithCostAnomalyMonitor")
        self.assertEqual((monitor["Properties"]["MonitorType"], monitor["Properties"]["MonitorDimension"]), ("DIMENSIONAL", "SERVICE"))
        sub = FOUNDATION["CostAnomalySubscription"]["Properties"]
        self.assertEqual(sub["Frequency"], "DAILY")
        self.assertEqual(sub["Subscribers"], [{"Type": "EMAIL", "Address": ref("AlertEmail")}])
        self.assertEqual(T["10-foundation.yaml"]["Parameters"]["CostAnomalyMonitorEnabled"]["Default"], "true")

    def test_session_guards(self):
        alarm = EDGE["SessionLeftRunningAlarm"]["Properties"]
        self.assertEqual((alarm["MetricName"], alarm["Period"] * alarm["EvaluationPeriods"], alarm["Threshold"]), ("HealthyHostCount", 8 * 3600, 1))
        self.assertEqual(T["20-data.yaml"]["Parameters"]["DatabaseAutoStop"]["Default"], "true")
        self.assertIn('"countNumber":5', FOUNDATION["ApiRepository"]["Properties"]["LifecyclePolicy"]["LifecyclePolicyText"])


if __name__ == "__main__":
    unittest.main()
