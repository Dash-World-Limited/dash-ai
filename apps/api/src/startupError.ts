import { scrubErrorMessage } from "./logging.js";

/** Never prints the connection string (it usually holds a password) or quoted driver detail. */
export function startupErrorText(err: unknown, databaseUrl: string | undefined): string {
  let text = err instanceof Error ? err.message : "unknown error";
  if (databaseUrl) text = text.split(databaseUrl).join("[DATABASE_URL]");
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credentials]@");
  return scrubErrorMessage(text).slice(0, 300);
}
