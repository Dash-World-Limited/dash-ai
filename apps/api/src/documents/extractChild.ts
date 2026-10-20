/**
 * Entry point of the document-extraction process started by isolate.ts. It runs with an empty
 * environment (no secrets to steal if a parser is exploited), reads one document from stdin and
 * writes one JSON result to stdout.
 */
import { writeFileSync } from "node:fs";
import { extractInProcess } from "./inspect.js";

try {
  // If memory runs short, the kernel should pick this process, never the API server.
  writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // Not Linux: the parent's memory watchdog still applies where it can.
}

// Never outlive the API server: if it dies (even SIGKILL), this process is re-parented; stop then.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(3);
}, 500).unref();

const kind = process.argv[2];
if (kind !== "pdf" && kind !== "docx") process.exit(2);

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const result = await extractInProcess(kind, Buffer.concat(chunks));
process.stdout.write(JSON.stringify(result), () => process.exit(0));
