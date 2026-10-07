import { PROMPT_CATEGORIES, PROMPT_LIMITS, filterPrompts, promptCategory, type PromptCategoryId, type PromptFilter, type PromptItem } from "@dash-ai/contracts";
import { useMemo, useState } from "react";
import { useApp } from "../state/app";
import { useStore } from "../state/store";
import { Icon } from "../ui/icons";
import { Confirm, Dialog, Empty } from "../ui/kit";
import { TopBar } from "./Shell";

const FILTERS: { key: string; label: string; filter: PromptFilter }[] = [
  { key: "all", label: "All", filter: { kind: "all" } },
  { key: "favorites", label: "Favourites", filter: { kind: "favorites" } },
  { key: "mine", label: "My prompts", filter: { kind: "mine" } },
  ...PROMPT_CATEGORIES.map((c) => ({ key: c.id, label: c.label, filter: { kind: "category", category: c.id } as PromptFilter })),
];

interface Editing {
  id?: string;
  title: string;
  body: string;
  category: PromptCategoryId;
}

/** The prompt library: the same starters, filters and rules as on Android. */
export function PromptsScreen() {
  const app = useApp();
  const data = useStore(app.prompts.state);
  const [filterKey, setFilterKey] = useState("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<PromptItem | null>(null);
  const favorites = useMemo(() => new Set(data.favorites), [data.favorites]);
  const filter = FILTERS.find((f) => f.key === filterKey)!.filter;
  const visible = useMemo(() => filterPrompts(app.prompts.all(), favorites, filter, query), [app, data, favorites, filter, query]);

  return (
    <>
      <TopBar
        title="Prompt library"
        actions={
          <button className="btn btn-primary" style={{ minHeight: 40, padding: "0 16px" }} onClick={() => setEditing({ title: "", body: "", category: "productivity" })} data-testid="new-prompt">
            <Icon name="plus" size={18} /> New prompt
          </button>
        }
      />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="prompt-library">
          <input className="input" type="search" placeholder="Search prompts" aria-label="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="prompt-search" />
          <div className="row chip-row" role="group" aria-label="Filter prompts">
            {FILTERS.map((f) => (
              <button key={f.key} className={`chip-btn${filterKey === f.key ? " accent" : ""}`} aria-pressed={filterKey === f.key} onClick={() => setFilterKey(f.key)} style={{ paddingRight: 12 }}>
                {f.label}
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            filter.kind === "favorites" && !query.trim() ? (
              <Empty icon="star" title="No favourites yet" testId="prompts-empty">Select the star on a prompt to keep it here.</Empty>
            ) : (
              <Empty icon="search" title="No prompts found" testId="prompts-empty">Try another search or create your own prompt.</Empty>
            )
          ) : (
            visible.map((p) => (
              <PromptCard
                key={p.id}
                prompt={p}
                favorite={favorites.has(p.id)}
                onFavorite={() => app.prompts.toggleFavorite(p.id)}
                onUse={() => app.usePrompt(p)}
                onEdit={() => setEditing({ id: p.id, title: p.title, body: p.body, category: p.category })}
                onDelete={() => setDeleting(p)}
              />
            ))
          )}
        </main>
      </div>
      {editing && <PromptEditor initial={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <Confirm
          title="Delete prompt?"
          text={`“${deleting.title}” will be deleted.`}
          confirm="Delete"
          destructive
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            app.prompts.remove(deleting.id);
            setDeleting(null);
            app.notify("Prompt deleted");
          }}
        />
      )}
    </>
  );
}

function PromptCard({
  prompt,
  favorite,
  onFavorite,
  onUse,
  onEdit,
  onDelete,
}: {
  prompt: PromptItem;
  favorite: boolean;
  onFavorite: () => void;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const category = promptCategory(prompt.category).label;
  return (
    <article className="card card-pad stack" style={{ gap: 8 }} data-testid="prompt-card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{prompt.title}</h3>
          <span className="small faint">{prompt.isCustom ? `${category} · My prompt` : category}</span>
        </div>
        <button
          className="icon-btn"
          onClick={onFavorite}
          aria-pressed={favorite}
          aria-label={favorite ? `Remove “${prompt.title}” from favourites` : `Add “${prompt.title}” to favourites`}
          style={{ color: favorite ? "var(--accent-ink)" : "var(--ink-3)" }}
          data-testid="prompt-favorite"
        >
          <Icon name="star" filled={favorite} />
        </button>
      </div>
      <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {prompt.body}
      </p>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn btn-text" onClick={onUse} data-testid="use-prompt">
          Use prompt
        </button>
        <span className="grow" />
        {prompt.isCustom && (
          <>
            <button className="icon-btn" onClick={onEdit} aria-label={`Edit “${prompt.title}”`} data-testid="edit-prompt">
              <Icon name="edit" size={18} />
            </button>
            <button className="icon-btn" onClick={onDelete} aria-label={`Delete “${prompt.title}”`} data-testid="delete-prompt">
              <Icon name="trash" size={18} />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function PromptEditor({ initial, onClose }: { initial: Editing; onClose: () => void }) {
  const app = useApp();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<Editing>) => {
    setValue((v) => ({ ...v, ...patch }));
    setError(null);
  };
  return (
    <Dialog title={initial.id ? "Edit prompt" : "New prompt"} onClose={onClose} testId="prompt-editor">
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          const problem = app.prompts.save(value);
          if (problem) return setError(problem);
          onClose();
          app.notify(initial.id ? "Prompt saved" : "Prompt added to My prompts");
        }}
      >
        <div className="field">
          <label htmlFor="prompt-title">Title</label>
          <input id="prompt-title" className="input" value={value.title} maxLength={PROMPT_LIMITS.maxTitleChars + 20} onChange={(e) => change({ title: e.target.value })} data-testid="prompt-title-input" />
        </div>
        <div className="field">
          <label htmlFor="prompt-category">Category</label>
          <select id="prompt-category" className="input" value={value.category} onChange={(e) => change({ category: e.target.value as PromptCategoryId })} data-testid="prompt-category">
            {PROMPT_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="prompt-body">Prompt</label>
          <textarea id="prompt-body" className="input" rows={6} value={value.body} onChange={(e) => change({ body: e.target.value })} aria-describedby="prompt-hint" data-testid="prompt-body-input" />
          <span id="prompt-hint" className="hint">Use [square brackets] for the parts to fill in each time.</span>
        </div>
        {error && (
          <p className="small" role="alert" style={{ color: "var(--error)", margin: 0 }} data-testid="prompt-error">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn btn-text" style={{ color: "var(--ink-2)" }} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" data-testid="save-prompt">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
