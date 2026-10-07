import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre>
      <button
        className="btn btn-text small"
        style={{ position: "absolute", right: 6, top: 6, minHeight: 32 }}
        onClick={() => {
          void navigator.clipboard?.writeText(textOf(children)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        aria-label="Copy code"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {children}
    </pre>
  );
}

/**
 * Renders an answer's Markdown (headings, lists, tables, code). Raw HTML in answers is never
 * rendered, and links open in a new tab without access to this page.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="answer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
