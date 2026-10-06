import { z } from "zod";
import type { AssistantMode } from "./common.js";

/**
 * The prompt library both apps ship: categories, starter prompts and the rules for prompts people
 * write themselves. Mirrors apps/android core PromptLibrary.kt; fixtures/prompt-library.json is the
 * shared copy both test suites check, so the two apps cannot drift apart.
 *
 * Favourites and custom prompts are kept on each device (they are not synced by the API yet).
 */

export const PromptCategoryId = z.enum(["business", "writing", "marketing", "planning", "documents", "research", "productivity"]);
export type PromptCategoryId = z.infer<typeof PromptCategoryId>;

export interface PromptCategory {
  id: PromptCategoryId;
  label: string;
  /** The assistant mode a prompt of this category starts the chat in. */
  mode: AssistantMode;
}

export const PROMPT_CATEGORIES: readonly PromptCategory[] = [
  { id: "business", label: "Business", mode: "business" },
  { id: "writing", label: "Writing", mode: "writing" },
  { id: "marketing", label: "Marketing", mode: "writing" },
  { id: "planning", label: "Planning", mode: "business" },
  { id: "documents", label: "Documents", mode: "documents" },
  { id: "research", label: "Research", mode: "research" },
  { id: "productivity", label: "Personal productivity", mode: "general" },
];

export const PROMPT_LIMITS = { maxTitleChars: 80, maxBodyChars: 4000 } as const;

export interface PromptItem {
  id: string;
  title: string;
  body: string;
  category: PromptCategoryId;
  isCustom?: boolean;
  updatedAt?: number;
}

/** Starter prompts. Square brackets mark the parts to fill in. */
export const STARTER_PROMPTS: readonly PromptItem[] = [
  { id: "starter-biz-plan", category: "business", title: "One-page business plan",
    body: "Draft a one-page business plan for [business idea] in [city/market]. Include the customer, offer, pricing, channels, costs, risks and the first three milestones." },
  { id: "starter-biz-swot", category: "business", title: "SWOT analysis",
    body: "Create a SWOT analysis for [company or product]. Be specific, and end with the two most important actions." },
  { id: "starter-biz-pricing", category: "business", title: "Pricing strategy",
    body: "Suggest three pricing models for [product/service] aimed at [customer]. Compare them in a table with pros, cons and when to use each." },
  { id: "starter-biz-competitor", category: "business", title: "Competitor snapshot",
    body: "Help me structure a competitor comparison for [market]. Give me the criteria to compare and a table template I can fill in." },
  { id: "starter-biz-meeting", category: "business", title: "Board update outline",
    body: "Outline a concise board update covering results, key metrics, risks, decisions needed and next quarter's priorities for [company]." },
  { id: "starter-wr-email", category: "writing", title: "Professional email",
    body: "Write a clear, warm and professional email to [recipient] about [topic]. Keep it under 150 words and end with a specific next step." },
  { id: "starter-wr-rewrite", category: "writing", title: "Rewrite with confidence",
    body: "Rewrite the following text so it sounds confident, concise and friendly, without changing its meaning:\n\n[paste text]" },
  { id: "starter-wr-summary", category: "writing", title: "Executive summary",
    body: "Turn these notes into a polished executive summary with a headline, three key points and a recommendation:\n\n[paste notes]" },
  { id: "starter-wr-proofread", category: "writing", title: "Proofread and explain",
    body: "Proofread the text below. Show the corrected version, then list the most important changes and why:\n\n[paste text]" },
  { id: "starter-mk-launch", category: "marketing", title: "Launch announcement",
    body: "Write a launch announcement for [product] for [channel: LinkedIn/Instagram/email]. Give three variations with different hooks." },
  { id: "starter-mk-audience", category: "marketing", title: "Customer persona",
    body: "Create two customer personas for [product] in [market], including goals, frustrations, buying triggers and the message that would resonate." },
  { id: "starter-mk-campaign", category: "marketing", title: "Campaign ideas",
    body: "Suggest five low-budget marketing campaign ideas for [business] to reach [audience] in the next 30 days, with expected effort and impact." },
  { id: "starter-mk-slogans", category: "marketing", title: "Taglines",
    body: "Write ten short, premium-sounding taglines for [brand]. The brand values are [values]." },
  { id: "starter-pl-90day", category: "planning", title: "90-day plan",
    body: "Create a 90-day plan to achieve [goal]. Break it into monthly themes, weekly actions and measurable milestones." },
  { id: "starter-pl-project", category: "planning", title: "Project plan",
    body: "Build a project plan for [project] with phases, tasks, owners, dependencies and risks, formatted as a table." },
  { id: "starter-pl-event", category: "planning", title: "Event checklist",
    body: "Make a detailed checklist for organising [event] for [number] people on [date], grouped by timeline." },
  { id: "starter-pl-decision", category: "planning", title: "Decision matrix",
    body: "Help me decide between [option A] and [option B]. Build a weighted decision matrix and explain the result." },
  { id: "starter-doc-summary", category: "documents", title: "Summarise a document",
    body: "Summarise the attached document in five bullet points, then list any deadlines, amounts or obligations it mentions." },
  { id: "starter-doc-questions", category: "documents", title: "Key questions",
    body: "Read the attached document and list the ten most important questions someone should ask about it, with the answers where the document gives them." },
  { id: "starter-doc-reply", category: "documents", title: "Draft a reply",
    body: "Based on the attached letter, draft a polite, firm reply that addresses each point it raises." },
  { id: "starter-doc-compare", category: "documents", title: "Contract check",
    body: "Review the attached contract text and highlight clauses about payment, termination, liability and renewal. This is not legal advice." },
  { id: "starter-rs-overview", category: "research", title: "Topic overview",
    body: "Give me a structured overview of [topic]: key concepts, main players, current debates and what I should read next. Note anything that may be out of date." },
  { id: "starter-rs-compare", category: "research", title: "Compare approaches",
    body: "Compare [approach A], [approach B] and [approach C] for [goal] in a table covering cost, effort, risks and best use cases." },
  { id: "starter-rs-plan", category: "research", title: "Research plan",
    body: "Create a research plan to understand [question], including hypotheses, sources to check and how to verify the findings." },
  { id: "starter-rs-explain", category: "research", title: "Explain like I'm new",
    body: "Explain [complex topic] as if I'm new to it, then give an advanced summary for when I'm ready." },
  { id: "starter-pp-week", category: "productivity", title: "Plan my week",
    body: "Help me plan my week. My priorities are [priorities], my fixed commitments are [commitments]. Suggest a realistic daily schedule." },
  { id: "starter-pp-habits", category: "productivity", title: "Build a habit",
    body: "Design a simple 30-day plan to build the habit of [habit], with a tiny daily action and a way to track progress." },
  { id: "starter-pp-inbox", category: "productivity", title: "Inbox zero",
    body: "Give me a 20-minute daily routine to keep my email inbox under control, with rules for what to reply, delegate, schedule or archive." },
  { id: "starter-pp-learn", category: "productivity", title: "Learning plan",
    body: "Create a four-week learning plan for [skill] with 30 minutes a day, free resources and a small project to finish." },
];

