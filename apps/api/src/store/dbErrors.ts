/**
 * Recognises the database being unavailable or overloaded, as opposed to a bug: the pool could not
 * hand out a connection in time, the connection failed or was cut (server restart, network), or a
 * statement ran into statement_timeout. Such requests are answered as busy (503, retryable) rather
 * than "something went wrong", and counted by kind.
 */
export type DatabaseFailure = "pool_timeout" | "connection" | "statement_timeout";

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

export function databaseFailure(err: unknown): DatabaseFailure | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  const message = err.message;
  if (/timeout exceeded when trying to connect/i.test(message)) return "pool_timeout";
  if (code === "57014") return "statement_timeout";
  if (typeof code === "string") {
    // 08xxx connection exceptions, 57P01-57P03 admin/crash shutdown or cannot connect now, 53300 too many connections.
    if (code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03" || code === "53300") return "connection";
    if (CONNECTION_CODES.has(code)) return "connection";
  }
  if (/Connection terminated|connection error|Client has encountered a connection error|Client was closed/i.test(message)) return "connection";
  return null;
}
