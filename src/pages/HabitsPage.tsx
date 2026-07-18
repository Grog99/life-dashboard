import {
  BookOpen,
  Check,
  Droplets,
  Flame,
  Footprints,
  Leaf,
  Lock,
  Plus,
  Sparkles,
  StretchHorizontal,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { addDays, format } from "date-fns";
import { pl } from "date-fns/locale";
import { Modal } from "../components/Modal";
import { dateKey, formatDayName } from "../lib/date";
import { useLifeRecordsStore } from "../store/useLifeRecordsStore";
import { useServerAuth } from "../server/AuthGate";
import type { Visibility } from "../advancedTypes";
import type { Habit } from "../types";

const icons = {
  water: Droplets,
  walk: Footprints,
  read: BookOpen,
  stretch: StretchHorizontal,
  meditate: Leaf,
};

export function HabitsPage({ onToast }: { onToast: (message: string) => void }) {
  const habits = useLifeRecordsStore((state) => state.habits);
  const toggleHabit = useLifeRecordsStore((state) => state.toggleHabit);
  const addHabit = useLifeRecordsStore((state) => state.addHabit);
  const deleteHabit = useLifeRecordsStore((state) => state.deleteHabit);
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const [addOpen, setAddOpen] = useState(false);
  const days = Array.from({ length: 7 }, (_, index) => addDays(new Date(), index - 6));
  const today = dateKey();
  const todayDone = habits.filter((habit) => habit.completedDates.includes(today)).length;
  const totalChecks = habits.reduce(
    (sum, habit) =>
      sum + habit.completedDates.filter((date) => days.some((day) => dateKey(day) === date)).length,
    0,
  );
  const consistency = habits.length ? Math.round((totalChecks / (habits.length * 7)) * 100) : 0;

  return (
    <div className="habits-page page-enter">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Powtarzalność ponad perfekcję</span>
          <h1>Codzienny rytm</h1>
          <p>Małe działania, które z czasem robią dużą różnicę.</p>
        </div>
        <button className="button button--primary" type="button" onClick={() => setAddOpen(true)}>
          <Plus size={17} /> Nowy rytuał
        </button>
      </header>

      <section className="habit-hero">
        <div className="habit-hero__message">
          <span>
            <Sparkles size={17} />
          </span>
          <div>
            <small>Ten tydzień</small>
            <h2>
              {consistency >= 70 ? "Dobry rytm — tak trzymaj" : "Liczy się następny mały krok"}
            </h2>
            <p>Nie musisz nadrabiać wczoraj. Zadbaj o jedną rzecz dzisiaj.</p>
          </div>
        </div>
        <div className="habit-score">
          <div style={{ "--progress": `${consistency * 3.6}deg` } as React.CSSProperties}>
            <strong>{consistency}%</strong>
          </div>
          <span>regularności</span>
        </div>
      </section>

      <section className="panel habit-week-panel">
        <header className="panel__header">
          <div>
            <span className="section-kicker">
              <Flame size={14} /> Ostatnie 7 dni
            </span>
            <h2>Twój tydzień</h2>
          </div>
          <span className="habit-today-count">
            Dzisiaj {todayDone}/{habits.length}
          </span>
        </header>
        <div className="habit-week-scroll">
          <div className="habit-week-grid" style={{ "--days": days.length } as React.CSSProperties}>
            <div className="habit-grid-corner">Rytuał</div>
            {days.map((day) => (
              <div
                className={
                  dateKey(day) === today ? "habit-day-head habit-day-head--today" : "habit-day-head"
                }
                key={dateKey(day)}
              >
                <span>{formatDayName(day)}</span>
                <strong>{format(day, "d")}</strong>
              </div>
            ))}
            {habits.map((habit) => {
              const Icon = icons[habit.icon];
              const recentStreak = calculateStreak(habit);
              return [
                <div className="habit-name-cell" key={`${habit.id}-name`}>
                  <span>
                    <Icon size={18} />
                  </span>
                  <div>
                    <strong>
                      {habit.name}
                      {habit.visibility === "private" && (
                        <span className="private-badge">
                          <Lock size={10} /> Prywatne
                        </span>
                      )}
                    </strong>
                    <small>
                      {habit.targetLabel} · seria {recentStreak}
                    </small>
                  </div>
                  <button
                    className="habit-delete"
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(`Usunąć rytuał „${habit.name}” wraz z całą historią serii?`)
                      ) {
                        deleteHabit(habit.id);
                        onToast("Rytuał usunięty");
                      }
                    }}
                    aria-label={`Usuń rytuał ${habit.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>,
                ...days.map((day) => {
                  const key = dateKey(day);
                  const done = habit.completedDates.includes(key);
                  return (
                    <button
                      className={done ? "habit-day-cell habit-day-cell--done" : "habit-day-cell"}
                      type="button"
                      key={`${habit.id}-${key}`}
                      onClick={() => toggleHabit(habit.id, key)}
                      aria-label={`${habit.name}, ${format(day, "EEEE d MMMM", { locale: pl })}: ${done ? "wykonane" : "niewykonane"}`}
                    >
                      {done && <Check size={16} strokeWidth={3} />}
                    </button>
                  );
                }),
              ];
            })}
          </div>
        </div>
      </section>

      <div className="habit-insights">
        <article>
          <span className="insight-number">{totalChecks}</span>
          <div>
            <strong>małych zwycięstw</strong>
            <p>w ostatnich siedmiu dniach</p>
          </div>
        </article>
        <article>
          <span className="insight-icon">
            <Flame size={21} />
          </span>
          <div>
            <strong>Najlepsza seria: {Math.max(0, ...habits.map(calculateStreak))} dni</strong>
            <p>Regularność lubi prostotę.</p>
          </div>
        </article>
        <article>
          <span className="insight-icon insight-icon--leaf">
            <Leaf size={21} />
          </span>
          <div>
            <strong>Bez kar za przerwę</strong>
            <p>Jutro to zawsze nowy początek.</p>
          </div>
        </article>
      </div>

      <AddHabitModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        ownerId={currentOwnerId}
        onAdd={(habit) => {
          addHabit(habit);
          setAddOpen(false);
          onToast("Nowy rytuał dodany");
        }}
      />
    </div>
  );
}

function calculateStreak(habit: Habit): number {
  let streak = 0;
  for (let offset = 0; offset < 365; offset += 1) {
    const key = dateKey(addDays(new Date(), -offset));
    if (habit.completedDates.includes(key)) streak += 1;
    else if (offset > 0 || habit.completedDates.length) break;
  }
  return streak;
}

function AddHabitModal({
  open,
  onClose,
  ownerId,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  ownerId: string;
  onAdd: (habit: Omit<Habit, "id" | "completedDates" | "updatedAt" | "version">) => void;
}) {
  const [name, setName] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [icon, setIcon] = useState<Habit["icon"]>("walk");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAdd({
      name: name.trim(),
      targetLabel: targetLabel.trim() || "raz dziennie",
      icon,
      visibility,
      ownerId,
    });
    setName("");
    setTargetLabel("");
    setVisibility("private");
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Dodaj mały rytuał"
      eyebrow="Codzienny rytm"
      size="small"
    >
      <form className="edit-form" onSubmit={submit}>
        <label className="field field--prominent">
          <span>Nazwa</span>
          <input
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Np. Poranny spacer"
          />
        </label>
        <label className="field">
          <span>Cel</span>
          <input
            value={targetLabel}
            onChange={(event) => setTargetLabel(event.target.value)}
            placeholder="Np. 20 minut"
          />
        </label>
        <label className="field">
          <span>Widoczność</span>
          <select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as Visibility)}
          >
            <option value="private">Tylko ja</option>
            <option value="household">Cały dom</option>
          </select>
        </label>
        <fieldset className="habit-icon-picker">
          <legend>Ikona</legend>
          {(Object.keys(icons) as Habit["icon"][]).map((value) => {
            const Icon = icons[value];
            return (
              <button
                className={icon === value ? "active" : ""}
                type="button"
                key={value}
                onClick={() => setIcon(value)}
                aria-label={`Ikona: ${value}`}
                aria-pressed={icon === value}
              >
                <Icon size={19} />
              </button>
            );
          })}
        </fieldset>
        <footer className="modal-actions">
          <div />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Dodaj rytuał
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
