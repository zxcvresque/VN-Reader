import CustomSelect from "./CustomSelect";
import { useMemo, useState, type FormEvent } from "react";
import type { MessageRecord } from "../types";
import { moveItem, type ReadingCollection, type ReadingState, type ReadingStatus } from "../lib/readingState";

interface ReadingLibraryProps {
  idPrefix?: string;
  savedPostKeys?: string[];
  initialTab?: Tab;
  state: ReadingState;
  onChange: (state: ReadingState) => void;
  messages: MessageRecord[];
  onOpenMessage: (key: string) => void;
  onReadAround: (key: string) => void;
}

type Tab = "queue" | "collections" | "work";
const tabs: Array<{ key: Tab; label: string }> = [{ key: "queue", label: "Read later" }, { key: "collections", label: "Collections" }, { key: "work", label: "My work" }];

function preview(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean || "Media post";
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function NoteEditor({ value, label, onSave }: { value: string; label: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  return <form className="library-note-editor" onSubmit={(event) => { event.preventDefault(); onSave(draft.trim()); }}>
    <label className="library-field"><span>{label}</span><textarea rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
    <button type="submit" className="btn-ghost" disabled={draft.trim() === value}>Save note</button>
  </form>;
}

export default function ReadingLibrary({ idPrefix = "", savedPostKeys = [], initialTab = "queue", state, onChange, messages, onOpenMessage, onReadAround }: ReadingLibraryProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; title: string; introduction: string } | null>(null);
  const [postQuery, setPostQuery] = useState("");
  const [postKey, setPostKey] = useState("");
  const [savedItem, setSavedItem] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const messageMap = useMemo(() => new Map(messages.map((message) => [message.message_key, message])), [messages]);
  const passageMap = useMemo(() => new Map(state.passages.map((passage) => [passage.id, passage])), [state.passages]);
  const collection = state.collections.find((item) => item.id === selectedCollection) ?? state.collections[0];
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (...text: string[]) => !normalized || text.some((value) => value.toLocaleLowerCase().includes(normalized));
  const availablePosts = useMemo(() => {
    const search = postQuery.trim().toLocaleLowerCase();
    return messages.filter((message) => !search || `${message.message_id} ${message.text}`.toLocaleLowerCase().includes(search)).slice(0, 100);
  }, [messages, postQuery]);

  function setStatus(messageKey: string, status: string) {
    const statuses = { ...state.statuses };
    if (status) statuses[messageKey] = status as ReadingStatus;
    else delete statuses[messageKey];
    onChange({ ...state, statuses, queue: status === "finished" ? state.queue.filter((key) => key !== messageKey) : state.queue });
  }

  function updateCollection(next: ReadingCollection) {
    onChange({ ...state, collections: state.collections.map((item) => item.id === next.id ? next : item) });
  }

  function saveCollection(event: FormEvent) {
    event.preventDefault();
    if (!editor?.title.trim()) return;
    const next: ReadingCollection = {
      id: editor.id ?? id(), title: editor.title.trim(), introduction: editor.introduction.trim(),
      items: state.collections.find((item) => item.id === editor.id)?.items ?? []
    };
    onChange({ ...state, collections: editor.id ? state.collections.map((item) => item.id === editor.id ? next : item) : [...state.collections, next] });
    setSelectedCollection(next.id);
    setEditor(null);
  }

  function removePassage(target: string) {
    onChange({ ...state, passages: state.passages.filter((item) => item.id !== target), collections: state.collections.map((item) => ({ ...item, items: item.items.filter((entry) => entry.passageId !== target) })) });
    setConfirmDelete(null);
  }

  function postActions(key: string) {
    const exists = messageMap.has(key);
    return <div className="library-actions">
      <button type="button" className="btn-ghost" disabled={!exists} onClick={() => onOpenMessage(key)}>Open post</button>
      <button type="button" className="btn-ghost" disabled={!exists} onClick={() => onReadAround(key)}>Read around this</button>
    </div>;
  }

  function postPreview(key: string) {
    const message = messageMap.get(key);
    return <><span className="library-post-id">Post #{message?.message_id ?? key.split(":").pop()}</span><p className="library-preview">{message ? preview(message.text || message.quote_text || "") : "This post is not in the current archive. Its saved reading data is retained."}</p></>;
  }

  const matchingNotes = Object.entries(state.notes).filter(([key, note]) => note.trim() && matches(note, key));
  const matchingPassages = state.passages.filter((passage) => matches(passage.text, passage.note, passage.messageKey));
  const matchingCollections = state.collections.filter((item) => matches(item.title, item.introduction));

  return <section className="reading-library" aria-label="Personal reading library">
    <div className="library-header"><div><p className="eyebrow">Your reading space</p><h2>Library</h2><p>Keep what matters. Come back with context.</p></div></div>
    <div className="library-tabs" role="tablist" aria-label="Library sections">
      {tabs.map((item, index) => <button key={item.key} id={`${idPrefix}library-tab-${item.key}`} type="button" role="tab" aria-selected={tab === item.key} aria-controls={`${idPrefix}library-panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} className={`btn-ghost ${tab === item.key ? "is-active" : ""}`} onClick={() => setTab(item.key)} onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        setTab(tabs[next].key);
        document.getElementById(`${idPrefix}library-tab-${tabs[next].key}`)?.focus();
      }}>{item.label}<span className="library-count"> {item.key === "queue" ? state.queue.length : item.key === "collections" ? state.collections.length : state.passages.length + Object.values(state.notes).filter((note) => note.trim()).length}</span></button>)}
    </div>

    {tab === "queue" && <div id={`${idPrefix}library-panel-queue`} role="tabpanel" aria-labelledby={`${idPrefix}library-tab-queue`} className="library-panel">
      <p className="library-hint">A little space for your next read. Use ↑ and ↓ to choose your order.</p>
      {!state.queue.length && <p className="library-empty">Your queue is clear. Choose “Read later” on any post to save it here.</p>}
      <ol className="library-list">{state.queue.map((key, index) => <li className="library-card" key={key}>
        {postPreview(key)}
        <label className="library-field"><span>Reading state</span><CustomSelect value={state.statuses[key] ?? ""} onChange={(event) => setStatus(key, event.target.value)}><option value="">Not started</option><option value="in-progress">In progress</option><option value="finished">Finished</option><option value="revisit">Revisit</option></CustomSelect></label>
        {postActions(key)}
        <div className="library-actions"><button type="button" className="btn-ghost" aria-label={`Move post ${key.split(":").pop()} earlier`} disabled={index === 0} onClick={() => onChange({ ...state, queue: moveItem(state.queue, index, index - 1) })}>↑ Earlier</button><button type="button" className="btn-ghost" aria-label={`Move post ${key.split(":").pop()} later`} disabled={index === state.queue.length - 1} onClick={() => onChange({ ...state, queue: moveItem(state.queue, index, index + 1) })}>↓ Later</button><button type="button" className="btn-ghost" onClick={() => onChange({ ...state, queue: state.queue.filter((entry) => entry !== key) })}>Remove from queue</button></div>
      </li>)}</ol>
    </div>}

    {tab === "collections" && <div id={`${idPrefix}library-panel-collections`} role="tabpanel" aria-labelledby={`${idPrefix}library-tab-collections`} className="library-panel">
      <button type="button" className="btn" onClick={() => setEditor({ id: null, title: "", introduction: "" })}>+ New collection</button>
      {editor && <form className="collection-editor library-card" onSubmit={saveCollection}>
        <h3>{editor.id ? "Edit collection" : "Create a collection"}</h3>
        <label className="library-field"><span>Name</span><input autoFocus required maxLength={200} value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} placeholder="Ideas to return to" /></label>
        <label className="library-field"><span>Introduction (optional)</span><textarea rows={3} maxLength={10000} value={editor.introduction} onChange={(event) => setEditor({ ...editor, introduction: event.target.value })} placeholder="What connects these posts?" /></label>
        <div className="library-actions"><button type="submit" className="btn" disabled={!editor.title.trim()}>Save collection</button><button type="button" className="btn-ghost" onClick={() => setEditor(null)}>Cancel</button></div>
      </form>}
      {!state.collections.length && !editor && <p className="library-empty">Create your own reading paths from posts and saved passages.</p>}
      {!!state.collections.length && <label className="library-field"><span>Your collections</span><CustomSelect value={collection?.id ?? ""} onChange={(event) => { setSelectedCollection(event.target.value); setConfirmDelete(null); setPostKey(""); setSavedItem(""); }}>{state.collections.map((item) => <option value={item.id} key={item.id}>{item.title} ({item.items.length})</option>)}</CustomSelect></label>}
      {collection && <div className="library-collection">
        <div className="collection-heading"><h3>{collection.title}</h3><span className="collection-item-count">{collection.items.length} {collection.items.length === 1 ? "item" : "items"}</span></div>
        {collection.introduction && <p className="collection-introduction">{collection.introduction}</p>}
        <div className="collection-management">
          <div className="library-actions"><button type="button" className="btn-ghost" onClick={() => setEditor({ id: collection.id, title: collection.title, introduction: collection.introduction })}>Edit details</button><button type="button" className="btn-ghost" onClick={() => setConfirmDelete(collection.id)}>Delete collection</button></div>
          {state.collections.length > 1 && <div className="library-actions collection-order" role="group" aria-label="Collection order">
            <button type="button" className="btn-ghost" aria-label={`Move collection ${collection.title} earlier`} disabled={state.collections.indexOf(collection) === 0} onClick={() => onChange({ ...state, collections: moveItem(state.collections, state.collections.indexOf(collection), state.collections.indexOf(collection) - 1) })}>↑ Earlier</button>
            <button type="button" className="btn-ghost" aria-label={`Move collection ${collection.title} later`} disabled={state.collections.indexOf(collection) === state.collections.length - 1} onClick={() => onChange({ ...state, collections: moveItem(state.collections, state.collections.indexOf(collection), state.collections.indexOf(collection) + 1) })}>↓ Later</button>
          </div>}
        </div>
        {confirmDelete === collection.id && <div className="library-confirm" role="group" aria-label="Confirm collection deletion"><p>Delete “{collection.title}”? Your posts, notes, and saved passages will stay in your library.</p><button type="button" className="btn-ghost" onClick={() => { onChange({ ...state, collections: state.collections.filter((item) => item.id !== collection.id) }); setConfirmDelete(null); }}>Delete this collection</button><button type="button" className="btn-ghost" onClick={() => setConfirmDelete(null)}>Keep collection</button></div>}
        <details className="library-card collection-add"><summary>Add a post or passage</summary>
          <div className="collection-add-section">
            <label className="library-field"><span>Choose a saved post or passage</span><CustomSelect value={savedItem} onChange={(event) => setSavedItem(event.target.value)}><option value="">Select a saved post or passage</option>{[...new Set(savedPostKeys)].map((key) => {
              const message = messageMap.get(key);
              return <option value={`post:${key}`} key={`post:${key}`}>Saved post #{message?.message_id ?? key.split(":").pop()} · {preview(message?.text || message?.quote_text || "", 65)}</option>;
            })}{state.passages.map((passage) => <option value={`passage:${passage.id}`} key={`passage:${passage.id}`}>Passage #{passage.messageKey.split(":").pop()} · {preview(passage.text, 65)}</option>)}</CustomSelect></label>
            {!savedPostKeys.length && !state.passages.length && <p className="library-hint">Click Save on a post, or select text and save a passage while reading. It will appear here immediately.</p>}
            <button type="button" className="btn-ghost" disabled={!savedItem || (savedItem.startsWith("post:") ? !savedPostKeys.includes(savedItem.slice(5)) || collection.items.some((item) => item.messageKey === savedItem.slice(5) && !item.passageId) : !passageMap.has(savedItem.slice(8)) || collection.items.some((item) => item.passageId === savedItem.slice(8)))} onClick={() => {
              if (savedItem.startsWith("post:")) {
                const key = savedItem.slice(5);
                if (!savedPostKeys.includes(key) || collection.items.some((item) => item.messageKey === key && !item.passageId)) return;
                updateCollection({ ...collection, items: [...collection.items, { id: id(), messageKey: key }] });
              } else if (savedItem.startsWith("passage:")) {
                const passage = passageMap.get(savedItem.slice(8));
                if (!passage || collection.items.some((item) => item.passageId === passage.id)) return;
                updateCollection({ ...collection, items: [...collection.items, { id: id(), messageKey: passage.messageKey, passageId: passage.id }] });
              } else return;
              setSavedItem("");
            }}>Add saved item</button>
          </div>
          <div className="collection-add-section">
            <p className="collection-add-caption">Or find another post</p>
            <label className="library-field"><span>Find a post by ID or words</span><input value={postQuery} onChange={(event) => { setPostQuery(event.target.value); setPostKey(""); }} placeholder="Post ID or words from the post" /></label>
            <label className="library-field"><span>Choose a post{availablePosts.length === 100 ? " (first 100 matches; refine your search)" : ""}</span><CustomSelect value={postKey} onChange={(event) => setPostKey(event.target.value)}><option value="">Select a post</option>{availablePosts.map((message) => <option key={message.message_key} value={message.message_key}>#{message.message_id} · {preview(message.text, 65)}</option>)}</CustomSelect></label>
            <button type="button" className="btn-ghost" disabled={!messageMap.has(postKey) || collection.items.some((item) => item.messageKey === postKey && !item.passageId)} onClick={() => { if (!messageMap.has(postKey)) return; updateCollection({ ...collection, items: [...collection.items, { id: id(), messageKey: postKey }] }); setPostKey(""); }}>Add post</button>
          </div>
        </details>
        {!collection.items.length && <p className="library-empty">Add a post or saved passage to begin this reading path.</p>}
        <ol className="library-list">{collection.items.map((item, index) => <li className="library-card" key={item.id}>{item.passageId ? <><span className="library-post-id">Passage from #{item.messageKey.split(":").pop()}</span><blockquote>{passageMap.get(item.passageId)?.text ?? "Saved passage unavailable"}</blockquote></> : postPreview(item.messageKey)}{postActions(item.messageKey)}<div className="library-actions"><button type="button" className="btn-ghost" aria-label={`Move item ${index + 1} earlier`} disabled={index === 0} onClick={() => updateCollection({ ...collection, items: moveItem(collection.items, index, index - 1) })}>↑ Earlier</button><button type="button" className="btn-ghost" aria-label={`Move item ${index + 1} later`} disabled={index === collection.items.length - 1} onClick={() => updateCollection({ ...collection, items: moveItem(collection.items, index, index + 1) })}>↓ Later</button><button type="button" className="btn-ghost" onClick={() => updateCollection({ ...collection, items: collection.items.filter((entry) => entry.id !== item.id) })}>Remove</button></div></li>)}</ol>
      </div>}
    </div>}

    {tab === "work" && <div id={`${idPrefix}library-panel-work`} role="tabpanel" aria-labelledby={`${idPrefix}library-tab-work`} className="library-panel">
      <label className="library-field"><span>Search your notes, saved passages, and collections</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a thought you saved…" /></label>
      <p className="library-hint" role="status">{matchingNotes.length} notes · {matchingPassages.length} passages · {matchingCollections.length} collections</p>
      {!matchingNotes.length && !matchingPassages.length && !matchingCollections.length && <p className="library-empty">{normalized ? "No matches in your work. Try different words." : "Save passages and add notes while reading. Your own thoughts will appear here."}</p>}
      {!!matchingCollections.length && <div className="library-work-group"><h3>Collections</h3>{matchingCollections.map((item) => <button type="button" className="library-card library-collection-result" key={item.id} onClick={() => { setSelectedCollection(item.id); setTab("collections"); }}><strong>{item.title}</strong><span>{preview(item.introduction || `${item.items.length} saved items`)}</span></button>)}</div>}
      {!!matchingNotes.length && <div className="library-work-group"><h3>Notes</h3>{matchingNotes.map(([key, note]) => <article className="library-card" key={key}>{postPreview(key)}<NoteEditor key={`${key}:${note}`} value={note} label="Your note" onSave={(value) => { const notes = { ...state.notes }; if (value) notes[key] = value; else delete notes[key]; onChange({ ...state, notes }); }} />{postActions(key)}</article>)}</div>}
      {!!matchingPassages.length && <div className="library-work-group"><h3>Saved passages</h3>{matchingPassages.map((passage) => <article className="library-card" key={passage.id}><span className="library-post-id">Passage from #{passage.messageKey.split(":").pop()}</span><blockquote>{passage.text}</blockquote><NoteEditor key={`${passage.id}:${passage.note}`} value={passage.note} label="Passage note" onSave={(note) => onChange({ ...state, passages: state.passages.map((item) => item.id === passage.id ? { ...item, note } : item) })} />{postActions(passage.messageKey)}<button type="button" className="btn-ghost" onClick={() => setConfirmDelete(passage.id)}>Delete passage</button>{confirmDelete === passage.id && <div className="library-confirm" role="group" aria-label="Confirm passage deletion"><p>Remove this passage and its references in collections?</p><button type="button" className="btn-ghost" onClick={() => removePassage(passage.id)}>Delete passage</button><button type="button" className="btn-ghost" onClick={() => setConfirmDelete(null)}>Keep passage</button></div>}</article>)}</div>}
    </div>}
  </section>;
}
