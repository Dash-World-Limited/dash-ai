import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LIMITS } from "@dash-ai/contracts";
import { z } from "zod";
import { TOO_LARGE_DETAIL, type Extraction, type ExtractionReason } from "./inspect.js";

/** Default extraction processes running at once per instance (DOCUMENT_EXTRACTION_CONCURRENCY; see gate.ts). */
export const MAX_CONCURRENT_EXTRACTIONS = 2;
/** Resident memory at which an extraction process is stopped (checked every 100 ms on Linux). */
export const MAX_EXTRACTION_RSS_BYTES = 640 * 1024 * 1024;
const MAX_HEAP_MB = 384;

const here = fileURLToPath(import.meta.url);
const fromSource = here.endsWith(".ts");

/** The child entry point: compiled JS in production, TypeScript through tsx in development and tests. */
function childCommand(kind: "pdf" | "docx"): string[] {
  const entry = join(dirname(here), fromSource ? "extractChild.ts" : "extractChild.js");
  const loader = fromSource ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] : [];
  return [...loader, `--max-old-space-size=${MAX_HEAP_MB}`, entry, kind];
}

/**
 * The environment the extraction process gets: nothing. Database URLs, provider keys and the data
 * encryption key never reach the process that parses untrusted files.
 */
export function childEnvironment(): NodeJS.ProcessEnv {
  return {};
}

/** Extraction processes alive right now in this process (tests and load checks: none may leak). */
const children = new Set<ChildProcess>();
export const activeExtractionProcesses = (): number => children.size;

const ChildResult = z.object({
  status: z.enum(["ready", "unsupported"]),
  statusDetail: z.string().max(300),
  text: z.string().max(LIMITS.maxExtractedChars),
  pageCount: z.number().int().nonnegative().max(1_000_000).nullable(),
  reason: z.enum(["too_large", "encrypted", "unsupported_feature", "unreadable", "no_text", "timeout", "memory", "crashed", "image"]).optional(),
});

const failure = (statusDetail: string, reason: ExtractionReason): Extraction => ({ status: "unsupported", statusDetail, text: "", pageCount: null, reason });
const TIMED_OUT = "This file took too long to read and was skipped. Try a smaller file, or save it as plain text.";
const CRASHED = "This file could not be read safely.";

async function residentBytes(pid: number): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return kb ? Number(kb[1]) * 1024 : undefined;
  } catch {
    return undefined; // not Linux, or the process already exited
  }
}

/**
 * The caller abandoned the extraction (the client disconnected, or shutdown stopped the request).
 * Not a verdict on the file: the upload ends without a document being saved.
 */
export class ExtractionAborted extends Error {
  constructor() {
    super("extraction aborted");
  }
}

/**
 * Parses a PDF or DOCX in a separate Node process with an empty environment, a heap cap, a
 * resident-memory watchdog, a wall-clock limit and a raised OOM score (the kernel kills it before
 * this server). Whatever happens inside, the server gets back a bounded, validated result. If
 * `signal` aborts, the process is killed and the promise rejects with ExtractionAborted.
 */
export async function extractIsolated(kind: "pdf" | "docx", buf: Buffer, timeoutMs: number, signal?: AbortSignal): Promise<Extraction> {
  return new Promise<Extraction>((resolve, reject) => {
      const child = spawn(process.execPath, childCommand(kind), {
        env: childEnvironment(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      children.add(child);
      const maxOutput = LIMITS.maxExtractedChars * 8 + 64 * 1024;
      const out: Buffer[] = [];
      let outBytes = 0;
      let verdict: Extraction | "aborted" | undefined;
      const stop = (result: Extraction | "aborted") => {
        verdict ??= result;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop(failure(TIMED_OUT, "timeout")), timeoutMs);
      // The client went away or the server is stopping: nobody will read the result.
      const onAbort = () => stop("aborted");
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const watchdog = setInterval(() => {
        if (child.pid === undefined) return;
        void residentBytes(child.pid).then((rss) => {
          if (rss !== undefined && rss > MAX_EXTRACTION_RSS_BYTES) stop(failure(TOO_LARGE_DETAIL, "memory"));
        });
      }, 100);
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxOutput) stop(failure(CRASHED, "crashed"));
        else out.push(chunk);
      });
      child.stdin.on("error", () => undefined); // the child may exit before reading everything
      child.on("error", () => stop(failure(CRASHED, "crashed")));
      child.on("close", (code) => {
        children.delete(child);
        clearTimeout(timer);
        clearInterval(watchdog);
        signal?.removeEventListener("abort", onAbort);
        if (verdict === "aborted") return reject(new ExtractionAborted());
        if (verdict) return resolve(verdict);
        if (code !== 0) return resolve(failure(CRASHED, "crashed"));
        try {
          const parsed = ChildResult.safeParse(JSON.parse(Buffer.concat(out).toString("utf8")));
          resolve(parsed.success ? parsed.data : failure(CRASHED, "crashed"));
        } catch {
          resolve(failure(CRASHED, "crashed"));
        }
      });
      child.stdin.end(buf);
  });
}
