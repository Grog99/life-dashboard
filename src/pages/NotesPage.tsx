import {
  CheckSquare2,
  FileText,
  Lock,
  MoreHorizontal,
  Palette,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { formatShortDate, dateKey } from "../lib/date";
import { polishPlural } from "../lib/pluralize";
import { useLifeStore } from "../store/useLifeStore";
import type { Note, NoteColor } from "../types";

interface NotesPageProps {
  onQuickAdd: () => void;
  onToast: (message: string) => void;
}

export function NotesPage({ onQuickAdd, onToast }: NotesPageProps) {
  const notes = useLifeStore((state) => state.notes);
  const updateNote = useLifeStore((state) => state.updateNote);
  const deleteNote = useLifeStore((state) => state.deleteNote);
  const addTask = useLifeStore((state) => state.addTask);
  const [query, setQuery] = useState("");
  const [onlyPinned, setOnlyPinned] = useState(false);

  const visibleNotes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pl");
    return notes
      .filter((note) => !onlyPinned || note.pinned)
      .filter(
        (note) =>
          !normalized ||
          note.title.toLocaleLowerCase("pl").includes(normalized) ||
          note.content.toLocaleLowerCase("pl").includes(normalized),
      )
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }, [notes, onlyPinned, query]);

  const convertFirstLine = (note: Note) => {
    const lines = note.content.split("\n");
    const index = lines.findIndex((line) => line.trim());
    if (index === -1) {
      onToast("W tej notatce nie ma jeszcze treści do zamiany");
      return;
    }
    const title = lines[index].replace(/^[-•]\s*/, "").trim();
    if (!title) {
      onToast("Pierwszy wiersz nie zawiera treści do zamiany w zadanie");
      return;
    }
    addTask({
      title,
      priority: "medium",
      date: dateKey(),
      category: "Prywatne",
      isFocus: false,
      energy: "medium",
    });
    lines.splice(index, 1);
    updateNote(note.id, { content: lines.join("\n").trim() });
    onToast("Pierwszy wiersz zamieniony w zadanie");
  };

  return (
    <div className="notes-page page-enter">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Drugi mózg, bez chaosu</span>
          <h1>Notatki</h1>
          <p>Luźne pomysły, listy i rzeczy, do których chcesz wrócić.</p>
        </div>
        <button className="button button--primary" type="button" onClick={onQuickAdd}><Plus size={17} /> Nowa notatka</button>
      </header>

      <div className="notes-toolbar">
        <label className="search-field search-field--wide"><Search size={17} /><span className="sr-only">Szukaj w notatkach</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Szukaj w notatkach…" /></label>
        <button className={onlyPinned ? "filter-pill active" : "filter-pill"} type="button" onClick={() => setOnlyPinned((value) => !value)} aria-pressed={onlyPinned}><Pin size={15} /> Tylko przypięte</button>
        <span className="notes-count">{visibleNotes.length} {polishPlural(visibleNotes.length, "notatka", "notatki", "notatek")}</span>
      </div>

      {visibleNotes.length ? (
        <div className="notes-grid">
          {visibleNotes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onUpdate={(changes) => updateNote(note.id, changes)}
              onDelete={() => { deleteNote(note.id); onToast("Notatka usunięta"); }}
              onConvert={() => convertFirstLine(note)}
            />
          ))}
          <button className="new-note-card" type="button" onClick={onQuickAdd}><span><Plus size={22} /></span><strong>Nowa notatka</strong><small>Zapisz coś, zanim ucieknie</small></button>
        </div>
      ) : (
        <div className="panel notes-empty-panel"><EmptyState icon={FileText} title={query ? "Nie znaleziono notatek" : "Czysta kartka"} description={query ? "Spróbuj innej frazy albo pokaż wszystkie notatki." : "Pierwsza myśl nie musi być idealnie uporządkowana. Po prostu ją zapisz."} action={query ? "Wyczyść wyszukiwanie" : "Utwórz notatkę"} onAction={query ? () => setQuery("") : onQuickAdd} /></div>
      )}
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  onUpdate: (changes: Partial<Note>) => void;
  onDelete: () => void;
  onConvert: () => void;
}

