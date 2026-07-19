import { Check, Lock, MoreHorizontal, Sparkles, Star, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLifeRecordsStore } from "../store/useLifeRecordsStore";
import type { Task } from "../types";

interface TaskItemProps {
  task: Task;
  compact?: boolean;
  showActions?: boolean;
  onFocusLimit?: () => void;
  onEdit?: (task: Task) => void;
  onToast?: (message: string) => void;
}

const TASK_MENU_OPEN_EVENT = "task-item-menu-open";

const priorityLabels = {
  high: "Ważne",
  medium: "Normalne",
  low: "Spokojnie",
};

export function TaskItem({
  task,
  compact = false,
  showActions = false,
  onFocusLimit,
  onEdit,
  onToast,
}: TaskItemProps) {
  const menuId = useId();
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleTask = useLifeRecordsStore((state) => state.toggleTask);
  const toggleFocus = useLifeRecordsStore((state) => state.toggleFocus);
  const deleteTask = useLifeRecordsStore((state) => state.deleteTask);

  const handleFocus = () => {
    if (!toggleFocus(task.id)) onFocusLimit?.();
    setMenuOpen(false);
  };

  const handleDelete = () => {
    if (!window.confirm(`Usunąć zadanie „${task.title}”?`)) return;
    deleteTask(task.id);
    onToast?.("Zadanie usunięte");
    setMenuOpen(false);
  };

  const handleMenuToggle = () => {
    setMenuOpen((value) => {
      const next = !value;
      if (next) window.dispatchEvent(new CustomEvent(TASK_MENU_OPEN_EVENT, { detail: menuId }));
      return next;
    });
  };

  useEffect(() => {
    if (!menuOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleOtherMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== menuId) setMenuOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener(TASK_MENU_OPEN_EVENT, handleOtherMenuOpen);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener(TASK_MENU_OPEN_EVENT, handleOtherMenuOpen);
    };
  }, [menuId, menuOpen]);

  return (
    <article
      className={`task-item ${task.status === "done" ? "task-item--done" : ""} ${compact ? "task-item--compact" : ""}`}
    >
      <button
        className="task-check"
        type="button"
        onClick={() => toggleTask(task.id)}
        aria-label={task.status === "done" ? `Przywróć: ${task.title}` : `Ukończ: ${task.title}`}
      >
        {task.status === "done" && <Check size={15} strokeWidth={3} />}
      </button>

      <div className="task-item__content">
        <div className="task-item__title-row">
          {onEdit ? (
            <button className="task-title-button" type="button" onClick={() => onEdit(task)}>
              {task.title}
            </button>
          ) : (
            <h3>{task.title}</h3>
          )}
          {task.isFocus && task.status !== "done" && (
            <span className="focus-label">
              <Star size={11} fill="currentColor" /> Priorytet
            </span>
          )}
        </div>
        {!compact && task.description && <p>{task.description}</p>}
        <div className="task-meta">
          {task.visibility === "private" && (
            <span className="private-badge">
              <Lock size={12} /> Prywatne
            </span>
          )}
          {task.tags.length > 0 && (
            <span className="task-tags">
              {task.tags.map((tag) => (
                <span className="tag-chip" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
          {task.priority === "high" && (
            <span className="priority-high">
              <Sparkles size={13} /> {priorityLabels[task.priority]}
            </span>
          )}
        </div>
      </div>

      {showActions && (
        <div className="task-actions" ref={menuContainerRef}>
          <button
            className="icon-button task-menu-button"
            type="button"
            aria-label={`Opcje zadania: ${task.title}`}
            aria-expanded={menuOpen}
            onClick={handleMenuToggle}
          >
            <MoreHorizontal size={19} />
          </button>
          {menuOpen && (
            <div className="context-menu">
              <button type="button" onClick={handleFocus}>
                <Star size={15} /> {task.isFocus ? "Usuń z priorytetów" : "Dodaj do priorytetów"}
              </button>
              <button className="danger" type="button" onClick={handleDelete}>
                <Trash2 size={15} /> Usuń
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
