import {
  Archive,
  BatteryLow,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Layers3,
  ListFilter,
  Plus,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { TagsInput } from "../components/TagsInput";
import { TaskItem } from "../components/TaskItem";
import { useLifeRecordsStore } from "../store/useLifeRecordsStore";
import type { Visibility } from "../advancedTypes";
import type { Energy, Priority, Task } from "../types";

type StatusFilter = "active" | "done";
type GroupBy = "priority" | "tag" | "none";

interface TasksPageProps {
  onQuickAdd: () => void;
  onToast: (message: string) => void;
}

const statusFilters: Array<{ id: StatusFilter; label: string; icon: typeof CircleDot }> = [
  { id: "active", label: "Aktywne", icon: CircleDot },
  { id: "done", label: "Ukończone", icon: CheckCircle2 },
];

const groupByOptions: Array<{ id: GroupBy; label: string; icon: typeof Layers3 }> = [
  { id: "priority", label: "Wg ważności", icon: Star },
  { id: "tag", label: "Wg tagu", icon: Tag },
  { id: "none", label: "Bez grupowania", icon: Layers3 },
];

const PRIORITY_SECTIONS: Array<{ id: Priority; label: string }> = [
  { id: "high", label: "Ważne" },
  { id: "medium", label: "Normalne" },
  { id: "low", label: "Może poczekać" },
];

const NO_TAG_SECTION = "__no-tag__";

interface TaskSection {
  id: string;
  label: string;
  tasks: Task[];
}

function buildSections(tasks: Task[], groupBy: GroupBy): TaskSection[] {
  if (groupBy === "none") {
    return tasks.length ? [{ id: "all", label: "", tasks }] : [];
  }
  if (groupBy === "priority") {
    return PRIORITY_SECTIONS.map((section) => ({
      id: section.id,
      label: section.label,
      tasks: tasks.filter((task) => task.priority === section.id),
    })).filter((section) => section.tasks.length > 0);
  }
  // groupBy === "tag": jedna sekcja na tag (zadanie z N tagami pojawia się w N sekcjach) + "Bez
  // tagu" na końcu (docs/plans/zadania-redefinicja.md "Grupowanie na liście").
  const byTag = new Map<string, Task[]>();
  const untagged: Task[] = [];
  for (const task of tasks) {
    if (task.tags.length === 0) {
      untagged.push(task);
      continue;
    }
    for (const tag of task.tags) {
      const bucket = byTag.get(tag) ?? [];
      bucket.push(task);
      byTag.set(tag, bucket);
    }
  }
  const sections: TaskSection[] = Array.from(byTag.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "pl"))
    .map(([tag, items]) => ({ id: tag, label: tag, tasks: items }));
  if (untagged.length) sections.push({ id: NO_TAG_SECTION, label: "Bez tagu", tasks: untagged });
  return sections;
}

