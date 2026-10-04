#!/usr/bin/env node
// Secret-scanning safeguard for tracked files (runs locally and in CI alongside gitleaks).
// Fails if a tracked file contains a credential-shaped string, if a real .env file is tracked,
// if .env.example contains a value for a key, or if Android code references an AI provider API.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["Anthropic API key", /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{60,}/],
  ["OpenAI API key", /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/],
  ["OpenAI legacy key", /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  // Connection strings with an inline password (user:password@host). Placeholders are allowed.
  ["Database URL with password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@'"]+:(?!(?:password|pass|secret|changeme|placeholder|xxxx*|\*+|<[^>]*>|\$\{?[A-Za-z_]+\}?)(?:@|$))[^\s@'"]{3,}@/i],
  ["Private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/],
];

// The Android app must only talk to the Dash AI API, never to a provider directly.
const PROVIDER_HOSTS = /\b(?:api\.openai\.com|api\.anthropic\.com)\b/;

const BINARY = /\.(png|jpe?g|webp|gif|ico|jar|zip|apk|aab|pdf|docx|keystore|jks|ttf|otf|woff2?)$/i;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];

for (const file of files) {
  const base = file.split("/").pop() ?? file;
  if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") {
    problems.push(`${file}: environment files must never be committed`);
    continue;
  }
  if (BINARY.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, pattern] of PATTERNS) {
      if (pattern.test(line)) problems.push(`${file}:${i + 1}: possible ${name}`);
    }
    if (file.startsWith("apps/android/") && PROVIDER_HOSTS.test(line)) {
      problems.push(`${file}:${i + 1}: Android code must not reference an AI provider API directly`);
    }
    if (base === ".env.example") {
      const m = /^\s*([A-Z0-9_]*(?:API_KEY|ENCRYPTION_KEY|PREVIOUS_KEYS|SECRET|TOKEN|PASSWORD|DATABASE_URL))\s*=\s*(\S+)/.exec(line);
      if (m) problems.push(`${file}:${i + 1}: ${m[1]} must be empty in .env.example`);
    }
  });
}

if (problems.length > 0) {
  process.stderr.write(`Secret scan failed:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Secret scan passed (${files.length} tracked files checked).\n`);
