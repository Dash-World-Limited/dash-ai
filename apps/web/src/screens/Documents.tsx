import { FILE_RULES } from "@dash-ai/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { DOCUMENT_SUGGESTIONS, formatSize, KIND_LABEL } from "../logic/presentation";
import { useApp } from "../state/app";
import { documentStatus, usableInChat, type DocItem } from "../state/documents";
import { navigate, useRoute } from "../state/router";
import { useStore } from "../state/store";
import { Icon, type IconName } from "../ui/icons";
import { Badge, Confirm, Empty, Loading, Notice } from "../ui/kit";
import { TopBar } from "./Shell";

const KIND_ICON: Record<DocItem["kind"], IconName> = { pdf: "pdf", docx: "doc", txt: "doc", image: "image" };
const ACCEPT = FILE_RULES.flatMap((r) => r.extensions.map((e) => `.${e}`)).join(",");

function useDocuments() {
  const app = useApp();
  const state = useStore(app.documents.state);
  useEffect(() => {
    if (!state.loaded && !state.loading) void app.documents.refresh();
  }, [app, state.loaded, state.loading]);
  return state;
}

export function DocumentsScreen() {
  const app = useApp();
  const settings = useStore(app.settings);
  const { items, loading, error, loaded } = useDocuments();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | DocItem["kind"]>("all");
  const [uploads, setUploads] = useState<{ id: string; name: string; progress: number; error: string | null }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const kinds = [...new Set(items.map((d) => d.kind))];
  const effective = filter !== "all" && !kinds.includes(filter) ? "all" : filter;
  const visible = items.filter((d) => (effective === "all" || d.kind === effective) && d.name.toLowerCase().includes(query.trim().toLowerCase()));

  const upload = async (file: File) => {
    const id = crypto.randomUUID();
    setUploads((u) => [...u, { id, name: file.name, progress: 0, error: null }]);
    try {
      const doc = await app.documents.upload(file, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))));
      setUploads((u) => u.filter((x) => x.id !== id));
      app.notify(doc.status === "unsupported" ? `“${doc.name}” was added but can't be read: ${doc.statusDetail}` : `“${doc.name}” is ready`);
    } catch (e) {
      setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: e instanceof ApiError ? e.message : "The file could not be uploaded." } : x)));
    }
  };

  return (
    <>
      <TopBar
        title="Documents"
        actions={
          <button className="btn btn-primary" style={{ minHeight: 40, padding: "0 16px" }} onClick={() => input.current?.click()} data-testid="add-document">
            <Icon name="plus" size={18} /> Add document
          </button>
        }
      />
      <input ref={input} type="file" hidden accept={ACCEPT} data-testid="document-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="documents">
          <p className="muted" style={{ margin: 0 }}>
            {settings.demoMode ? "Demo Mode checks files in this browser only. Their contents are not uploaded or read." : "PDF (with text), Word and text files are read by the DASH AI server so you can ask about them."}
          </p>
          {items.length > 0 && (
            <input className="input" placeholder="Search documents" aria-label="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {kinds.length > 1 && (
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }} role="group" aria-label="Filter by type">
              {(["all", ...kinds] as const).map((k) => (
                <button key={k} className={`chip-btn${effective === k ? " accent" : ""}`} aria-pressed={effective === k} onClick={() => setFilter(k)} style={{ paddingRight: 12 }}>
                  {k === "all" ? "All" : KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          {uploads.map((u) => (
            <div key={u.id} className="card card-pad row" data-testid="upload-row">
              {u.error ? <Icon name="warning" /> : <span className="spinner" style={{ color: "var(--accent)" }} />}
              <div className="grow">
                <strong className="ellipsis" style={{ display: "block" }}>{u.name}</strong>
                <span className="small" style={{ color: u.error ? "var(--error)" : "var(--ink-2)" }}>{u.error ?? `Uploading ${Math.round(u.progress * 100)}%`}</span>
              </div>
              {u.error && <button className="btn btn-text" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>Dismiss</button>}
            </div>
          ))}
          {error && <Notice tone="error" action={{ label: "Retry", onClick: () => void app.documents.refresh() }}>{error}</Notice>}
          {!loaded || (loading && items.length === 0) ? (
            <Loading label="Loading documents…" />
          ) : items.length === 0 && uploads.length === 0 ? (
            <Empty icon="folder" title="No documents yet" testId="documents-empty" action={<button className="btn btn-primary" onClick={() => input.current?.click()}><Icon name="plus" size={18} /> Add document</button>}>
              Add a PDF, Word or text file, then ask DASH AI about it.
            </Empty>
          ) : visible.length === 0 ? (
            <p className="muted">No documents match.</p>
          ) : (
            visible.map((d) => {
              const status = documentStatus(d);
              return (
                <button key={d.id} className="card card-pad card-button row" onClick={() => navigate(`/documents/${d.id}`)} data-testid="document-row">
                  <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--surface-muted)", display: "grid", placeItems: "center", color: "var(--accent-ink)", flex: "none" }}>
                    <Icon name={KIND_ICON[d.kind]} />
                  </span>
                  <span className="grow">
                    <strong className="ellipsis" style={{ display: "block" }}>{d.name}</strong>
                    <span className="small faint">{KIND_LABEL[d.kind]} · {formatSize(d.sizeBytes)} · {new Date(d.createdAt).toLocaleDateString()}</span>
                  </span>
                  <Badge text={status.text} tone={status.tone} />
                </button>
              );
            })
          )}
        </main>
      </div>
    </>
  );
}

export function DocumentDetail() {
  const app = useApp();
  const settings = useStore(app.settings);
  const { items, loaded } = useDocuments();
  const { parts } = useRoute();
  const doc = items.find((d) => d.id === parts[1]);
  const [deleting, setDeleting] = useState(false);
  if (!loaded) return (<><TopBar back title="Document" /><Loading label="Loading document…" /></>);
  if (!doc) return (<><TopBar back title="Document" /><Empty icon="folder" title="Document not found">It may have been removed.</Empty></>);
  const status = documentStatus(doc);
  const usable = usableInChat(doc, settings.demoMode);
  const meta: [string, string][] = [
    ["Type", KIND_LABEL[doc.kind]],
    ["Size", formatSize(doc.sizeBytes)],
    ["Added", new Date(doc.createdAt).toLocaleString()],
    ...(doc.pageCount ? ([["Pages", String(doc.pageCount)]] as [string, string][]) : []),
    ...(doc.extractedChars > 0 ? ([["Text extracted", `${doc.extractedChars.toLocaleString()} characters`]] as [string, string][]) : []),
    ["Stored", doc.demo ? "In this browser only" : "On the DASH AI server"],
  ];
  return (
    <>
      <TopBar back title={doc.name} actions={<button className="icon-btn" onClick={() => setDeleting(true)} aria-label="Remove document"><Icon name="trash" /></button>} />
      <div className="content">
        <main className="reading stack" style={{ paddingBottom: 48 }} data-testid="document-detail">
          <div className="row" style={{ gap: 16 }}>
            <span style={{ width: 52, height: 52, borderRadius: 14, background: "var(--surface-muted)", display: "grid", placeItems: "center", color: "var(--accent-ink)", flex: "none" }}>
              <Icon name={KIND_ICON[doc.kind]} size={24} />
            </span>
            <div className="grow">
              <h2 style={{ margin: 0, fontSize: 20, overflowWrap: "anywhere" }}>{doc.name}</h2>
              <div style={{ marginTop: 6 }}><Badge text={status.text} tone={status.tone} /></div>
            </div>
          </div>
          <Notice tone={doc.status === "ready" ? "success" : doc.status === "unsupported" ? "warning" : "neutral"}>{doc.statusDetail}</Notice>
          <h3 className="section-title">Details</h3>
          <div className="card card-pad">
            {meta.map(([k, v]) => (
              <div key={k} className="row" style={{ minHeight: 36 }}>
                <span className="grow muted">{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
          <button className="btn btn-primary btn-block" disabled={!usable} onClick={() => app.askAbout(doc)} data-testid="ask-document" style={{ marginTop: 16 }}>
            Ask about this document
          </button>
          {!usable ? (
            <p className="small faint">{settings.demoMode && !doc.demo ? "This document belongs to your account. Sign in to use it." : "DASH AI can't read this document, so it can't be used in a chat."}</p>
          ) : (
            <>
              <h3 className="section-title">Suggestions</h3>
              {DOCUMENT_SUGGESTIONS.map((s) => (
                <button key={s} className="btn btn-secondary btn-block" onClick={() => app.askAbout(doc, s)} data-testid="document-suggestion">
                  {s}
                </button>
              ))}
              <p className="small faint">Suggestions open a chat with the text ready; nothing is sent until you press send.</p>
            </>
          )}
        </main>
      </div>
      {deleting && (
        <Confirm
          title="Remove this document?"
          text={doc.demo ? `“${doc.name}” will be removed from this browser.` : `“${doc.name}” will be removed from the DASH AI server.`}
          confirm="Remove"
          destructive
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void app.documents.remove(doc).then(
              () => (app.notify("Document removed"), navigate("/documents", true)),
              (e: unknown) => app.notify(e instanceof ApiError ? e.message : "Couldn't remove the document."),
            );
          }}
        />
      )}
    </>
  );
}
