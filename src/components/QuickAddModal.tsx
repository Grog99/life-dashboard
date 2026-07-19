import {
  BellRing,
  CalendarPlus,
  CheckSquare2,
  Lightbulb,
  NotebookPen,
  Repeat,
  Sparkles,
  Star,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { addHours, format, getISODay, parseISO } from "date-fns";
import { Modal } from "./Modal";
import { TagsInput } from "./TagsInput";
import { dateKey, formatShortDate } from "../lib/date";
import { alignWeeklyAnchor, nextOccurrences } from "../lib/recurrence";
import { RecurrenceFields, useRecurrenceForm } from "./RecurrenceFields";
import { parseSmartCapture } from "../lib/smartCapture";
import { useLifeRecordsStore } from "../store/useLifeRecordsStore";
import { useServerAuth } from "../server/AuthGate";
import type { Visibility } from "../advancedTypes";
import type { Energy, EventKind, NoteColor, Priority, QuickAddType, Recurrence } from "../types";

interface QuickAddModalProps {
  open: boolean;
  onClose: () => void;
  initialType?: QuickAddType;
  onAdded?: (message: string) => void;
}

const addTypes = [
  { id: "task" as const, label: "Zadanie", icon: CheckSquare2 },
  { id: "event" as const, label: "Wydarzenie", icon: CalendarPlus },
  { id: "reminder" as const, label: "Przypomnienie", icon: BellRing },
  { id: "note" as const, label: "Notatka", icon: NotebookPen },
];

export function QuickAddModal({
  open,
  onClose,
  initialType = "task",
  onAdded,
}: QuickAddModalProps) {
  const addTask = useLifeRecordsStore((state) => state.addTask);
  const addEvent = useLifeRecordsStore((state) => state.addEvent);
  const addReminder = useLifeRecordsStore((state) => state.addReminder);
  const addNote = useLifeRecordsStore((state) => state.addNote);
  const addRecurringEvent = useLifeRecordsStore((state) => state.addRecurringEvent);
  const existingTasks = useLifeRecordsStore((state) => state.tasks);
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";

  const existingTags = useMemo(() => {
    const unique = new Set<string>();
    existingTasks.forEach((task) => task.tags.forEach((tag) => unique.add(tag)));
    return Array.from(unique).sort((a, b) => a.localeCompare(b, "pl"));
  }, [existingTasks]);

  const [type, setType] = useState<QuickAddType>(initialType);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(dateKey());
  const [time, setTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>("medium");
  const [energy, setEnergy] = useState<Energy>("medium");
  const [kind, setKind] = useState<EventKind>("personal");
  const [location, setLocation] = useState("");
  const [noteColor, setNoteColor] = useState<NoteColor>("cream");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [isFocus, setIsFocus] = useState(false);
  const [dateEditedManually, setDateEditedManually] = useState(false);
  const [timeEditedManually, setTimeEditedManually] = useState(false);
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const repeat = useRecurrenceForm();

  useEffect(() => {
    if (!open) return;
    const nextHour = addHours(new Date(), 1);
    setType(initialType);
    setTitle("");
    setDate(dateKey(nextHour));
    setTime(format(nextHour, "HH:00"));
    setEndTime(format(addHours(new Date(), 2), "HH:00"));
    setTags([]);
    setPriority("medium");
    setEnergy("medium");
    setKind("personal");
    setLocation("");
    setNoteColor("cream");
    setVisibility("private");
    setIsFocus(false);
    setDateEditedManually(false);
    setTimeEditedManually(false);
    setRepeatEnabled(false);
    repeat.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `repeat` (z useRecurrenceForm) jest nowym obiektem co render; efekt ma resetować formularz tylko przy otwarciu/zmianie typu, nie przy każdym renderze.
  }, [initialType, open]);

  // Smart capture uzupełnia datę/godzinę TYLKO dla wydarzeń/przypomnień -- zadania nie mają już
  // terminu (docs/plans/zadania-redefinicja.md), więc `parsed.date`/`parsed.time` są dla nich
  // ignorowane (używamy tylko `parsed.title` przy zapisie, patrz `submit`).
  useEffect(() => {
    if (!open || (type !== "event" && type !== "reminder")) return;
    const parsed = parseSmartCapture(title);
    if (parsed.date && !dateEditedManually) setDate(parsed.date);
    if (parsed.time && !timeEditedManually) setTime(parsed.time);
  }, [title, type, open, dateEditedManually, timeEditedManually]);

  const handleDateChange = (value: string) => {
    setDate(value);
    setDateEditedManually(true);
  };
  const handleTimeChange = (value: string) => {
    setTime(value);
    setTimeEditedManually(true);
  };

  const buildRecurrence = (anchorDateRaw: string, anchorTime?: string): Recurrence => {
    const recurrence = repeat.build(anchorDateRaw, anchorTime);
    return recurrence.weekdays
      ? { ...recurrence, anchorDate: alignWeeklyAnchor(anchorDateRaw, recurrence.weekdays) }
      : recurrence;
  };

  const repeatPreview =
    repeatEnabled && type === "event" ? nextOccurrences(buildRecurrence(date || dateKey()), 4) : [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;

    const parsed = parseSmartCapture(title);

    if (type === "task") {
      addTask({
        title: parsed.title,
        priority,
        tags,
        isFocus,
        energy,
        visibility,
        ownerId: currentOwnerId,
      });
      onAdded?.("Zadanie trafiło na listę");
    } else if (type === "event") {
      if (!date || !time || !endTime || endTime <= time) {
        onAdded?.("Sprawdź datę i kolejność godzin wydarzenia");
        return;
      }
      if (repeatEnabled) {
        const recurrence = buildRecurrence(date, time);
        addRecurringEvent(
          {
            title: parsed.title,
            date,
            startTime: time,
            endTime,
            kind,
            location: location.trim() || undefined,
            visibility,
            ownerId: currentOwnerId,
          },
          recurrence,
        );
        onAdded?.("Seria wydarzeń utworzona");
      } else {
        addEvent({
          title: parsed.title,
          date,
          startTime: time,
          endTime,
          kind,
          location: location.trim() || undefined,
          visibility,
          ownerId: currentOwnerId,
        });
        onAdded?.("Wydarzenie dodane do kalendarza");
      }
    } else if (type === "reminder") {
      if (!date || !time) {
        onAdded?.("Uzupełnij datę i godzinę przypomnienia");
        return;
      }
      addReminder({ title: parsed.title, date, time, visibility, ownerId: currentOwnerId });
      onAdded?.("Przypomnienie jest ustawione");
    } else {
      addNote({
        title: title.trim(),
        content: "",
        color: noteColor,
        pinned: false,
        visibility,
        ownerId: currentOwnerId,
      });
      onAdded?.("Notatka została utworzona");
    }
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Zapisz, zanim ucieknie" eyebrow="Szybkie dodawanie">
      <div className="quick-add-tabs" role="group" aria-label="Typ nowego elementu">
        {addTypes.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={type === item.id ? "active" : ""}
              type="button"
              aria-pressed={type === item.id}
              onClick={() => setType(item.id)}
            >
              <Icon size={16} /> {item.label}
            </button>
          );
        })}
      </div>

      <form className="quick-add-form" onSubmit={submit}>
        <label className="field field--prominent">
          <span>{type === "note" ? "Tytuł notatki" : "Co chcesz zapisać?"}</span>
          <input
            autoFocus
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={
              type === "task"
                ? "Np. Zadzwonić do dentysty"
                : type === "event"
                  ? "Np. Spotkanie z Kasią"
                  : type === "reminder"
                    ? "Np. Odebrać przesyłkę"
                    : "Np. Pomysł na wakacje"
            }
          />
        </label>

        {(type === "event" || type === "reminder") && (
          <div className="smart-hint">
            <Sparkles size={14} />
            Rozumiem frazy „dzisiaj”, „jutro” i godziny, np. „o 16:30”.
          </div>
        )}

        {(type === "event" || type === "reminder") && (
          <div className="form-grid form-grid--3">
            <label className="field">
              <span>Data</span>
              <input
                required
                type="date"
                value={date}
                onChange={(event) => handleDateChange(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{type === "event" ? "Od" : "Godzina"}</span>
              <input
                required
                type="time"
                value={time}
                onChange={(event) => handleTimeChange(event.target.value)}
              />
            </label>
            {type === "event" && (
              <label className="field">
                <span>Do</span>
                <input
                  required
                  min={time}
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                />
              </label>
            )}
          </div>
        )}

        {type === "event" && (
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Rodzaj</span>
              <select value={kind} onChange={(event) => setKind(event.target.value as EventKind)}>
                <option value="personal">Prywatne</option>
                <option value="meeting">Spotkanie</option>
                <option value="focus">Blok skupienia</option>
              </select>
            </label>
            <label className="field">
              <span>Miejsce / link</span>
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Opcjonalnie"
              />
            </label>
          </div>
        )}

        {type === "task" && (
          <>
            <label className="check-field">
              <input
                type="checkbox"
                checked={isFocus}
                onChange={(event) => setIsFocus(event.target.checked)}
              />
              <span>
                <Star size={16} />
                <strong>Zadanie priorytetowe</strong>
                <small>Trafi do sekcji „Najważniejsze dzisiaj".</small>
              </span>
            </label>
            <label className="field">
              <span>Tagi</span>
              <TagsInput
                value={tags}
                onChange={setTags}
                suggestions={existingTags}
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
                <span>Potrzebna energia</span>
                <select
                  value={energy}
                  onChange={(event) => setEnergy(event.target.value as Energy)}
                >
                  <option value="low">Mała</option>
                  <option value="medium">Średnia</option>
                  <option value="high">Duża</option>
                </select>
              </label>
            </div>
          </>
        )}

        {type === "event" && (
          <>
            <label className="check-field">
              <input
                type="checkbox"
                checked={repeatEnabled}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setRepeatEnabled(checked);
                  if (checked && repeat.weekdays.length === 0) {
                    const anchor = date || dateKey();
                    repeat.setWeekdays([getISODay(parseISO(anchor))]);
                  }
                }}
              />
              <span>
                <Repeat size={16} />
                <strong>Powtarzaj</strong>
                <small>Utworzy serię kolejnych wystąpień.</small>
              </span>
            </label>

            {repeatEnabled && (
              <>
                <RecurrenceFields form={repeat} />
                {repeatPreview.length > 0 && (
                  <p className="repeat-preview">
                    Najbliższe: {repeatPreview.map((value) => formatShortDate(value)).join(", ")}
                  </p>
                )}
              </>
            )}
          </>
        )}

        {type === "note" && (
          <fieldset className="color-picker">
            <legend>Kolor notatki</legend>
            {(["cream", "mint", "sky", "lilac"] as NoteColor[]).map((color) => (
              <button
                type="button"
                key={color}
                className={`note-swatch note-swatch--${color} ${noteColor === color ? "active" : ""}`}
                onClick={() => setNoteColor(color)}
                aria-label={`Kolor ${color}`}
                aria-pressed={noteColor === color}
              />
            ))}
          </fieldset>
        )}

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

        <footer className="modal-actions">
          <span className="keyboard-hint">
            <Lightbulb size={14} /> Enter zapisuje
          </span>
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              {type === "task"
                ? "Dodaj zadanie"
                : type === "event"
                  ? repeatEnabled
                    ? "Utwórz serię wydarzeń"
                    : "Dodaj do kalendarza"
                  : type === "reminder"
                    ? "Ustaw przypomnienie"
                    : "Utwórz notatkę"}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
