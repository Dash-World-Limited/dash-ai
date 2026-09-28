export const DEFAULT_TITLE = "New chat";
const MAX_TITLE = 48;

/**
 * Local, provider-free conversation title from the first user message. No prompt is sent to a
 * provider just to name a chat. The Android client implements the same algorithm; both are checked
 * against packages/contracts/fixtures/titles.json.
 */
export function generateTitle(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  const lines = withoutCode.split("\n").map(cleanLine).filter((l) => l.length > 0);
  let title = lines[0] ?? "";
  if (title === "") return DEFAULT_TITLE;

  const end = title.search(/[.!?](?:\s|$)/);
  if (end > 0) title = title.slice(0, end);
  title = stripTrailingPunctuation(title.trim());

  if (title.length > MAX_TITLE) {
    const cut = title.lastIndexOf(" ", MAX_TITLE);
    title = stripTrailingPunctuation((cut >= 20 ? title.slice(0, cut) : title.slice(0, MAX_TITLE)).trim()) + "…";
  }
  if (title === "" || title === "…") return DEFAULT_TITLE;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function cleanLine(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_`>~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[-+]|\d+[.)])\s+/, "");
}

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[\s.,;:!?-]+$/, "");
}
