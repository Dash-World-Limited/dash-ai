"""Runs the two one-off database scripts embedded in 40-service.yaml against a LOCAL PostgreSQL 16
that only accepts TLS (deploy/aws/tests/tls-postgres.sh), with the same Node and pg client the image
ships. Proves: the classification query is read-only and reports a fresh database (B) and an adopted
prefix; certificate verification is on; the app-role script validates its URL, never sends the
password in clear, refuses a second run; the real migrate-cli then works as dash_app.

Opt-in: skipped unless DASH_OPS_TEST_ADMIN is set (validate.sh and CI set it). Never touches AWS.
"""

import json
import os
import re
import secrets
import subprocess
import unittest
from pathlib import Path

from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
API = ROOT / "apps" / "api"
ADMIN = os.environ.get("DASH_OPS_TEST_ADMIN")


def script(task):
    template, _ = decode(str(ROOT / "deploy" / "aws" / "templates" / "40-service.yaml"))
    (container,) = template["Resources"][task]["Properties"]["ContainerDefinitions"]
    return container["Command"][2]


def psql(sql, db="postgres"):
    conninfo = re.sub(r"dbname=\S+", f"dbname={db}", ADMIN)
    return subprocess.run(["psql", conninfo, "-v", "ON_ERROR_STOP=1", "-tAc", sql], check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipUnless(ADMIN, "set DASH_OPS_TEST_ADMIN (deploy/aws/tests/tls-postgres.sh) to run")
class OpsScripts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = os.environ["DASH_OPS_TEST_PGHOST"]
        cls.port = os.environ["DASH_OPS_TEST_PGPORT"]
        cls.ca = os.environ["DASH_OPS_TEST_CA"]
        cls.master_password = secrets.token_hex(16)
        cls.app_password = secrets.token_hex(32)
        cls.cleanup()
        # What RDS gives: a master user that is not a superuser, owning an empty dash_staging.
        psql(f"CREATE ROLE dash_master LOGIN CREATEROLE CREATEDB PASSWORD '{cls.master_password}'")
        psql("CREATE DATABASE dash_staging OWNER dash_master")

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    @staticmethod
    def cleanup():
        psql("DROP DATABASE IF EXISTS dash_staging")
        psql("DROP ROLE IF EXISTS dash_app")
        psql("DROP ROLE IF EXISTS dash_master")

    def run_task(self, task, app_url=None, trust_ca=True):
        # Exactly the variables ECS gives the container (plus the image's NODE_EXTRA_CA_CERTS).
        env = {"PATH": os.environ["PATH"], "DB_HOST": self.host, "DB_PORT": self.port, "DB_NAME": "dash_staging", "DB_USER": "dash_master", "DB_PASSWORD": self.master_password}
        if trust_ca:
            env["NODE_EXTRA_CA_CERTS"] = self.ca
        if app_url is not None:
            env["APP_DATABASE_URL"] = app_url
        done = subprocess.run(["node", "-e", script(task)], cwd=API, env=env, capture_output=True, text=True, timeout=60)
        lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
        self.assertEqual(len(lines), 1, done.stdout + done.stderr)
        return done.returncode, json.loads(lines[0])

    def app_url(self, user="dash_app", password=None, host=None, db="dash_staging", query=""):
        return f"postgres://{user}:{password or self.app_password}@{host or self.host}:{self.port}/{db}{query}"

    def test_full_sequence(self):
        # Phase 6 on a fresh database: classification input for B.
        code, out = self.run_task("DbClassifyTaskDefinition")
        self.assertEqual(code, 0, out)
        self.assertEqual((out["transactionReadOnly"], out["query"], out["sqlstate"]), ("on", "error", "42P01"))

        # Certificate verification is on: without the CA the connection is refused.
        code, out = self.run_task("DbClassifyTaskDefinition", trust_ca=False)
        self.assertEqual(code, 1)
        self.assertTrue(out["failed"])

        # Phase 8 guards: wrong host, sslmode, wrong user, weak password, wrong database.
        for url, problem in [
            (self.app_url(host="127.0.0.2"), "host is not this staging database"),
            (self.app_url(query="?sslmode=require"), "no query parameters"),
            (self.app_url(user="postgres"), "user must be dash_app"),
            (self.app_url(password="short"), "password must be 32+"),
            (self.app_url(db="postgres"), "database must be dash_staging"),
        ]:
            code, out = self.run_task("DbAppRoleTaskDefinition", url)
            self.assertEqual(code, 1, url)
            self.assertTrue(any(p.startswith(problem) for p in out["problems"]), out)
        self.assertEqual(psql("SELECT count(*) FROM pg_roles WHERE rolname = 'dash_app'"), "0")

        code, out = self.run_task("DbAppRoleTaskDefinition", self.app_url())
        self.assertEqual((code, out.get("created")), (0, "dash_app"), out)
        self.assertEqual(psql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'dash_staging'"), "dash_app")
        self.assertTrue(psql("SELECT rolpassword FROM pg_authid WHERE rolname = 'dash_app'").startswith("SCRAM-SHA-256$4096:"))
        self.assertNotIn(self.app_password, (Path(self.ca).parent / "server.log").read_text())

        code, out = self.run_task("DbAppRoleTaskDefinition", self.app_url())
        self.assertEqual(code, 1)
        self.assertIn("role dash_app already exists: STOP and report to the owner", out["problems"])

        # The real migrate-cli, as dash_app over verified TLS (the Phase 8 step after approval).
        env = {"PATH": os.environ["PATH"], "DATABASE_URL": self.app_url(), "DATABASE_SSL": "require", "NODE_EXTRA_CA_CERTS": self.ca}
        for expected in ("Applied ", "Database is up to date"):
            done = subprocess.run(["node", "dist/migrate-cli.js"], cwd=API, env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn(expected, done.stdout)

        # Phase 6 again after migration: the adopted 10+ prefix, read-only.
        code, out = self.run_task("DbClassifyTaskDefinition")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["transactionReadOnly"], "on")
        self.assertEqual(
            [(r["id"], r["name"]) for r in out["rows"]],
            [(10, "inference_ledger"), (11, "inference_ledger_integrity"), (12, "spend_reservations"), (13, "spend_reservation_attempts")],
        )


if __name__ == "__main__":
    unittest.main()
