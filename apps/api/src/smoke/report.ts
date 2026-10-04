import { ProviderError } from "../providers/types.js";

export interface CheckResult {
  provider: string;
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  ms: number;
}

/** A user-safe description of a failure. Raw error text is never printed (it can carry request details). */
export function describeFailure(err: unknown): string {
  if (err instanceof CheckFailure) return err.message;
  if (err instanceof ProviderError) {
    return `${err.code}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ""}: ${err.message}`;
  }
  return `unexpected error (${err instanceof Error ? err.name : "unknown"})`;
}

/** An assertion failure with a message that is safe to print. */
export class CheckFailure extends Error {}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

/** Runs one check, timing it and turning any failure into a result instead of an exception. */
export async function timed(provider: string, name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { provider, name, status: "pass", detail, ms: Date.now() - started };
  } catch (err) {
    return { provider, name, status: "fail", detail: describeFailure(err), ms: Date.now() - started };
  }
}

export const skipped = (provider: string, name: string, detail: string): CheckResult => ({ provider, name, status: "skip", detail, ms: 0 });

/** Replaces every occurrence of each secret, so nothing printed can contain one. */
export function makeRedactor(secrets: ReadonlyArray<string | undefined>): (text: string) => string {
  const real = secrets.filter((s): s is string => typeof s === "string" && s.length >= 8);
  return (text) => real.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

export function formatResult(r: CheckResult): string {
  const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
  return `${tag}  ${r.provider.padEnd(9)} ${r.name.padEnd(22)} ${String(r.ms).padStart(6)} ms  ${r.detail}`;
}
