"""Offline tests for the owner's bring-up helper (deploy/aws/staging-bringup.sh) and the runbook.

They keep the helper and docs/aws-staging.md in step with the templates: the IAM capability each change
set needs, the exact resources a CREATE change set may add for every legitimate parameter combination,
and the budget thresholds the runbook quotes. Nothing here calls AWS: the change-set test puts a
recording stand-in for the `aws` command first on PATH.
"""

import hashlib
import itertools
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "deploy" / "aws" / "staging-bringup.sh"
RUNBOOK = ROOT / "docs" / "aws-staging.md"
STACKS = {"foundation": "10-foundation.yaml", "data": "20-data.yaml", "edge": "30-edge.yaml", "service": "40-service.yaml"}


def template(stack):
    t, matches = decode(str(ROOT / "deploy" / "aws" / "templates" / STACKS[stack]))
    if matches:
        raise AssertionError(f"{stack} does not parse: {matches}")
    return t


def evaluate(expr, params, conditions):
    """CloudFormation condition functions, as far as these templates use them."""
    if isinstance(expr, dict):
        ((fn, arg),) = expr.items()
        if fn == "Ref":
            return params[arg]
        if fn == "Condition":
            return evaluate(conditions[arg], params, conditions)
        if fn == "Fn::Equals":
            a, b = (evaluate(x, params, conditions) for x in arg)
            return str(a) == str(b)
        if fn == "Fn::Not":
            return not evaluate(arg[0], params, conditions)
        if fn == "Fn::And":
            return all(evaluate(x, params, conditions) for x in arg)
        if fn == "Fn::Or":
            return any(evaluate(x, params, conditions) for x in arg)
        raise AssertionError(f"unsupported condition function {fn}")
    return expr


