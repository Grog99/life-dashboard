import {
  Archive,
  BatteryLow,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Inbox,
  Layers3,
  ListFilter,
  Plus,
  Repeat,
  Search,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isAfter, parseISO } from "date-fns";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { TaskItem } from "../components/TaskItem";
import { dateKey, formatShortDate, isOverdue } from "../lib/date";
import { RecurrenceFields, useRecurrenceForm } from "../components/RecurrenceFields";
import { useLifeStore } from "../store/useLifeStore";
import type { Visibility } from "../advancedTypes";
import type { Energy, Priority, Task } from "../types";

type TaskFilter = "today" | "inbox" | "upcoming" | "all" | "done";

interface TasksPageProps {
  onQuickAdd: () => void;
  onToast: (message: string) => void;
}

const filters: Array<{ id: TaskFilter; label: string; icon: typeof Inbox }> = [
  { id: "today", label: "Dzisiaj", icon: CircleDot },
  { id: "inbox", label: "Skrzynka", icon: Inbox },
  { id: "upcoming", label: "Nadchodzące", icon: CalendarDays },
  { id: "all", label: "Wszystkie aktywne", icon: Layers3 },
  { id: "done", label: "Ukończone", icon: CheckCircle2 },
];

export function TasksPage({ onQuickAdd, onToast }: TasksPageProps) {
  const tasks = useLifeStore((state) => state.tasks);
  const updateTask = useLifeStore((state) => state.updateTask);
  const deleteTask = useLifeStore((state) => state.deleteTask);
  const updateSeries = useLifeStore((state) => state.updateSeries);
  const deleteSeries = useLifeStore((state) => state.deleteSeries);
  const [filter, setFilter] = useState<TaskFilter>("today");
  const [query, setQuery] = useState("");
  const [energyFilter, setEnergyFilter] = useState<Energy | "all">("all");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const today = dateKey();
  const counts = {
    today: tasks.filter((task) => task.date === today && task.status === "todo").length,
    inbox: tasks.filter((task) => !task.date && task.status === "todo").length,
    upcoming: tasks.filter(
      (task) => task.date && isAfter(parseISO(task.date), parseISO(today)) && task.status === "todo",
    ).length,
    all: tasks.filter((task) => task.status === "todo").length,
    done: tasks.filter((task) => task.status === "done").length,
  };

  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("pl");
    return tasks
      .filter((task) => {
        if (filter === "today") return task.date === today && task.status === "todo";
        if (filter === "inbox") return !task.date && task.status === "todo";
        if (filter === "upcoming") {
          return Boolean(
            task.date &&
              isAfter(parseISO(task.date), parseISO(today)) &&
              task.status === "todo",
          );
        }
        if (filter === "done") return task.status === "done";
        return task.status === "todo";
      })
      .filter((task) => energyFilter === "all" || task.energy === energyFilter)
      .filter(
        (task) =>
          !normalizedQuery ||
          task.title.toLocaleLowerCase("pl").includes(normalizedQuery) ||
          task.category.toLocaleLowerCase("pl").includes(normalizedQuery),
      )
      .sort((a, b) => {
        if (a.isFocus !== b.isFocus) return a.isFocus ? -1 : 1;
        if (a.status !== b.status) return a.status === "todo" ? -1 : 1;
        return (a.date ?? "9999").localeCompare(b.date ?? "9999");
      });
  }, [energyFilter, filter, query, tasks, today]);

  const focusCount = tasks.filter(
    (task) =>
      task.isFocus &&
      task.status === "todo" &&
      (!task.date || task.date === today),
  ).length;
  const overdueCount = tasks.filter((task) => isOverdue(task.date, task.status)).length;
  const totalCompleted = tasks.filter((task) => task.status === "done").length;

  return (
    <div className="tasks-page page-enter">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Twoja przestrzeń działania</span>
          <h1>Zadania</h1>
          <p>Jedno miejsce na rzeczy małe, duże i te do zapamiętania na później.</p>
        </div>
        <button className="button button--primary" type="button" onClick={onQuickAdd}><Plus size={17} /> Nowe zadanie</button>
      </header>

      <section className="task-stats">
        <div><span className="stat-icon stat-icon--green"><Star size={18} /></span><div><strong>{focusCount}/3</strong><span>priorytety dnia</span></div></div>
        <div><span className="stat-icon stat-icon--amber"><Archive size={18} /></span><div><strong>{overdueCount}</strong><span>do przeplanowania</span></div></div>
        <div><span className="stat-icon stat-icon--blue"><CheckCircle2 size={18} /></span><div><strong>{totalCompleted}</strong><span>ukończone łącznie</span></div></div>
      </section>

      <div className="task-workspace">
        <aside id="task-filter-panel" className={`task-filters ${mobileFiltersOpen ? "task-filters--open" : ""}`}>
          <div className="task-filters__heading"><span>Widoki</span><ListFilter size={16} /></div>
          {filters.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={filter === item.id ? "active" : ""}
                type="button"
                onClick={() => { setFilter(item.id); setMobileFiltersOpen(false); }}
                aria-pressed={filter === item.id}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                <strong>{counts[item.id]}</strong>
              </button>
            );
          })}
          <div className="task-filters__divider" />
          <div className="energy-filter">
            <span>Dopasuj do energii</span>
            <button className={energyFilter === "all" ? "active" : ""} type="button" onClick={() => setEnergyFilter("all")} aria-pressed={energyFilter === "all"}>Wszystkie</button>
            <button className={energyFilter === "low" ? "active" : ""} type="button" onClick={() => setEnergyFilter("low")} aria-pressed={energyFilter === "low"}><BatteryLow size={15} /> Mała energia</button>
            <button className={energyFilter === "medium" ? "active" : ""} type="button" onClick={() => setEnergyFilter("medium")} aria-pressed={energyFilter === "medium"}>🌤️ Średnia</button>
            <button className={energyFilter === "high" ? "active" : ""} type="button" onClick={() => setEnergyFilter("high")} aria-pressed={energyFilter === "high"}>⚡ Duża</button>
          </div>
        </aside>

        <section className="task-list-panel panel">
          <header className="task-list-toolbar">
            <button className="mobile-filter-trigger" type="button" onClick={() => setMobileFiltersOpen((value) => !value)} aria-expanded={mobileFiltersOpen} aria-controls="task-filter-panel">
              <ListFilter size={16} /> {filters.find((item) => item.id === filter)?.label} <ChevronDown size={15} />
            </button>
            <div>
              <h2>{filters.find((item) => item.id === filter)?.label}</h2>
              <span>{visibleTasks.length} {visibleTasks.length === 1 ? "pozycja" : visibleTasks.length < 5 ? "pozycje" : "pozycji"}</span>
            </div>
            <label className="search-field">
              <Search size={16} />
              <span className="sr-only">Szukaj zadań</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Szukaj…" />
            </label>
          </header>

          <div className="task-list">
            {visibleTasks.length ? (
              visibleTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  showActions
                  onEdit={setEditingTask}
                  onFocusLimit={() => onToast("Masz już trzy priorytety — najpierw zwolnij jedno miejsce")}
                  onToast={onToast}
                />
              ))
            ) : (
              <EmptyState
                icon={filter === "done" ? Sparkles : Inbox}
                title={query ? "Nic nie pasuje do wyszukiwania" : filter === "done" ? "Pierwsze ukończone zadanie dopiero przed Tobą" : "Tutaj jest spokojnie"}
                description={query ? "Spróbuj krótszej frazy albo innego obszaru." : "Dodaj coś, co chcesz mieć z głowy — bez zbędnych pól."}
                action={query ? "Wyczyść wyszukiwanie" : "Dodaj zadanie"}
                onAction={query ? () => setQuery("") : onQuickAdd}
              />
            )}
          </div>
        </section>
      </div>

      <TaskEditModal
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={(changes) => {
          if (!editingTask) return;
          updateTask(editingTask.id, changes);
          setEditingTask(null);
          onToast("Zmiany w zadaniu zapisane");
        }}
        onDelete={() => {
          if (!editingTask) return;
          deleteTask(editingTask.id);
          setEditingTask(null);
          onToast("Zadanie usunięte");
        }}
        onSaveSeries={(changes) => {
          if (!editingTask?.seriesId) return;
          updateSeries(editingTask.seriesId, changes);
          setEditingTask(null);
          onToast("Zmiany zapisane dla całej serii");
        }}
        onDeleteSeries={() => {
          if (!editingTask?.seriesId) return;
          deleteSeries(editingTask.seriesId);
          setEditingTask(null);
          onToast("Cała seria zadań usunięta");
        }}
      />
    </div>
  );
}

