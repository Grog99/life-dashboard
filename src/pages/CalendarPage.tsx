import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Lock,
  MapPin,
  Plus,
  Repeat,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { addWeeks, format, isSameDay, parseISO } from "date-fns";
import { pl } from "date-fns/locale";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { dateKey, formatDayName, relativeDay, weekDays } from "../lib/date";
import { RecurrenceFields, useRecurrenceForm } from "../components/RecurrenceFields";
import { useLifeRecordsStore } from "../store/useLifeRecordsStore";
import { useLifeStore } from "../store/useLifeStore";
import { useServerAuth } from "../server/AuthGate";
import type { Visibility } from "../advancedTypes";
import type { CalendarEvent, EventKind } from "../types";
import { apiRequest, serverMode } from "../server/api";

interface CalendarPageProps {
  onQuickAdd: () => void;
  onToast: (message: string) => void;
}

// Kalendarz pokazuje WYŁĄCZNIE wydarzenia -- zadania nie mają już `date`/`time`
// (docs/plans/zadania-redefinicja.md "CalendarPage"), więc nie mogą się tu pojawić ani w siatce
// tygodnia, ani w agendzie dnia. Edycja zadań przeniosła się w całości do `TasksPage`.
export function CalendarPage({ onQuickAdd, onToast }: CalendarPageProps) {
  const events = useLifeRecordsStore((state) => state.events);
  const preferences = useLifeStore((state) => state.preferences);
  const updateEvent = useLifeRecordsStore((state) => state.updateEvent);
  const deleteEvent = useLifeRecordsStore((state) => state.deleteEvent);
  const addEvent = useLifeRecordsStore((state) => state.addEvent);
  const updateEventSeries = useLifeRecordsStore((state) => state.updateEventSeries);
  const deleteEventSeries = useLifeRecordsStore((state) => state.deleteEventSeries);
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const [googleSyncing, setGoogleSyncing] = useState(false);
  const [anchor, setAnchor] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(dateKey());
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const weekOverviewRef = useRef<HTMLDivElement>(null);
  const days = useMemo(
    () => weekDays(anchor, preferences.weekStartsOnMonday),
    [anchor, preferences.weekStartsOnMonday],
  );

  useEffect(() => {
    const selected = weekOverviewRef.current?.querySelector<HTMLElement>(".week-day--selected");
    selected?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [days, selectedDate]);

  const changeWeek = (amount: number) => {
    setAnchor((value) => addWeeks(value, amount));
    setSelectedDate((value) => dateKey(addWeeks(parseISO(value), amount)));
  };

  const selectToday = () => {
    const today = new Date();
    setAnchor(today);
    setSelectedDate(dateKey(today));
  };

  const syncGoogle = async () => {
    setGoogleSyncing(true);
    try {
      const result = await apiRequest<{
        events: Array<{
          externalId: string;
          title: string;
          start?: string;
          end?: string;
          location?: string;
          status?: string;
          updatedAt?: string;
        }>;
      }>("/api/v1/integrations/google/sync", { method: "POST", json: {}, timeoutMs: 180_000 });
      let added = 0;
      let updated = 0;
      let removed = 0;
      result.events.forEach((item) => {
        const existing = useLifeRecordsStore
          .getState()
          .events.find(
            (event) => event.source === "google" && event.externalId === item.externalId,
          );
        if (item.status === "cancelled") {
          if (existing) {
            deleteEvent(existing.id);
            removed += 1;
          }
          return;
        }
        if (!item.start) return;
        const date = item.start.slice(0, 10);
        const startTime = item.start.includes("T") ? item.start.slice(11, 16) : "09:00";
        const endTime = item.end?.includes("T") ? item.end.slice(11, 16) : "10:00";
        const changes = {
          title: item.title,
          date,
          startTime,
          endTime,
          kind: "meeting" as const,
          location: item.location,
          source: "google" as const,
          externalId: item.externalId,
          externalUpdatedAt: item.updatedAt,
        };
        if (existing) {
          updateEvent(existing.id, changes);
          updated += 1;
        } else {
          addEvent({ ...changes, visibility: "private", ownerId: currentOwnerId });
          added += 1;
        }
      });
      onToast(
        `Google Calendar: ${added} nowych · ${updated} zaktualizowanych${removed ? ` · ${removed} usuniętych` : ""}`,
      );
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Nie udało się zsynchronizować kalendarza");
    } finally {
      setGoogleSyncing(false);
    }
  };

  const selectedEvents = events
    .filter((event) => event.date === selectedDate)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  return (
    <div className="calendar-page page-enter">
      <header className="page-header calendar-header">
        <div>
          <span className="page-eyebrow">Czas pod kontrolą</span>
          <h1>Kalendarz</h1>
          <p>Zobacz cały tydzień i zostaw trochę miejsca na niespodziewane.</p>
        </div>
        <div className="page-header__actions">
          {serverMode && (
            <button
              className="button button--ghost-border"
              type="button"
              onClick={() => void syncGoogle()}
              disabled={googleSyncing}
            >
              <RefreshCw size={16} className={googleSyncing ? "spin" : ""} /> Google
            </button>
          )}
          <button className="button button--primary" type="button" onClick={onQuickAdd}>
            <Plus size={17} /> Nowe wydarzenie
          </button>
        </div>
      </header>

      <section className="calendar-shell panel">
        <header className="calendar-toolbar">
          <div className="calendar-toolbar__month">
            <button
              className="icon-button"
              type="button"
              onClick={() => changeWeek(-1)}
              aria-label="Poprzedni tydzień"
            >
              <ChevronLeft size={20} />
            </button>
            <div>
              <strong>{format(anchor, "LLLL yyyy", { locale: pl })}</strong>
              <span>Tydzień {format(anchor, "w")}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => changeWeek(1)}
              aria-label="Następny tydzień"
            >
              <ChevronRight size={20} />
            </button>
          </div>
          <button className="button button--soft button--small" type="button" onClick={selectToday}>
            Dzisiaj
          </button>
        </header>

        <div className="week-overview" ref={weekOverviewRef}>
          {days.map((day) => {
            const dayKey = dateKey(day);
            const dayEvents = events
              .filter((event) => event.date === dayKey)
              .sort((a, b) => a.startTime.localeCompare(b.startTime));
            const selected = dayKey === selectedDate;
            const today = isSameDay(day, new Date());
            return (
              <div
                className={`week-day ${selected ? "week-day--selected" : ""} ${today ? "week-day--today" : ""}`}
                key={dayKey}
              >
                <button
                  className="week-day__header"
                  type="button"
                  onClick={() => setSelectedDate(dayKey)}
                  aria-pressed={selected}
                >
                  <span>{formatDayName(day)}</span>
                  <strong>{format(day, "d")}</strong>
                  {today && <small>dziś</small>}
                </button>
                <div className="week-day__events">
                  {dayEvents.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`week-event week-event--${item.kind}`}
                      aria-label={`${item.startTime} ${item.title}, ${item.kind === "meeting" ? "spotkanie" : item.kind === "focus" ? "blok skupienia" : "prywatne"}${item.seriesId ? ", powtarzalne" : ""}`}
                      onClick={() => {
                        setSelectedDate(dayKey);
                        setEditingEvent(item);
                      }}
                    >
                      <time>{item.startTime}</time>
                      <strong>{item.title}</strong>
                      {item.seriesId && (
                        <Repeat size={11} className="series-icon" aria-hidden="true" />
                      )}
                      {item.visibility === "private" && (
                        <span className="private-badge">
                          <Lock size={10} /> Prywatne
                        </span>
                      )}
                    </button>
                  ))}
                  {!dayEvents.length && <span className="week-day__empty">—</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="calendar-lower-grid">
        <section className="panel day-agenda">
          <header className="panel__header">
            <div>
              <span className="section-kicker">
                <CalendarDays size={14} /> Wybrany dzień
              </span>
              <h2>{relativeDay(selectedDate)}</h2>
            </div>
            <span className="date-badge">
              {format(parseISO(selectedDate), "d MMMM", { locale: pl })}
            </span>
          </header>
          <div className="day-agenda__list">
            {selectedEvents.map((event) => (
              <button
                className={`agenda-event agenda-event--${event.kind}`}
                type="button"
                key={event.id}
                onClick={() => setEditingEvent(event)}
              >
                <span className="agenda-event__time">
                  {event.startTime}
                  <small>{event.endTime}</small>
                </span>
                <span className="agenda-event__line" />
                <span className="agenda-event__content">
                  <strong>{event.title}</strong>
                  {event.seriesId && (
                    <Repeat
                      size={12}
                      className="series-icon"
                      role="img"
                      aria-label="Wydarzenie powtarzalne"
                    />
                  )}
                  {event.visibility === "private" && (
                    <small className="private-badge">
                      <Lock size={11} /> Prywatne
                    </small>
                  )}
                  {event.location && (
                    <small>
                      <MapPin size={13} /> {event.location}
                    </small>
                  )}
                </span>
                <ChevronRight size={17} />
              </button>
            ))}
            {!selectedEvents.length && (
              <EmptyState
                icon={CalendarDays}
                title="Dzień bez planu"
                description="Zostaw go wolnym albo dodaj rzecz, dla której warto zarezerwować czas."
                action="Dodaj wydarzenie"
                onAction={onQuickAdd}
              />
            )}
          </div>
        </section>

        <aside className="calendar-tip">
          <div className="calendar-tip__icon">
            <Clock3 size={20} />
          </div>
          <span>Wskazówka</span>
          <h3>Planuj tylko 60–70% dnia</h3>
          <p>Bufor między blokami chroni plan przed jednym opóźnionym spotkaniem.</p>
          <div className="calendar-tip__arrows">
            <ArrowLeft size={16} />
            <span>miejsce na oddech</span>
            <ArrowRight size={16} />
          </div>
        </aside>
      </div>

      <EventEditModal
        event={editingEvent}
        onClose={() => setEditingEvent(null)}
        onSave={(changes) => {
          if (!editingEvent) return;
          updateEvent(editingEvent.id, changes);
          setEditingEvent(null);
          onToast("Wydarzenie zaktualizowane");
        }}
        onDelete={() => {
          if (!editingEvent) return;
          deleteEvent(editingEvent.id);
          setEditingEvent(null);
          onToast("Wydarzenie usunięte");
        }}
        onSaveSeries={(changes) => {
          if (!editingEvent?.seriesId) return;
          updateEventSeries(editingEvent.seriesId, changes);
          setEditingEvent(null);
          onToast("Zmiany zapisane dla całej serii");
        }}
        onDeleteSeries={() => {
          if (!editingEvent?.seriesId) return;
          deleteEventSeries(editingEvent.seriesId);
          setEditingEvent(null);
          onToast("Cała seria wydarzeń usunięta");
        }}
        onToast={onToast}
      />
    </div>
  );
}

interface EventEditModalProps {
  event: CalendarEvent | null;
  onClose: () => void;
  onSave: (changes: Partial<CalendarEvent>) => void;
  onDelete: () => void;
  onSaveSeries: (changes: Partial<CalendarEvent>) => void;
  onDeleteSeries: () => void;
  onToast: (message: string) => void;
}

function EventEditModal({
  event,
  onClose,
  onSave,
  onDelete,
  onSaveSeries,
  onDeleteSeries,
  onToast,
}: EventEditModalProps) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [location, setLocation] = useState("");
  const [kind, setKind] = useState<EventKind>("personal");
  const [notes, setNotes] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("household");
  const repeat = useRecurrenceForm(event?.recurrence);

  useEffect(() => {
    if (!event) return;
    setTitle(event.title);
    setDate(event.date);
    setStartTime(event.startTime);
    setEndTime(event.endTime);
    setLocation(event.location ?? "");
    setKind(event.kind);
    setNotes(event.notes ?? "");
    setVisibility(event.visibility ?? "household");
    repeat.reset(event.recurrence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  const buildChanges = (): Partial<CalendarEvent> => ({
    title: title.trim(),
    date,
    startTime,
    endTime,
    kind,
    location: location.trim() || undefined,
    notes: notes.trim() || undefined,
    visibility,
  });

  const submit = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (!date || !startTime || !endTime || endTime <= startTime) {
      onToast("Sprawdź datę i kolejność godzin wydarzenia");
      return;
    }
    onSave(buildChanges());
  };

  const submitSeries = () => {
    if (!event?.recurrence) return;
    if (!title.trim()) {
      onToast("Podaj nazwę wydarzenia");
      return;
    }
    if (!date || !startTime || !endTime || endTime <= startTime) {
      onToast("Sprawdź datę i kolejność godzin wydarzenia");
      return;
    }
    // Zachowujemy anchorDate serii, ale anchorTime bierzemy z aktualnego pola „Od",
    // aby edycja godziny serii faktycznie się zapisała (fix z code review).
    onSaveSeries({
      ...buildChanges(),
      recurrence: repeat.build(event.recurrence.anchorDate, startTime),
    });
  };

  return (
    <Modal open={Boolean(event)} onClose={onClose} title="Edytuj wydarzenie" eyebrow="Kalendarz">
      <form className="edit-form" onSubmit={submit}>
        {event?.seriesId && (
          <p className="series-edit-note">
            <Repeat size={13} role="img" aria-label="Wydarzenie powtarzalne" /> To wydarzenie jest
            częścią serii. „Zapisz” dotyczy tylko tego wystąpienia — użyj „Zapisz dla całej serii”,
            aby zmienić przyszłe wystąpienia.
          </p>
        )}
        <label className="field field--prominent">
          <span>Nazwa</span>
          <input
            autoFocus
            required
            value={title}
            onChange={(input) => setTitle(input.target.value)}
          />
        </label>
        <div className="form-grid form-grid--3">
          <label className="field">
            <span>Data</span>
            <input
              required
              type="date"
              value={date}
              onChange={(input) => setDate(input.target.value)}
            />
          </label>
          <label className="field">
            <span>Od</span>
            <input
              required
              type="time"
              value={startTime}
              onChange={(input) => setStartTime(input.target.value)}
            />
          </label>
          <label className="field">
            <span>Do</span>
            <input
              required
              min={startTime}
              type="time"
              value={endTime}
              onChange={(input) => setEndTime(input.target.value)}
            />
          </label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Rodzaj</span>
            <select value={kind} onChange={(input) => setKind(input.target.value as EventKind)}>
              <option value="personal">Prywatne</option>
              <option value="meeting">Spotkanie</option>
              <option value="focus">Skupienie</option>
            </select>
          </label>
          <label className="field">
            <span>Miejsce</span>
            <input
              value={location}
              onChange={(input) => setLocation(input.target.value)}
              placeholder="Opcjonalnie"
            />
          </label>
        </div>
        <label className="field">
          <span>Widoczność</span>
          <select
            value={visibility}
            onChange={(input) => setVisibility(input.target.value as Visibility)}
          >
            <option value="household">Cały dom</option>
            <option value="private">Tylko ja</option>
          </select>
        </label>
        <label className="field">
          <span>Notatka</span>
          <textarea
            value={notes}
            onChange={(input) => setNotes(input.target.value)}
            placeholder="Szczegóły, link, przygotowanie…"
          />
        </label>

        {event?.seriesId && <RecurrenceFields form={repeat} />}

        <footer className="modal-actions modal-actions--spread">
          <div>
            <button className="button button--danger-ghost" type="button" onClick={onDelete}>
              <Trash2 size={15} /> Usuń
            </button>
            {event?.seriesId && (
              <button
                className="button button--danger-ghost"
                type="button"
                onClick={() => {
                  if (
                    window.confirm("Usunąć całą serię wydarzeń, wraz z przyszłymi wystąpieniami?")
                  )
                    onDeleteSeries();
                }}
              >
                <Trash2 size={15} /> Usuń serię
              </button>
            )}
          </div>
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Zapisz
            </button>
            {event?.seriesId && (
              <button className="button button--soft" type="button" onClick={submitSeries}>
                <Repeat size={14} /> Zapisz dla całej serii
              </button>
            )}
          </div>
        </footer>
      </form>
    </Modal>
  );
}
