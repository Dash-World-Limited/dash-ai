# Security policy

DASH AI's source code is public. Its credentials, production configuration and data are not, and
nothing in this repository is a working credential (CI scans every commit for secrets).

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: on this repository's **Security** tab, choose **Report a
vulnerability** (GitHub private vulnerability reporting). Include what you found, where (file, endpoint
or workflow), how to reproduce it, and what an attacker could do with it. Do not include real personal
data or credentials; if you came across any, say so and describe where, without copying them.

We will acknowledge the report, keep you informed while we investigate, and credit you when a fix is
published unless you prefer otherwise. Please give us a reasonable time to fix the problem before
disclosing it.

## Scope

In scope: the API server (`apps/api`), the web app (`apps/web`), the Android app (`apps/android`), the
shared contracts (`packages/`), the GitHub Actions workflows and the deployment templates in this
repository.

Out of scope: denial of service by traffic volume, findings that require a compromised server or a
compromised device, and third-party services DASH AI connects to (report those to their owners).

## Please do not

- Access, change or delete data that is not yours, or keep any you come across.
- Run tests that send traffic to paid AI providers through someone else's deployment.
- Use social engineering or physical attacks.

How DASH AI protects credentials and data is described in [docs/security.md](docs/security.md).