interface TaskEditModalProps {
  task: Task | null;
  onClose: () => void;
  onSave: (changes: Partial<Task>) => void;
  onDelete: () => void;
  onSaveSeries: (changes: Partial<Task>) => void;
  onDeleteSeries: () => void;
}

function TaskEditModal({ task, onClose, onSave, onDelete, onSaveSeries, onDeleteSeries }: TaskEditModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [category, setCategory] = useState("Prywatne");
  const [priority, setPriority] = useState<Priority>("medium");
  const [energy, setEnergy] = useState<Energy>("medium");
  const [estimatedMinutes, setEstimatedMinutes] = useState("30");
  const [visibility, setVisibility] = useState<Visibility>("household");
  const repeat = useRecurrenceForm(task?.recurrence);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setDate(task.date ?? "");
    setTime(task.time ?? "");
    setCategory(task.category);
    setPriority(task.priority);
    setEnergy(task.energy);
    setEstimatedMinutes(String(task.estimatedMinutes ?? 30));
    setVisibility(task.visibility ?? "household");
    repeat.reset(task.recurrence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  const buildChanges = (): Partial<Task> => ({
    title: title.trim(),
    description: description.trim() || undefined,
    date: date || undefined,
    time: date ? time || undefined : undefined,
    category,
    priority,
    energy,
    estimatedMinutes: Number(estimatedMinutes) || undefined,
    visibility,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(buildChanges());
  };

  const submitSeries = () => {
    if (!task?.recurrence) return;
    if (!title.trim()) return; // przycisk poza formularzem — pilnujemy wymaganej nazwy sami (inaczej pusty tytuł zepsułby serię)
    // Zachowujemy anchorDate serii (stabilny seriesIndex), ale bierzemy AKTUALNĄ godzinę
    // z formularza jako anchorTime — inaczej edycja godziny serii byłaby cofana.
    onSaveSeries({
      ...buildChanges(),
      recurrence: repeat.build(task.recurrence.anchorDate, date ? time || undefined : undefined),
    });
  };

  const hasUnsavedChanges = () =>
    Boolean(task) && (
      title !== task!.title ||
      description !== (task!.description ?? "") ||
      date !== (task!.date ?? "") ||
      time !== (task!.time ?? "") ||
      category !== task!.category ||
      priority !== task!.priority ||
      energy !== task!.energy ||
      estimatedMinutes !== String(task!.estimatedMinutes ?? 30) ||
      visibility !== (task!.visibility ?? "household") ||
      repeat.differsFrom(task!.recurrence)
    );
  const confirmDiscardChanges = () =>
    !hasUnsavedChanges() || window.confirm("Masz niezapisane zmiany w zadaniu. Czy na pewno chcesz je odrzucić?");

  return (
    <Modal open={Boolean(task)} onClose={onClose} confirmClose={confirmDiscardChanges} title="Szczegóły zadania" eyebrow={task?.date ? `Termin: ${formatShortDate(task.date)}` : "Bez terminu"}>
      <form className="edit-form" onSubmit={submit}>
        {task?.seriesId && (
          <p className="series-edit-note">
            <Repeat size={13} role="img" aria-label="Zadanie powtarzalne" /> To zadanie jest częścią serii. „Zapisz zmiany” dotyczy tylko tego wystąpienia — użyj „Zapisz dla całej serii”, aby zmienić przyszłe wystąpienia.
          </p>
        )}
        <label className="field field--prominent"><span>Nazwa</span><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field"><span>Notatka</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Opcjonalny kontekst…" /></label>
        <div className="form-grid form-grid--2">
          <label className="field"><span>Data</span><input type="date" value={date} onChange={(event) => { setDate(event.target.value); if (!event.target.value) setTime(""); }} /></label>
          <label className="field"><span>Godzina</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          <label className="field"><span>Obszar</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option>Praca</option><option>Prywatne</option><option>Dom</option><option>Zdrowie</option><option>Finanse</option></select></label>
          <label className="field"><span>Ważność</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="high">Ważne</option><option value="medium">Normalne</option><option value="low">Może poczekać</option></select></label>
          <label className="field"><span>Czas</span><select value={estimatedMinutes} onChange={(event) => setEstimatedMinutes(event.target.value)}><option value="10">10 minut</option><option value="15">15 minut</option><option value="30">30 minut</option><option value="60">1 godzina</option><option value="90">1,5 godziny</option></select></label>
          <label className="field"><span>Energia</span><select value={energy} onChange={(event) => setEnergy(event.target.value as Energy)}><option value="low">Mała</option><option value="medium">Średnia</option><option value="high">Duża</option></select></label>
          <label className="field"><span>Widoczność</span><select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)}><option value="household">Cały dom</option><option value="private">Tylko ja</option></select></label>
        </div>

        {task?.seriesId && <RecurrenceFields form={repeat} />}

        <footer className="modal-actions modal-actions--spread">
          <div>
            <button className="button button--danger-ghost" type="button" onClick={() => { if (window.confirm(`Usunąć zadanie „${task?.title ?? ""}”?`)) onDelete(); }}><Trash2 size={15} /> Usuń</button>
            {task?.seriesId && (
              <button className="button button--danger-ghost" type="button" onClick={() => { if (window.confirm("Usunąć całą serię zadań, wraz z przyszłymi wystąpieniami?")) onDeleteSeries(); }}><Trash2 size={15} /> Usuń serię</button>
            )}
          </div>
          <div>
            <button className="button button--ghost" type="button" onClick={() => { if (confirmDiscardChanges()) onClose(); }}>Anuluj</button>
            <button className="button button--primary" type="submit">Zapisz zmiany</button>
            {task?.seriesId && (
              <button className="button button--soft" type="button" onClick={submitSeries}><Repeat size={14} /> Zapisz dla całej serii</button>
            )}
          </div>
        </footer>
      </form>
    </Modal>
  );
}
