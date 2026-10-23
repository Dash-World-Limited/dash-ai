"""Offline tests for the owner's bring-up helper (deploy/aws/staging-bringup.sh) and the runbook.

They keep the helper and docs/aws-staging.md in step with the templates: the IAM capability each change
set needs, the exact resources a CREATE change set may add for every legitimate parameter combination,
and the budget thresholds the runbook quotes. Nothing here calls AWS: the change-set test puts a
recording stand-in for the `aws` command first on PATH.
"""

import itertools
import json
import os
import re
import subprocess
import tempfile
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