export function TasksPage({ onQuickAdd, onToast }: TasksPageProps) {
  const tasks = useLifeRecordsStore((state) => state.tasks);
  const updateTask = useLifeRecordsStore((state) => state.updateTask);
  const deleteTask = useLifeRecordsStore((state) => state.deleteTask);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [groupBy, setGroupBy] = useState<GroupBy>("priority");
  const [query, setQuery] = useState("");
  const [energyFilter, setEnergyFilter] = useState<Energy | "all">("all");
  const [tagFilter, setTagFilter] = useState<string | "all">("all");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const allTags = useMemo(() => {
    const unique = new Set<string>();
    tasks.forEach((task) => task.tags.forEach((tag) => unique.add(tag)));
    return Array.from(unique).sort((a, b) => a.localeCompare(b, "pl"));
  }, [tasks]);

  const counts = {
    active: tasks.filter((task) => task.status === "todo").length,
    done: tasks.filter((task) => task.status === "done").length,
  };

  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("pl");
    return tasks
      .filter((task) => (statusFilter === "done" ? task.status === "done" : task.status === "todo"))
      .filter((task) => energyFilter === "all" || task.energy === energyFilter)
      .filter((task) => tagFilter === "all" || task.tags.includes(tagFilter))
      .filter(
        (task) =>
          !normalizedQuery ||
          task.title.toLocaleLowerCase("pl").includes(normalizedQuery) ||
          task.tags.some((tag) => tag.toLocaleLowerCase("pl").includes(normalizedQuery)),
      )
      .sort((a, b) => {
        if (a.isFocus !== b.isFocus) return a.isFocus ? -1 : 1;
        const priorityRank = { high: 0, medium: 1, low: 2 } as const;
        if (a.priority !== b.priority) return priorityRank[a.priority] - priorityRank[b.priority];
        return b.createdAt.localeCompare(a.createdAt);
      });
  }, [energyFilter, query, statusFilter, tagFilter, tasks]);

  const sections = useMemo(() => buildSections(visibleTasks, groupBy), [visibleTasks, groupBy]);

  // Limit priorytetów ("w skupieniu") liczony GLOBALNIE po `isFocus && status!=='done'` — bez
  // grupowania po dacie, zadania nie mają już `date` (docs/plans/zadania-redefinicja.md "Dzisiaj").
  const focusCount = tasks.filter((task) => task.isFocus && task.status !== "done").length;
  const totalCompleted = tasks.filter((task) => task.status === "done").length;

  return (
    <div className="tasks-page page-enter">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Twoja przestrzeń działania</span>
          <h1>Zadania</h1>
          <p>Jedno miejsce na rzeczy małe, duże i te do zapamiętania na później.</p>
        </div>
        <button className="button button--primary" type="button" onClick={onQuickAdd}>
          <Plus size={17} /> Nowe zadanie
        </button>
      </header>

      <section className="task-stats">
        <div>
          <span className="stat-icon stat-icon--green">
            <Star size={18} />
          </span>
          <div>
            <strong>{focusCount}/3</strong>
            <span>w skupieniu</span>
          </div>
        </div>
        <div>
          <span className="stat-icon stat-icon--blue">
            <CheckCircle2 size={18} />
          </span>
          <div>
            <strong>{totalCompleted}</strong>
            <span>ukończone łącznie</span>
          </div>
        </div>
      </section>

      <div className="task-workspace">
        <aside
          id="task-filter-panel"
          className={`task-filters ${mobileFiltersOpen ? "task-filters--open" : ""}`}
        >
          <div className="task-filters__heading">
            <span>Stan</span>
            <ListFilter size={16} />
          </div>
          {statusFilters.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={statusFilter === item.id ? "active" : ""}
                type="button"
                onClick={() => {
                  setStatusFilter(item.id);
                  setMobileFiltersOpen(false);
                }}
                aria-pressed={statusFilter === item.id}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                <strong>{counts[item.id]}</strong>
              </button>
            );
          })}
          <div className="task-filters__divider" />
          <div className="task-filters__heading">
            <span>Grupuj wg</span>
            <Layers3 size={16} />
          </div>
          {groupByOptions.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={groupBy === item.id ? "active" : ""}
                type="button"
                onClick={() => setGroupBy(item.id)}
                aria-pressed={groupBy === item.id}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
          <div className="task-filters__divider" />
          <div className="energy-filter">
            <span>Dopasuj do energii</span>
            <button
              className={energyFilter === "all" ? "active" : ""}
              type="button"
              onClick={() => setEnergyFilter("all")}
              aria-pressed={energyFilter === "all"}
            >
              Wszystkie
            </button>
            <button
              className={energyFilter === "low" ? "active" : ""}
              type="button"
              onClick={() => setEnergyFilter("low")}
              aria-pressed={energyFilter === "low"}
            >
              <BatteryLow size={15} /> Mała energia
            </button>
            <button
              className={energyFilter === "medium" ? "active" : ""}
              type="button"
              onClick={() => setEnergyFilter("medium")}
              aria-pressed={energyFilter === "medium"}
            >
              🌤️ Średnia
            </button>
            <button
              className={energyFilter === "high" ? "active" : ""}
              type="button"
              onClick={() => setEnergyFilter("high")}
              aria-pressed={energyFilter === "high"}
            >
              ⚡ Duża
            </button>
          </div>
          {allTags.length > 0 && (
            <>
              <div className="task-filters__divider" />
              <div className="energy-filter">
                <span>Filtruj po tagu</span>
                <button
                  className={tagFilter === "all" ? "active" : ""}
                  type="button"
                  onClick={() => setTagFilter("all")}
                  aria-pressed={tagFilter === "all"}
                >
                  Wszystkie
                </button>
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    className={tagFilter === tag ? "active" : ""}
                    type="button"
                    onClick={() => setTagFilter(tag)}
                    aria-pressed={tagFilter === tag}
                  >
                    <Tag size={13} /> {tag}
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>

        <section className="task-list-panel panel">
          <header className="task-list-toolbar">
            <button
              className="mobile-filter-trigger"
              type="button"
              onClick={() => setMobileFiltersOpen((value) => !value)}
              aria-expanded={mobileFiltersOpen}
              aria-controls="task-filter-panel"
            >
              <ListFilter size={16} /> {statusFilters.find((item) => item.id === statusFilter)?.label}{" "}
              <ChevronDown size={15} />
            </button>
            <div>
              <h2>{statusFilters.find((item) => item.id === statusFilter)?.label}</h2>
              <span>
                {visibleTasks.length}{" "}
                {visibleTasks.length === 1
                  ? "pozycja"
                  : visibleTasks.length < 5
                    ? "pozycje"
                    : "pozycji"}
              </span>
            </div>
            <label className="search-field">
              <Search size={16} />
              <span className="sr-only">Szukaj zadań</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Szukaj po nazwie lub tagu…"
              />
            </label>
          </header>

          <div className="task-list task-list--grouped">
            {sections.length ? (
              sections.map((section) => (
                <div className="task-section" key={section.id}>
                  {section.label && (
                    <h3 className="task-section__label">
                      {section.label} <span>{section.tasks.length}</span>
                    </h3>
                  )}
                  {section.tasks.map((task) => (
                    <TaskItem
                      key={`${section.id}-${task.id}`}
                      task={task}
                      showActions
                      onEdit={setEditingTask}
                      onFocusLimit={() =>
                        onToast("Masz już trzy priorytety — najpierw zwolnij jedno miejsce")
                      }
                      onToast={onToast}
                    />
                  ))}
                </div>
              ))
            ) : (
              <EmptyState
                icon={statusFilter === "done" ? Sparkles : Archive}
                title={
                  query
                    ? "Nic nie pasuje do wyszukiwania"
                    : statusFilter === "done"
                      ? "Pierwsze ukończone zadanie dopiero przed Tobą"
                      : "Tutaj jest spokojnie"
                }
                description={
                  query
                    ? "Spróbuj krótszej frazy albo innego tagu."
                    : "Dodaj coś, co chcesz mieć z głowy — bez zbędnych pól."
                }
                action={query ? "Wyczyść wyszukiwanie" : "Dodaj zadanie"}
                onAction={query ? () => setQuery("") : onQuickAdd}
              />
            )}
          </div>
        </section>
      </div>

      <TaskEditModal
        task={editingTask}
        allTags={allTags}
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
      />
    </div>
  );
}

interface TaskEditModalProps {
  task: Task | null;
  allTags: string[];
  onClose: () => void;
  onSave: (changes: Partial<Task>) => void;
  onDelete: () => void;
}

function TaskEditModal({ task, allTags, onClose, onSave, onDelete }: TaskEditModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>("medium");
  const [energy, setEnergy] = useState<Energy>("medium");
  const [visibility, setVisibility] = useState<Visibility>("household");

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setTags(task.tags);
    setPriority(task.priority);
    setEnergy(task.energy);
    setVisibility(task.visibility ?? "household");
  }, [task]);

  const buildChanges = (): Partial<Task> => ({
    title: title.trim(),
    description: description.trim() || undefined,
    tags,
    priority,
    energy,
    visibility,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(buildChanges());
  };

  const hasUnsavedChanges = () =>
    Boolean(task) &&
    (title !== task!.title ||
      description !== (task!.description ?? "") ||
      tags.join(",") !== task!.tags.join(",") ||
      priority !== task!.priority ||
      energy !== task!.energy ||
      visibility !== (task!.visibility ?? "household"));
  const confirmDiscardChanges = () =>
    !hasUnsavedChanges() ||
    window.confirm("Masz niezapisane zmiany w zadaniu. Czy na pewno chcesz je odrzucić?");

  return (
    <Modal
      open={Boolean(task)}
      onClose={onClose}
      confirmClose={confirmDiscardChanges}
      title="Szczegóły zadania"
      eyebrow={task?.status === "done" ? "Ukończone" : "Do zrobienia"}
    >
      <form className="edit-form" onSubmit={submit}>
        <label className="field field--prominent">
          <span>Nazwa</span>
          <input
            autoFocus
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Notatka</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Opcjonalny kontekst…"
          />
        </label>
        <label className="field">
          <span>Tagi</span>
          <TagsInput
            value={tags}
            onChange={setTags}
            suggestions={allTags}
            placeholder="Np. dom, praca, zdrowie…"
            aria-label="Tagi zadania"
          />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Ważność</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
            >
              <option value="high">Ważne</option>
              <option value="medium">Normalne</option>
              <option value="low">Może poczekać</option>
            </select>
          </label>
          <label className="field">
            <span>Energia</span>
            <select value={energy} onChange={(event) => setEnergy(event.target.value as Energy)}>
              <option value="low">Mała</option>
              <option value="medium">Średnia</option>
              <option value="high">Duża</option>
            </select>
          </label>
          <label className="field">
            <span>Widoczność</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as Visibility)}
            >
              <option value="household">Cały dom</option>
              <option value="private">Tylko ja</option>
            </select>
          </label>
        </div>

        <footer className="modal-actions modal-actions--spread">
          <div>
            <button
              className="button button--danger-ghost"
              type="button"
              onClick={() => {
                if (window.confirm(`Usunąć zadanie „${task?.title ?? ""}”?`)) onDelete();
              }}
            >
              <Trash2 size={15} /> Usuń
            </button>
          </div>
          <div>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                if (confirmDiscardChanges()) onClose();
              }}
            >
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Zapisz zmiany
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