def condition_parameters(t):
    """Parameters the template's Conditions read, with every value worth trying."""
    names = set()

    def refs(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "Ref":
                    names.add(v)
                refs(v)
        elif isinstance(node, list):
            for v in node:
                refs(v)

    refs(t.get("Conditions", {}))
    out = {}
    for n in sorted(names):
        p = t["Parameters"][n]
        out[n] = [str(v) for v in p["AllowedValues"]] if "AllowedValues" in p else [str(p.get("Default", "")), "Z0000000000000EXAMPLE"]
    return out


def combinations(stack):
    t = template(stack)
    choices = condition_parameters(t)
    for values in itertools.product(*choices.values()):
        yield t, dict(zip(choices, values))


def resources_for(t, chosen):
    params = {n: str(p.get("Default", "")) for n, p in t["Parameters"].items()}
    params.update(chosen)
    conditions = t.get("Conditions", {})
    return sorted(n for n, r in t["Resources"].items() if "Condition" not in r or evaluate(conditions[r["Condition"]], params, conditions))


def run_helper(work, *args, env=None, check=True):
    # Unless a test supplies its own stand-in, any aws call fails loudly: these steps must make none.
    deny = work / "deny-aws"
    if not deny.exists():
        deny.mkdir()
        (deny / "aws").write_text("#!/bin/sh\necho 'unexpected aws call' >&2\nexit 99\n")
        (deny / "aws").chmod(0o755)
    e = {"PATH": f"{deny}:{os.environ['PATH']}", "HOME": str(work), "EXPECTED_SHA": "0" * 40, "DASH_STAGING_DIR": str(work)}
    e.update(env or {})
    return subprocess.run(["bash", str(HELPER), *args], env=e, capture_output=True, text=True, check=check)


def write_params(work, stack, chosen, pretty):
    (work / "params").mkdir(parents=True, exist_ok=True)
    entries = [{"ParameterKey": "EnvironmentName", "ParameterValue": "staging"}] + [{"ParameterKey": k, "ParameterValue": v} for k, v in chosen.items()]
    # Both layouts the helper produces: one entry per line (params) and json.dump(indent=2) (redis on|off).
    (work / "params" / f"{stack}.json").write_text(json.dumps(entries, indent=2) if pretty else "[\n" + ",\n".join("  " + json.dumps(e) for e in entries) + "\n]\n")


class Capabilities(unittest.TestCase):
    """P1: a stack that creates IAM must get the matching capability from the helper, never by memory."""

    def required(self, stack):
        roles = [r for r in template(stack)["Resources"].values() if r["Type"].startswith("AWS::IAM::")]
        if any("RoleName" in r.get("Properties", {}) for r in roles):
            return "CAPABILITY_NAMED_IAM"
        return "CAPABILITY_IAM" if roles else ""

    def test_helper_capability_matches_each_template(self):
        with tempfile.TemporaryDirectory() as d:
            for stack in STACKS:
                with self.subTest(stack=stack):
                    self.assertEqual(run_helper(Path(d), "capabilities", stack).stdout.strip(), self.required(stack))
        self.assertEqual(self.required("data"), "CAPABILITY_NAMED_IAM")  # dash-ai-staging-postgres-autostop

    def test_change_set_is_created_with_that_capability(self):
        """cs-create, end to end, against a recording stand-in for the aws command."""
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            repo = work / "repo"
            (repo / "deploy" / "aws").mkdir(parents=True)
            subprocess.run(["cp", "-R", str(ROOT / "deploy" / "aws" / "templates"), str(repo / "deploy" / "aws")], check=True)
            git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run([*git, "add", "-A"], check=True)
            subprocess.run([*git, "commit", "-q", "-m", "t"], check=True)
            sha = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
            bindir = work / "bin"
            bindir.mkdir()
            log = work / "aws.log"
            fake = bindir / "aws"
            fake.write_text(f"""#!/usr/bin/env bash
printf '%s\\n' "$*" >>{log}
case "$*" in
  *"sts get-caller-identity"*Account*) echo 111122223333 ;;
  *"sts get-caller-identity"*Arn*) echo arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Test_0/test ;;
  *"ssm describe-parameters"*DATABASE_URL*) echo 0 ;;
  *"ssm describe-parameters"*) echo 1 ;;
  *"describe-stacks --stack-name dash-ai-staging-data"*) echo CREATE_COMPLETE ;;
  *"describe-stacks"*) exit 254 ;;
  *"create-change-set"*|*"wait change-set-create-complete"*) ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
""")
            fake.chmod(0o755)
            (work / "review").mkdir()
            for stack in STACKS:
                with self.subTest(stack=stack):
                    write_params(work, stack, {"ServiceEnabled": "false"} if stack == "service" else {}, pretty=False)
                    log.write_text("")
                    run_helper(work, "cs-create", stack, env={
                        "PATH": f"{bindir}:{os.environ['PATH']}", "EXPECTED_SHA": sha, "DASH_REPO": str(repo),
                        "EXPECTED_ACCOUNT_ID": "111122223333", "AWS_PROFILE": "test"})
                    (create,) = [line for line in log.read_text().splitlines() if "create-change-set" in line]
                    self.assertIn(f"--stack-name dash-ai-staging-{stack} ", create)
                    if self.required(stack):
                        self.assertIn(f"--capabilities {self.required(stack)}", create)
                    else:
                        self.assertNotIn("--capabilities", create)

    def test_runbook_names_every_stack_that_needs_the_capability(self):
        text = RUNBOOK.read_text()
        (line,) = [l for l in text.splitlines() if l.startswith("#") and "CAPABILITY_NAMED_IAM" in l]
        for stack in STACKS:
            with self.subTest(stack=stack):
                self.assertEqual(f"the {stack} " in line or f" {stack} stack" in line or f"and {stack}" in line, bool(self.required(stack)), line)
        self.assertIn("dash-ai-staging-data` (change set, `CAPABILITY_NAMED_IAM`", text)


class ExpectedResources(unittest.TestCase):
    """P2: cs-review accepts exactly the template's resources for the chosen parameters, nothing else."""

    def test_helper_matches_the_template_for_every_parameter_combination(self):
        seen = {}
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            for stack in STACKS:
                for pretty in (False, True):
                    for t, chosen in combinations(stack):
                        with self.subTest(stack=stack, params=chosen, pretty=pretty):
                            write_params(work, stack, chosen, pretty)
                            got = run_helper(work, "expected-resources", stack).stdout.split()
                            self.assertEqual(got, resources_for(t, chosen))
                            seen[(stack, tuple(sorted(chosen.items())))] = len(got)
        # Both legitimate foundation shapes (anomaly monitor on: 37, off because one exists: 35).
        self.assertEqual(seen[("foundation", (("CostAnomalyMonitorEnabled", "true"),))], 37)
        self.assertEqual(seen[("foundation", (("CostAnomalyMonitorEnabled", "false"),))], 35)
        self.assertEqual(seen[("data", (("DatabaseAutoStop", "true"), ("RedisEnabled", "true")))], 11)
        self.assertEqual(seen[("service", (("EnableExecuteCommand", "false"), ("ServiceEnabled", "false")))], 5)

    def test_defaults_apply_when_a_parameter_is_absent(self):
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            for stack in STACKS:
                with self.subTest(stack=stack):
                    write_params(work, stack, {}, pretty=False)
                    self.assertEqual(run_helper(work, "expected-resources", stack).stdout.split(), resources_for(template(stack), {}))

    def test_review_compares_resource_ids_not_a_count(self):
        body = HELPER.read_text().split("step_cs_review() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn('expected_resources "$s"', body)
        self.assertIn("LogicalResourceId", body)
        self.assertNotIn("expected_adds", HELPER.read_text())


class RunbookCost(unittest.TestCase):
    """P2/P3: the runbook quotes the template's budget and anomaly defaults, never older figures."""

    def test_budget_figures_in_the_runbook_are_the_template_defaults(self):
        p = template("foundation")["Parameters"]
        want = tuple(str(p[k]["Default"]) for k in ("BudgetActualWarningUsd", "BudgetForecastWarningUsd", "BudgetLimitUsd"))
        text = RUNBOOK.read_text()
        found = re.findall(r"\$(\d+)\s+actual(?:\*\*)?\s*[,/]\s*(?:\*\*)?\$(\d+)\s+forecast(?:\*\*)?\s*[,/]\s*(?:and\s+)?(?:\*\*)?\$(\d+)\s+actual", text)
        self.assertTrue(found)
        for f in found:
            self.assertEqual(f, want)
        self.assertIn(f"${p['CostAnomalyThresholdUsd']['Default']} or more", text)


class ReviewGate(unittest.TestCase):
    """cs-review, end to end against a stand-in aws: the reviewed change sets pass, anything else STOPs."""

    crlf = False  # CrlfReviewGate reruns every test with Windows (Git Bash) CRLF line endings

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.work = Path(self._d.name)
        (self.work / "review").mkdir()
        self.state = self.work / "cs"
        self.state.mkdir()
        bindir = self.work / "bin"
        bindir.mkdir()
        fake = bindir / "aws"
        # Answers each describe-change-set query cs-review makes from files the test writes.
        fake.write_text(f"""#!/usr/bin/env bash
S={self.state}
{{ case "$*" in
  *"sts get-caller-identity"*Account*) echo 111122223333 ;;
  *"sts get-caller-identity"*Arn*) echo arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Test_0/test ;;
  *"--include-property-values"*) echo '{{"Changes": []}}' ;;
  *"ResourceChange.[Action"*) echo table ;;
  *"--query ExecutionStatus"*) echo AVAILABLE ;;
  *"--query Parameters[]"*) echo ;;
  *"ResourceChange.Replacement=='True'"*) cat "$S/replacements" ;;
  *"Action=='Remove'"*) cat "$S/removes" ;;
  *"Action!=\\`Add\\`"*) cat "$S/non_adds" ;;
  *"--query Changes[].ResourceChange.LogicalResourceId"*) cat "$S/ids" ;;
  *"--query Changes[].ResourceChange.ResourceType"*) cat "$S/types" ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac; }} | if [ -f "$S/crlf" ]; then sed 's/$/\r/'; else cat; fi
""")
        fake.chmod(0o755)
        if self.crlf:
            (self.state / "crlf").write_text("")
        self.env = {"PATH": f"{bindir}:{os.environ['PATH']}", "EXPECTED_ACCOUNT_ID": "111122223333", "AWS_PROFILE": "test"}

    def tearDown(self):
        self._d.cleanup()

    def change_set(self, stack, chosen, ids, types, removes=(), non_adds=0, replacements=0):
        write_params(self.work, stack, chosen, pretty=False)
        (self.work / "review" / f"{stack}.changeset").write_text(f"{stack}-test\n")
        # The aws CLI's text output: one tab-separated line per list.
        (self.state / "ids").write_text("\t".join(ids) + "\n")
        (self.state / "types").write_text("\t".join(types) + "\n")
        (self.state / "removes").write_text("\t".join(removes) + "\n")
        (self.state / "non_adds").write_text(f"{non_adds}\n")
        (self.state / "replacements").write_text(f"{replacements}\n")
        return run_helper(self.work, "cs-review", stack, env=self.env, check=False)

    def create(self, stack, chosen, swap=None, extra=None):
        t = template(stack)
        ids = resources_for(t, chosen)
        types = [t["Resources"][i]["Type"] for i in ids]
        if swap:
            types[ids.index(swap[0])] = swap[1]
        if extra:
            ids, types = ids + [extra[0]], types + [extra[1]]
        return self.change_set(stack, chosen, ids, types)

    def assertPasses(self, r):
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("only the reviewed resource types", r.stdout)
        self.assertNotIn("STOP", r.stdout + r.stderr)

    def assertStops(self, r, why):
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn("STOP:", r.stderr)
        self.assertIn(why, r.stderr)

    def test_the_phase3_foundation_change_set_passes(self):
        """The exact Phase 3 shape: 35 additions including AWS::EC2::VPC, budget 30/35/45, no anomaly monitor."""
        chosen = {"CostAnomalyMonitorEnabled": "false", "BudgetActualWarningUsd": "30", "BudgetForecastWarningUsd": "35", "BudgetLimitUsd": "45"}
        self.assertEqual(len(resources_for(template("foundation"), chosen)), 35)
        self.assertIn("AWS::EC2::VPC", [template("foundation")["Resources"][i]["Type"] for i in resources_for(template("foundation"), chosen)])
        r = self.create("foundation", chosen)
        self.assertPasses(r)
        self.assertIn("35 additions, exactly the reviewed resources", r.stdout)

    def test_every_legitimate_create_passes(self):
        for stack in STACKS:
            for _, chosen in combinations(stack):
                with self.subTest(stack=stack, params=chosen):
                    self.assertPasses(self.create(stack, chosen))

    def test_each_allowed_type_is_accepted_wherever_it_sits_in_the_list(self):
        """Every allowed type, first and last included, is accepted on its own."""
        for stack in STACKS:
            allowed = run_helper(self.work, "allowed-types", stack).stdout.split()
            self.assertTrue(allowed)
            for ty in allowed:
                with self.subTest(stack=stack, type=ty):
                    self.assertPasses(self.change_set(stack, {}, ["X"], [ty], non_adds=1))
        self.assertEqual(run_helper(self.work, "allowed-types", "foundation").stdout.split()[0], "AWS::EC2::VPC")

    def test_allowed_types_cover_each_template_and_nothing_more(self):
        for stack in STACKS:
            with self.subTest(stack=stack):
                allowed = set(run_helper(self.work, "allowed-types", stack).stdout.split())
                self.assertEqual(allowed, {r["Type"] for r in template(stack)["Resources"].values()})

    def test_an_unexpected_type_stops(self):
        for wrong in ("AWS::EC2::NatGateway", "AWS::RDS::DBInstance", "AWS::IAM::Role", "AWS::EC2::VPCEndpoint",
                      "AWS::EC2::VP", "WS::EC2::VPC", "aws::ec2::vpc", "*", "AWS::EC2::*"):
            with self.subTest(type=wrong):
                r = self.create("foundation", {"CostAnomalyMonitorEnabled": "false"}, swap=("Vpc", wrong))
                self.assertStops(r, "unexpected resource type")

    def test_an_unexpected_resource_stops_before_the_type_check(self):
        r = self.create("foundation", {"CostAnomalyMonitorEnabled": "false"}, extra=("NatGateway", "AWS::EC2::NatGateway"))
        self.assertStops(r, "does not add exactly the reviewed resources")
        r = self.create("foundation", {"CostAnomalyMonitorEnabled": "false"}, extra=("Vpc2", "AWS::EC2::VPC"))
        self.assertStops(r, "does not add exactly the reviewed resources")

    def test_removals_and_replacements(self):
        park = dict(ids=["Redis", "RedisMemoryAlarm"], types=["AWS::ElastiCache::ReplicationGroup", "AWS::CloudWatch::Alarm"], non_adds=2)
        self.assertPasses(self.change_set("data", {}, removes=["Redis", "RedisMemoryAlarm"], **park))
        self.assertPasses(self.change_set("data", {}, removes=["RedisMemoryAlarm", "Redis"], **park))
        for bad in (["Database"], ["Redis", "Database"], ["DatabaseSubnetGroup"], ["Redi"]):
            with self.subTest(removes=bad):
                self.assertStops(self.change_set("data", {}, removes=bad, **park), "REMOVES")
        self.assertStops(self.change_set("foundation", {}, removes=["Vpc"], ids=["Vpc"], types=["AWS::EC2::VPC"], non_adds=1), "REMOVES")
        self.assertStops(self.change_set("data", {}, replacements=1, **park), "REPLACES")


class CrlfReviewGate(ReviewGate):
    """The same gate when the AWS CLI ends every text line with CRLF (Windows Git Bash / MINGW64).

    The Phase 3 foundation review stopped on "AWS::EC2::VPC\\r": Vpc is the last logical id, so its type was
    the last value of the tab-separated line and kept the CR. Every ReviewGate test runs again here.
    """

    crlf = True

    def test_the_stand_in_really_ends_lines_with_crlf(self):
        self.create("foundation", {"CostAnomalyMonitorEnabled": "false"})
        out = subprocess.run([str(self.work / "bin" / "aws"), "cloudformation", "describe-change-set", "--query",
                              "Changes[].ResourceChange.ResourceType"], capture_output=True).stdout
        self.assertTrue(out.endswith(b"AWS::EC2::VPC\r\n"), out[-40:])

    def test_a_carriage_return_inside_a_line_still_stops(self):
        """Only a CR that ends a line is dropped; one anywhere else stays part of the value and fails."""
        t = template("foundation")
        ids = resources_for(t, {"CostAnomalyMonitorEnabled": "false"})
        types = [t["Resources"][i]["Type"] for i in ids]
        types[0] = types[0] + "\r"
        self.assertStops(self.change_set("foundation", {"CostAnomalyMonitorEnabled": "false"}, ids, types), "unexpected resource type")
        park = dict(ids=["Redis", "RedisMemoryAlarm"], types=["AWS::ElastiCache::ReplicationGroup", "AWS::CloudWatch::Alarm"], non_adds=2)
        self.assertStops(self.change_set("data", {}, removes=["Redis\r", "RedisMemoryAlarm"], **park), "REMOVES")


class AwsTextOutput(unittest.TestCase):
    """Every AWS call goes through awsr, which drops only line-ending CRs."""

    def test_no_aws_call_bypasses_awsr(self):
        def invokes_aws(line):
            code = re.sub(r'"[^"]*"', '""', line.split("#", 1)[0] if line.lstrip().startswith("#") else line)
            return re.search(r"(^|[\s;|&(])aws\s", code) and "command -v aws" not in code
        calls = [l.strip() for l in HELPER.read_text().splitlines() if invokes_aws(l)]
        self.assertEqual([l for l in calls if not l.startswith("awsr() {") and not l.startswith("aws --version")], [])
        self.assertTrue(any(l.startswith("awsr() {") for l in calls))

    def test_awsr_strips_only_line_ending_carriage_returns(self):
        body = [l for l in HELPER.read_text().splitlines() if l.startswith("awsr() {")][0]
        self.assertIn("sub(/\\r$/, \"\")", body)
        out = subprocess.run(["awk", '{ sub(/\\r$/, ""); print }'], input=b"a\tAWS::EC2::VPC\r\nx\ry\r\n", capture_output=True, check=True).stdout
        self.assertEqual(out, b"a\tAWS::EC2::VPC\nx\ry\n")


# A fixed, non-secret stand-in for the value get-parameter returns in the redis-url tests.
STAND_IN = "standin" + "0" * 57
# The SSM parameter paths the secrets step creates, in order (names only; no value is ever involved).
INITIAL_PARAMETER_PATHS = tuple("/dash-ai/staging/" + p for p in ("REDIS_AUTH_TOKEN", "DATA_ENCRYPTION_KEY", "METRICS_TOKEN", "OPERATOR_TOKEN"))


class SecretFiles(unittest.TestCase):
    """secrets and redis-url: values reach the AWS CLI only through a 600 file in the protected working
    directory, never argv, output or the system /tmp, and the file is removed on success and on failure.

    windows = True adds a cygpath stand-in (Git Bash) and an aws stand-in that, like the native Windows AWS
    CLI, cannot open an MSYS path (incident 2026-10-24: file:///tmp/tmp.l48OJHr9K7, no such file).
    Values are random per run, live only in the test's temporary directory and are never printed.
    """

    windows = False

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        root = Path(self._d.name)
        self.work, self.state, self.systmp = root / "work", root / "state", root / "systmp"
        for d in (self.work, self.state, self.systmp):
            d.mkdir()
        bindir = root / "bin"
        bindir.mkdir()
        S = self.state
        fake = bindir / "aws"
        fake.write_text(f"""#!/usr/bin/env bash
S={S}
printf '%s\\n' "$*" >>"$S/argv"
case "$*" in
  *"sts get-caller-identity"*Account*) echo 111122223333 ;;
  *"sts get-caller-identity"*Arn*) echo arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Test_0/test ;;
  *"describe-stacks --stack-name dash-ai-staging-foundation"*) echo CREATE_COMPLETE ;;
  *"describe-stacks --stack-name dash-ai-staging-data"*RedisAddress*) echo master.dash-ai-staging-redis.example.euw1.cache.amazonaws.com ;;
  *"ssm describe-parameters"*)
    n=0; for e in $(cat "$S/existing" 2>/dev/null); do case "$*" in *"Values=$e "*|*"Values=$e") n=1 ;; esac; done; echo $n ;;
  *"ssm get-parameter"*REDIS_AUTH_TOKEN*--with-decryption*) echo {STAND_IN} ;;
  *"ssm put-parameter"*)
    v=""; prev=""; for a in "$@"; do [ "$prev" = --value ] && v="$a"; prev="$a"; done
    case "$v" in file://*) ;; *) echo "value is not a file:// argument" >&2; exit 97 ;; esac
    p="${{v#file://}}"
    if [ -f "$S/windows" ]; then
      case "$p" in W:/*) p="${{p#W:}}" ;; *) echo "aws: [ERROR]: Unable to load paramfile $v: [Errno 2] No such file or directory" >&2; exit 252 ;; esac
    fi
    printf '%s %s %s\\n' "$p" "$(stat -c %a "$p")" "$(stat -c %a "$(dirname "$p")")" >>"$S/files"
    {{ cat "$p"; echo; }} >>"$S/values"
    [ ! -f "$S/fail-put" ] || {{ echo "An error occurred (AccessDeniedException)" >&2; exit 254; }} ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
""")
        fake.chmod(0o755)
        if self.windows:
            (S / "windows").write_text("")
            cyg = bindir / "cygpath"
            cyg.write_text('#!/bin/sh\n[ "$1" = -m ] || exit 2\nprintf "W:%s\\n" "$2"\n')
            cyg.chmod(0o755)
        self.env = {"PATH": f"{bindir}:{os.environ['PATH']}", "EXPECTED_ACCOUNT_ID": "111122223333",
                    "AWS_PROFILE": "test", "TMPDIR": str(self.systmp)}

    def tearDown(self):
        self._d.cleanup()

    def run_step(self, *args, stdin="\n"):
        e = {"PATH": os.environ["PATH"], "HOME": str(self.work), "EXPECTED_SHA": "0" * 40, "DASH_STAGING_DIR": str(self.work)}
        e.update(self.env)
        return subprocess.run(["bash", str(HELPER), *args], env=e, input=stdin, capture_output=True, text=True)

    def puts(self):
        argv = (self.state / "argv").read_text().splitlines() if (self.state / "argv").exists() else []
        return [a for a in argv if "ssm put-parameter" in a]

    def values(self):
        p = self.state / "values"
        return [v for v in p.read_text().splitlines() if v] if p.exists() else []

    def files(self):
        p = self.state / "files"
        return [l.split() for l in p.read_text().splitlines()] if p.exists() else []

    def assertNoSecretLeft(self):
        tmp = self.work / "tmp"
        self.assertEqual(sorted(os.listdir(tmp)) if tmp.exists() else [], [], "a secret file was left in the working directory")
        self.assertEqual(os.listdir(self.systmp), [], "the system temporary directory was used")

    def assertNotExposed(self, r):
        argv = (self.state / "argv").read_text()
        for v in self.values():
            self.assertTrue(v not in argv and v not in r.stdout and v not in r.stderr, "a secret value was exposed")

    def assertFromWorkDir(self):
        for path, mode, dmode in self.files():
            self.assertTrue(path.startswith(str(self.work / "tmp") + "/"), "secret file outside the working directory")
            self.assertEqual((mode, dmode), ("600", "700"))
        if self.windows:
            for a in self.puts():
                self.assertIn("--value file://W:/", a)

    def test_secrets_are_written_through_protected_files_and_removed(self):
        r = self.run_step("secrets")
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual([a.split("--name ")[1].split()[0] for a in self.puts()], list(INITIAL_PARAMETER_PATHS))
        self.assertEqual(len(self.files()), 4)
        self.assertFromWorkDir()
        self.assertEqual(len(set(self.values())), 4)
        self.assertNotExposed(r)
        self.assertNoSecretLeft()
        self.assertIn("ESCROW NOW: open " + str(self.work / "tmp") + "/secret.", r.stdout)
        self.assertIn("DATABASE_URL does not exist", r.stdout)

    def test_a_failed_put_parameter_removes_the_file(self):
        (self.state / "fail-put").write_text("")
        r = self.run_step("secrets")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(len(self.puts()), 1)
        self.assertFromWorkDir()
        self.assertNotExposed(r)
        self.assertNoSecretLeft()

    def test_a_failure_after_the_escrow_pause_removes_the_key_file(self):
        (self.state / "existing").write_text("/dash-ai/staging/REDIS_AUTH_TOKEN\n")
        (self.state / "fail-put").write_text("")
        r = self.run_step("secrets")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ESCROW NOW", r.stdout)
        self.assertIn("/dash-ai/staging/DATA_ENCRYPTION_KEY", self.puts()[0])
        self.assertNotExposed(r)
        self.assertNoSecretLeft()

    def test_stopping_at_the_escrow_pause_removes_the_key_file(self):
        e = {"PATH": os.environ["PATH"], "HOME": str(self.work), "EXPECTED_SHA": "0" * 40, "DASH_STAGING_DIR": str(self.work)}
        e.update(self.env)
        (self.state / "existing").write_text("/dash-ai/staging/REDIS_AUTH_TOKEN\n")
        p = subprocess.Popen(["bash", str(HELPER), "secrets"], env=e, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(200):
                if any(n.startswith("secret.") for n in os.listdir(self.work / "tmp")) if (self.work / "tmp").exists() else False:
                    break
                time.sleep(0.05)
            time.sleep(0.3)  # the generator has written the file; the helper now waits at the escrow prompt
            p.send_signal(signal.SIGTERM)
            p.communicate(timeout=20)
        finally:
            p.kill() if p.poll() is None else None
        self.assertEqual(p.returncode, 130)
        self.assertEqual(self.puts(), [])
        self.assertNoSecretLeft()

    def test_existing_secrets_are_never_regenerated_or_overwritten(self):
        (self.state / "existing").write_text("\n".join(INITIAL_PARAMETER_PATHS) + "\n")
        r = self.run_step("secrets")
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.puts(), [])
        self.assertEqual(r.stdout.count("already exists: left unchanged (never overwritten)"), 4)
        self.assertNoSecretLeft()

    def test_database_url_guard_still_stops(self):
        (self.state / "existing").write_text("\n".join(INITIAL_PARAMETER_PATHS) + "\n" + "/dash-ai/staging/DATABASE_URL\n")
        r = self.run_step("secrets")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("DATABASE_URL exists", r.stderr)

    def test_redis_url_uses_the_same_protected_files(self):
        r = self.run_step("redis-url")
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(len(self.puts()), 1)
        self.assertIn("--name /dash-ai/staging/REDIS_URL", self.puts()[0])
        self.assertFromWorkDir()
        self.assertTrue(self.values() == [f"rediss://:{STAND_IN}@master.dash-ai-staging-redis.example.euw1.cache.amazonaws.com:6379"], "unexpected REDIS_URL value")
        self.assertNotExposed(r)
        self.assertTrue(STAND_IN not in r.stdout + r.stderr + (self.state / "argv").read_text(), "stand-in value exposed")
        self.assertNoSecretLeft()

    def test_redis_url_failure_removes_both_files(self):
        (self.state / "fail-put").write_text("")
        r = self.run_step("redis-url")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotExposed(r)
        self.assertNoSecretLeft()

    def test_existing_redis_url_is_left_unchanged(self):
        (self.state / "existing").write_text("/dash-ai/staging/REDIS_URL\n")
        r = self.run_step("redis-url")
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.puts(), [])
        self.assertNoSecretLeft()


class WindowsSecretFiles(SecretFiles):
    windows = True


class FileArguments(unittest.TestCase):
    def test_every_file_argument_goes_through_file_arg(self):
        code = [l for l in HELPER.read_text().splitlines() if not l.lstrip().startswith("#")]
        raw = [l.strip() for l in code if "file://" in l and not l.startswith("file_arg() {")]
        self.assertEqual(raw, [])
        self.assertFalse([l for l in code if "mktemp)" in l or 'mktemp"' in l], "a bare mktemp (system /tmp) remains")


# The reviewed RDS eu-west-1 bundle: its SHA-256 and the SHA-256 fingerprints of its three roots (same as the helper).
RDS_BUNDLE = ROOT / "deploy" / "container" / "certs" / "rds-eu-west-1-bundle.pem"
RDS_BUNDLE_SHA256 = "a11cf9a1d0aadd7db86f92cbaa496466daeb501bf1c5e429d8ce8914a01c15d6"
RDS_ROOT_FINGERPRINTS = (
    "62:E2:9E:F9:03:10:94:7E:ED:5D:55:46:02:1D:63:60:08:FA:D3:29:FA:B9:EA:31:BA:1A:E7:68:B7:34:F2:9A",
    "6F:7E:01:B6:2A:F2:40:58:41:71:30:B2:1E:5F:B9:AD:9F:29:B2:9C:77:5C:51:07:B6:57:41:90:10:97:58:86",
    "88:EC:F0:27:44:8F:71:98:F3:C1:A6:76:24:74:C4:65:8D:AB:35:A1:86:86:AF:6B:65:DE:3C:40:23:C6:D0:B2",
)
# A cygpath stand-in (Git Bash): marks a converted path with a W: drive so the native stand-ins can tell.
CYGPATH = '#!/bin/sh\n[ "$1" = -m ] || exit 2\nprintf "W:%s\\n" "$2"\n'


def stand_in(bindir, name, body):
    f = bindir / name
    f.write_text(body)
    f.chmod(0o755)


class RdsCaDownload(unittest.TestCase):
    """rds-ca: curl and openssl get the bundle path in the form the platform's programs can open, and the
    provenance checks still read the same file through its POSIX path.

    windows = True adds a cygpath stand-in (Git Bash), a curl stand-in that, like native MinGW curl, cannot
    write to an MSYS path (incident 2026-10-24: curl: (23) client returned ERROR on write of 4576 bytes) and an
    openssl wrapper that, like native Windows OpenSSL, cannot open one for -certfile (incident 2026-10-24:
    BIO_new_file: No such process). The wrapper hands everything else to the real openssl, so the real
    fingerprints are computed. No network: the curl stand-in serves the committed bundle, or a tampered copy.
    """

    windows = False

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        root = Path(self._d.name)
        self.work, self.state, self.systmp, self.bindir = root / "work", root / "state", root / "systmp", root / "bin"
        for d in (self.work, self.state, self.systmp, self.bindir):
            d.mkdir()
        self.served = self.state / "served.pem"
        self.served.write_bytes(RDS_BUNDLE.read_bytes())
        self.repo = ROOT
        S = self.state
        stand_in(self.bindir, "curl", f"""#!/usr/bin/env bash
S={S}
out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
printf '%s\\n' "$out" >>"$S/outputs"
if [ -f "$S/windows" ]; then
  case "$out" in W:/*) out="${{out#W:}}" ;; *) echo "curl: (23) client returned ERROR on write of 4576 bytes" >&2; exit 23 ;; esac
fi
cat "$S/served.pem" >"$out"
""")
        stand_in(self.bindir, "openssl", f"""#!/usr/bin/env bash
S={S}
args=(); prev=""
for a in "$@"; do
  if [ "$prev" = -certfile ]; then
    printf '%s\\n' "$a" >>"$S/certfiles"
    if [ -f "$S/windows" ]; then
      case "$a" in W:/*) a="${{a#W:}}" ;; *) printf 'error opening the file, %s\\nBIO_new_file: No such process\\n' "$a" >&2; exit 1 ;; esac
    fi
  fi
  args+=("$a"); prev="$a"
done
if [ "${{1:-}}" = x509 ] && [ -f "$S/wrong-fingerprint" ]; then cat >/dev/null; echo "sha256 Fingerprint=00:11:22"; exit 0; fi
exec {shutil.which("openssl")} "${{args[@]}}"
""")
        if self.windows:
            (S / "windows").write_text("")
            stand_in(self.bindir, "cygpath", CYGPATH)

    def tearDown(self):
        self._d.cleanup()

    def run_step(self):
        return run_helper(self.work, "rds-ca", check=False, env={
            "PATH": f"{self.work / 'deny-aws'}:{self.bindir}:{os.environ['PATH']}",
            "DASH_REPO": str(self.repo), "TMPDIR": str(self.systmp)})

    def recorded(self, name):
        return (self.state / name).read_text().splitlines()

    def assertNative(self, path):
        posix = path[2:] if self.windows else path
        self.assertEqual(path.startswith("W:/"), self.windows, path)
        self.assertTrue(posix.startswith(str(self.systmp) + "/") and posix.endswith("/eu-west-1-bundle.pem"), path)

    def assertStopped(self, r, message):
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(message, r.stderr)
        self.assertFalse((self.work / "review" / "rds-ca-provenance.txt").exists())

    def test_download_passes_provenance(self):
        r = self.run_step()
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertIn("RDS CA provenance check PASSED", r.stdout)
        self.assertIn(RDS_BUNDLE_SHA256, (self.work / "review" / "rds-ca-provenance.txt").read_text())
        for fp in RDS_ROOT_FINGERPRINTS:
            self.assertIn(f"fingerprint  {fp}", r.stdout)
        [out] = self.recorded("outputs")
        [certfile] = self.recorded("certfiles")
        self.assertNative(out)
        self.assertEqual(certfile, out, "openssl must read the file curl wrote")
        self.assertEqual(list(self.systmp.iterdir()), [], "the download directory was left behind")

    def test_tampered_download_still_stops(self):
        self.served.write_bytes(self.served.read_bytes().replace(b"MII", b"MIJ", 1))
        self.assertStopped(self.run_step(), "downloaded bundle SHA-256 differs: DO NOT BUILD, PUSH OR DEPLOY")

    def test_tampered_committed_bundle_still_stops(self):
        self.repo = Path(self._d.name) / "repo"
        certs = self.repo / "deploy" / "container" / "certs"
        certs.mkdir(parents=True)
        # The CRLF copy a Windows checkout without .gitattributes produced (SHA-256 35871bb1...), then a byte flip.
        crlf = RDS_BUNDLE.read_bytes().replace(b"\n", b"\r\n")
        for bundle in (crlf, RDS_BUNDLE.read_bytes().replace(b"MII", b"MIJ", 1)):
            with self.subTest(crlf=bundle is crlf):
                (certs / "rds-eu-west-1-bundle.pem").write_bytes(bundle)
                self.assertStopped(self.run_step(), "committed bundle differs from the expected SHA-256")

    def test_fingerprint_mismatch_still_stops(self):
        (self.state / "wrong-fingerprint").write_text("")
        self.assertStopped(self.run_step(), "certificate fingerprints differ: DO NOT BUILD, PUSH OR DEPLOY")

    def test_only_native_program_arguments_are_converted(self):
        body = HELPER.read_text().split("step_rds_ca() {", 1)[1].split("\n}\n", 1)[0]
        self.assertEqual(body.count("native_path"), 2)
        self.assertIn('-o "$(native_path "$f")"', body)
        self.assertIn('-certfile "$(native_path "$f")"', body)
        self.assertIn('got="$(sha256 "$f")"', body)
        self.assertIn('rm -rf "$d"', body)
        self.assertNotRegex(body, r'\bf="\$\(native_path')

    def test_expected_bundle_and_fingerprints_unchanged(self):
        body = HELPER.read_text().split("step_rds_ca() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn(f"want={RDS_BUNDLE_SHA256}", body)
        self.assertEqual(sorted(re.findall(r"^\s+((?:[0-9A-F]{2}:){31}[0-9A-F]{2})", body, re.M)), sorted(RDS_ROOT_FINGERPRINTS))
        self.assertIn('[ "$fp" = "$(printf', body)
        self.assertIn(f"{RDS_BUNDLE_SHA256}  rds-eu-west-1-bundle.pem", (RDS_BUNDLE.parent / "SHA256SUMS").read_text())


class WindowsRdsCaDownload(RdsCaDownload):
    windows = True


class RepositoryCheck(unittest.TestCase):
    """check_repo (preflight, cs-create, image): the SHA and clean-tree checks run through git -C with a path
    native git can open. windows = True adds a cygpath stand-in and a git wrapper that, like native git.exe,
    cannot change to an MSYS path such as /c/Users/... (incident 2026-10-24); the wrapper then runs real git.
    cs-create data is used because it runs check_repo right after the identity check; the aws stand-in answers
    only the identity calls, so the step stops at its first later AWS call, never reaching AWS.
    """

    windows = False

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        root = Path(self._d.name)
        self.work, self.state, self.repo, self.bindir = root / "work", root / "state", root / "repo", root / "bin"
        for d in (self.work, self.state, self.repo, self.bindir):
            d.mkdir()
        g = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "HOME": str(root), "PATH": os.environ["PATH"]}
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", str(self.repo)]
        subprocess.run(git + ["init", "-q"], check=True, env=g)
        (self.repo / "README").write_text("x\n")
        subprocess.run(git + ["add", "README"], check=True, env=g)
        subprocess.run(git + ["commit", "-qm", "x"], check=True, env=g)
        self.sha = subprocess.run(git + ["rev-parse", "HEAD"], check=True, env=g, capture_output=True, text=True).stdout.strip()
        S = self.state
        stand_in(self.bindir, "aws", """#!/usr/bin/env bash
case "$*" in
  *"sts get-caller-identity"*Account*) echo 111122223333 ;;
  *"sts get-caller-identity"*Arn*) echo arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_Test_0/test ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
""")
        stand_in(self.bindir, "git", f"""#!/usr/bin/env bash
S={S}
if [ "${{1:-}}" = -C ]; then
  printf '%s\\n' "$2" >>"$S/dirs"
  d="$2"
  if [ -f "$S/windows" ]; then
    case "$d" in W:/*) d="${{d#W:}}" ;; *) echo "fatal: cannot change to '$d': No such file or directory" >&2; exit 128 ;; esac
  fi
  shift 2; exec {shutil.which("git")} -C "$d" "$@"
fi
exec {shutil.which("git")} "$@"
""")
        if self.windows:
            (S / "windows").write_text("")
            stand_in(self.bindir, "cygpath", CYGPATH)

    def tearDown(self):
        self._d.cleanup()

    def run_step(self, sha=None):
        return run_helper(self.work, "cs-create", "data", check=False, env={
            "PATH": f"{self.bindir}:{os.environ['PATH']}", "DASH_REPO": str(self.repo), "EXPECTED_SHA": sha or self.sha,
            "EXPECTED_ACCOUNT_ID": "111122223333", "AWS_PROFILE": "test", "GIT_CONFIG_GLOBAL": os.devnull})

    def test_clean_repository_at_the_sha_passes(self):
        r = self.run_step()
        self.assertIn(f"OK    repository at {self.sha}, clean", r.stdout, r.stderr[-500:])
        dirs = (self.state / "dirs").read_text().splitlines()
        self.assertEqual(dirs, [("W:" if self.windows else "") + str(self.repo)] * 2)

    def test_other_sha_still_stops(self):
        r = self.run_step(sha="1" * 40)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("DASH_REPO is not at " + "1" * 40, r.stderr)

    def test_dirty_tree_still_stops(self):
        (self.repo / "README").write_text("changed\n")
        r = self.run_step()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("DASH_REPO working tree is not clean", r.stderr)


class WindowsRepositoryCheck(RepositoryCheck):
    windows = True


class TrustMaterialLineEndings(unittest.TestCase):
    """.gitattributes keeps the reviewed PEM and SHA256SUMS byte-exact (LF) on checkout, even with Git for
    Windows' core.autocrlf=true, which otherwise writes CRLF (SHA-256 35871bb1... instead of a11cf9a1...)."""

    PATHS = ("deploy/container/certs/rds-eu-west-1-bundle.pem", "deploy/container/certs/SHA256SUMS")

    def git(self, *args, cwd=ROOT, **kw):
        env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "HOME": str(cwd), "PATH": os.environ["PATH"]}
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args], cwd=cwd, env=env,
                              check=True, capture_output=True, text=True, **kw).stdout

    def test_attributes_pin_lf(self):
        out = self.git("check-attr", "text", "eol", "--", *self.PATHS)
        for path in self.PATHS:
            self.assertIn(f"{path}: text: set", out)
            self.assertIn(f"{path}: eol: lf", out)

    def checkout_with_autocrlf(self, with_attributes):
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "src", Path(d) / "dst"
            for path in self.PATHS:
                (src / path).parent.mkdir(parents=True, exist_ok=True)
                (src / path).write_bytes((ROOT / path).read_bytes())
            if with_attributes:
                (src / ".gitattributes").write_bytes((ROOT / ".gitattributes").read_bytes())
            self.git("init", "-q", cwd=src)
            self.git("add", "-A", cwd=src)
            self.git("commit", "-qm", "x", cwd=src)
            self.git("-c", "core.autocrlf=true", "clone", "-q", "-c", "core.autocrlf=true", str(src), str(dst), cwd=Path(d))
            return {path: (dst / path).read_bytes() for path in self.PATHS}

    def test_autocrlf_checkout_is_byte_exact(self):
        files = self.checkout_with_autocrlf(with_attributes=True)
        self.assertEqual(hashlib.sha256(files[self.PATHS[0]]).hexdigest(), RDS_BUNDLE_SHA256)
        for path, data in files.items():
            self.assertNotIn(b"\r", data, path)
            self.assertEqual(data, (ROOT / path).read_bytes(), path)

    def test_without_the_attributes_autocrlf_breaks_the_hash(self):
        # The control: the incident this file prevents, reproduced (so the test above cannot pass vacuously).
        files = self.checkout_with_autocrlf(with_attributes=False)
        self.assertIn(b"\r\n", files[self.PATHS[0]])
        self.assertNotEqual(hashlib.sha256(files[self.PATHS[0]]).hexdigest(), RDS_BUNDLE_SHA256)
