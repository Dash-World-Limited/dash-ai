import type { FastifyServerOptions } from "fastify";

/** Any writable sink for newline-delimited JSON log lines (pino destination compatible). */
export interface LogStream {
  write(msg: string): void;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g,
  /dash_[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(api[_-]?key|authorization|password|token)(["'\s:=]+)[^\s"',}]{4,}/gi,
];

/** Masks credentials that might appear in error messages before anything is logged. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, label?: string, sep?: string) =>
      typeof label === "string" && typeof sep === "string" ? `${label}${sep}[redacted]` : "[redacted]",
    );
  }
  return out;
}

/** Drops query strings: they could contain search terms or tokens. */
export function sanitizeUrl(url: string | undefined): string {
  if (!url) return "";
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}

/**
 * Privacy-safe logger options. Request and response bodies are never logged, headers are not
 * logged, query strings are stripped and error messages are passed through redactSecrets.
 * Code must never log prompt text, document text or model output (see docs/security.md).
 */
export function loggerOptions(level: string, stream?: LogStream): FastifyServerOptions["logger"] {
  return {
    level,
    ...(stream ? { stream } : {}),
    redact: {
      paths: ["req.headers", "res.headers", "headers", "body", "prompt", "content", "password", "token"],
      censor: "[redacted]",
    },
    serializers: {
      req(req: { method?: string; url?: string; id?: string }) {
        return { method: req.method, url: sanitizeUrl(req.url), reqId: req.id };
      },
      res(res: { statusCode?: number }) {
        return { statusCode: res.statusCode };
      },
      err(err: Error & { code?: unknown; statusCode?: unknown }) {
        return {
          type: err.name,
          code: typeof err.code === "string" ? err.code : undefined,
          statusCode: typeof err.statusCode === "number" ? err.statusCode : undefined,
          message: redactSecrets(String(err.message ?? "")).slice(0, 300),
          // Stack frames only: the first stack line repeats the message, which is already redacted above.
          stack: (err.stack ?? "").split("\n").slice(1, 8).join("\n"),
        };
      },
    },
  };
}