export type PromptFilter = { kind: "all" } | { kind: "favorites" } | { kind: "mine" } | { kind: "category"; category: PromptCategoryId };

export const promptCategory = (id: PromptCategoryId): PromptCategory => PROMPT_CATEGORIES.find((c) => c.id === id)!;

/** Same order and matching rules as Android: favourites first, then category order, then title. */
export function filterPrompts(prompts: readonly PromptItem[], favorites: ReadonlySet<string>, filter: PromptFilter, query: string): PromptItem[] {
  const q = query.trim().toLowerCase();
  const order = (p: PromptItem) => PROMPT_CATEGORIES.findIndex((c) => c.id === p.category);
  return prompts
    .filter((p) => {
      switch (filter.kind) {
        case "all":
          return true;
        case "favorites":
          return favorites.has(p.id);
        case "mine":
          return p.isCustom === true;
        case "category":
          return p.category === filter.category;
      }
    })
    .filter((p) => !q || p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q) || promptCategory(p.category).label.toLowerCase().includes(q))
    .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)) || order(a) - order(b) || compareTitles(a.title, b.title));
}

/** Kotlin's String.compareTo: UTF-16 code unit order (not locale-aware). */
const compareTitles = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Validates a prompt someone wrote. Returns an error message, or null when valid. */
export function validatePrompt(title: string, body: string): string | null {
  if (!title.trim()) return "Give the prompt a title.";
  if (title.trim().length > PROMPT_LIMITS.maxTitleChars) return `Titles can be up to ${PROMPT_LIMITS.maxTitleChars} characters.`;
  if (!body.trim()) return "Write the prompt text.";
  if (body.trim().length > PROMPT_LIMITS.maxBodyChars) return "Prompts can be up to 4,000 characters.";
  return null;
}