function NoteCard({ note, onUpdate, onDelete, onConvert }: NoteCardProps) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [menuOpen, setMenuOpen] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  // Tracks the title/content we last considered "in sync" with the store, whether that came
  // from the note prop or from our own autosave — so a prop update caused by our own save
  // doesn't get treated as an external change and stomp on newer local edits.
  const syncedRef = useRef({ title: note.title, content: note.content });

  useEffect(() => {
    if (syncedRef.current.title === note.title && syncedRef.current.content === note.content) return;
    syncedRef.current = { title: note.title, content: note.content };
    setTitle(note.title);
    setContent(note.content);
  }, [note.content, note.title]);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);
  useEffect(() => {
    if (title === syncedRef.current.title && content === syncedRef.current.content) return;
    const timer = window.setTimeout(() => {
      const nextTitle = title.trim() || "Bez tytułu";
      syncedRef.current = { title: nextTitle, content };
      onUpdateRef.current({ title: nextTitle, content });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [content, title]);

  const save = () => {
    if (title !== syncedRef.current.title || content !== syncedRef.current.content) {
      const nextTitle = title.trim() || "Bez tytułu";
      syncedRef.current = { title: nextTitle, content };
      onUpdate({ title: nextTitle, content });
    }
  };

  const cycleColor = () => {
    const colors: NoteColor[] = ["cream", "mint", "sky", "lilac"];
    onUpdate({ color: colors[(colors.indexOf(note.color) + 1) % colors.length] });
  };

  return (
    <article className={`note-card note-card--${note.color}`}>
      <header>
        <span className="note-date">
          Edytowano {formatShortDate(note.updatedAt.slice(0, 10))}
          {note.visibility === "private" && <span className="private-badge"><Lock size={11} /> Prywatne</span>}
        </span>
        <div>
          {note.pinned && <Pin className="note-pin" size={15} fill="currentColor" />}
          <button className="icon-button" type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Opcje notatki"><MoreHorizontal size={18} /></button>
          {menuOpen && (
            <div className="context-menu note-menu">
              <button type="button" onClick={() => { onUpdate({ pinned: !note.pinned }); setMenuOpen(false); }}>{note.pinned ? <PinOff size={15} /> : <Pin size={15} />}{note.pinned ? "Odepnij" : "Przypnij"}</button>
              <button type="button" onClick={() => { cycleColor(); setMenuOpen(false); }}><Palette size={15} /> Zmień kolor</button>
              <button
                type="button"
                onClick={() => {
                  onUpdate({ visibility: note.visibility === "private" ? "household" : "private" });
                  setMenuOpen(false);
                }}
              >
                {note.visibility === "private" ? <Users size={15} /> : <Lock size={15} />}
                {note.visibility === "private" ? "Udostępnij domownikom" : "Ustaw jako prywatne"}
              </button>
              <button type="button" onClick={() => { onConvert(); setMenuOpen(false); }}><CheckSquare2 size={15} /> Wiersz → zadanie</button>
              <button className="danger" type="button" onClick={() => { if (window.confirm(`Usunąć notatkę „${note.title || "Bez tytułu"}”?`)) onDelete(); }}><Trash2 size={15} /> Usuń</button>
            </div>
          )}
        </div>
      </header>
      <input className="note-card__title" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={save} aria-label="Tytuł notatki" />
      <textarea className="note-card__content" value={content} onChange={(event) => setContent(event.target.value)} onBlur={save} placeholder="Zacznij pisać…" aria-label={`Treść notatki ${note.title}`} />
      <footer><span><span className="save-dot" /> autosave</span><span>{content.length} znaków</span></footer>
    </article>
  );
}
