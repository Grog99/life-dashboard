import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { addDays, format } from "date-fns";
import { z } from "zod";
import { createSampleData } from "../data/sampleData";
import {
  energySchema,
  eventSchema,
  habitSchema,
  noteSchema,
  preferencesSchema,
  reminderSchema,
  taskSchema,
} from "../lib/schema";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { generateId as id } from "../lib/id";
import { addMinutesToTime, dateKey, durationMinutes } from "../lib/date";
import { expandSeries, occurrenceDate, SERIES_WINDOW } from "../lib/recurrence";
import type {
  CalendarEvent,
  Energy,
  Habit,
  LifeData,
  Note,
  Preferences,
  Recurrence,
  Reminder,
  Task,
} from "../types";

const STORAGE_NAME = "puls-life-dashboard";

function parseArrayField<T>(value: unknown, schema: z.ZodType<T>): { items: T[]; dropped: number } {
  if (value === undefined) return { items: [], dropped: 0 };
  if (!Array.isArray(value)) return { items: [], dropped: 1 };
  let dropped = 0;
  const items: T[] = [];
  for (const raw of value) {
    const result = schema.safeParse(raw);
    if (result.success) items.push(result.data);
    else dropped += 1;
  }
  return { items, dropped };
}

function parseScalarField<T>(value: unknown, schema: z.ZodType<T>, fallback: T): { value: T; dropped: number } {
  if (value === undefined) return { value: fallback, dropped: 0 };
  const result = schema.safeParse(value);
  return result.success ? { value: result.data, dropped: 0 } : { value: fallback, dropped: 1 };
}

interface LifeActions {
  addTask: (task: Omit<Task, "id" | "createdAt" | "updatedAt" | "status">) => string;
  updateTask: (taskId: string, changes: Partial<Task>) => void;
  toggleTask: (taskId: string) => void;
  toggleFocus: (taskId: string) => boolean;
  deleteTask: (taskId: string) => void;
  moveTaskToTomorrow: (taskId: string) => void;
  addRecurringTask: (task: Omit<Task, "id" | "createdAt" | "updatedAt" | "status">, recurrence: Recurrence) => string;
  updateSeries: (seriesId: string, changes: Partial<Task>) => void;
  deleteSeries: (seriesId: string) => void;
  addEvent: (event: Omit<CalendarEvent, "id" | "updatedAt">) => string;
  updateEvent: (eventId: string, changes: Partial<CalendarEvent>) => void;
  deleteEvent: (eventId: string) => void;
  addRecurringEvent: (event: Omit<CalendarEvent, "id" | "updatedAt">, recurrence: Recurrence) => string;
  updateEventSeries: (seriesId: string, changes: Partial<CalendarEvent>) => void;
  deleteEventSeries: (seriesId: string) => void;
  expandRecurringSeries: () => void;
  addReminder: (reminder: Omit<Reminder, "id" | "done" | "updatedAt">) => string;
  toggleReminder: (reminderId: string) => void;
  snoozeReminder: (reminderId: string, minutes: number) => void;
  deleteReminder: (reminderId: string) => void;
  markReminderNotified: (reminderId: string) => void;
  addNote: (note: Omit<Note, "id" | "createdAt" | "updatedAt">) => string;
  updateNote: (noteId: string, changes: Partial<Note>) => void;
  deleteNote: (noteId: string) => void;
  toggleHabit: (habitId: string, date: string) => void;
  addHabit: (habit: Omit<Habit, "id" | "completedDates" | "updatedAt">) => void;
  deleteHabit: (habitId: string) => void;
  setScratchpad: (value: string) => void;
  setIntention: (value: string) => void;
  setEnergy: (value: Energy) => void;
  updatePreferences: (changes: Partial<Preferences>) => void;
  replaceData: (data: LifeData) => void;
  resetData: () => void;
}

export type LifeStore = LifeData & LifeActions;

const initial = createSampleData();

export const useLifeStore = create<LifeStore>()(
  persist(
    (set, get) => ({
      ...initial,
      addTask: (task) => {
        const taskId = id();
        const timestamp = new Date().toISOString();
        set((state) => ({
          tasks: [
            {
              ...task,
              id: taskId,
              status: "todo",
              createdAt: timestamp,
              updatedAt: timestamp,
              visibility: task.visibility ?? "private",
              ownerId: task.ownerId ?? "me",
            },
            ...state.tasks,
          ],
        }));
        return taskId;
      },
      updateTask: (taskId, changes) =>
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId ? { ...task, ...changes, updatedAt: new Date().toISOString() } : task,
          ),
        })),
      toggleTask: (taskId) =>
        set((state) => ({
          tasks: state.tasks.map((task) => {
            if (task.id !== taskId) return task;
            const done = task.status !== "done";
            const focusDay = task.date ?? format(new Date(), "yyyy-MM-dd");
            const focusCount = state.tasks.filter(
              (item) =>
                item.id !== taskId &&
                item.isFocus &&
                item.status !== "done" &&
                (item.date ?? format(new Date(), "yyyy-MM-dd")) === focusDay,
            ).length;
            return {
              ...task,
              status: done ? "done" : "todo",
              isFocus: !done && task.isFocus && focusCount >= 3 ? false : task.isFocus,
              completedAt: done ? new Date().toISOString() : undefined,
              updatedAt: new Date().toISOString(),
            };
          }),
        })),
      toggleFocus: (taskId) => {
        const task = get().tasks.find((item) => item.id === taskId);
        if (!task) return false;
        const focusDay = task.date ?? format(new Date(), "yyyy-MM-dd");
        const focusCount = get().tasks.filter(
          (item) =>
            item.isFocus &&
            item.status !== "done" &&
            (item.date ?? format(new Date(), "yyyy-MM-dd")) === focusDay,
        ).length;
        if (!task.isFocus && focusCount >= 3) return false;
        set((state) => ({
          tasks: state.tasks.map((item) =>
            item.id === taskId ? { ...item, isFocus: !item.isFocus, updatedAt: new Date().toISOString() } : item,
          ),
        }));
        return true;
      },
      deleteTask: (taskId) =>
        set((state) => ({ tasks: state.tasks.filter((task) => task.id !== taskId) })),
      moveTaskToTomorrow: (taskId) =>
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? { ...task, date: format(addDays(new Date(), 1), "yyyy-MM-dd"), updatedAt: new Date().toISOString() }
              : task,
          ),
        })),
      addRecurringTask: (task, recurrence) => {
        const seriesId = id();
        const timestamp = new Date().toISOString();
        const windowCount = recurrence.count !== undefined ? Math.min(SERIES_WINDOW, recurrence.count) : SERIES_WINDOW;
        const occurrences: Task[] = [];
        for (let index = 0; index < windowCount; index += 1) {
          const occurrence = occurrenceDate(recurrence, index);
          occurrences.push({
            ...task,
            id: `${seriesId}#${index}`,
            status: "todo",
            date: occurrence.date,
            time: occurrence.time ?? task.time,
            createdAt: timestamp,
            updatedAt: timestamp,
            visibility: task.visibility ?? "private",
            ownerId: task.ownerId ?? "me",
            seriesId,
            seriesIndex: index,
            recurrence,
          });
        }
        set((state) => ({ tasks: [...occurrences, ...state.tasks] }));
        return seriesId;
      },
      // Edytuje przyszłe/dzisiejsze wystąpienia serii (przeszłe/ukończone pozostają nietknięte).
      // Jeśli `changes.recurrence` zmienia regułę, daty przyszłych wystąpień są przeliczane
      // (ten sam seriesIndex, nowa data), po czym okno jest dosuwane przez expandSeries.
      updateSeries: (seriesId, changes) => {
        const today = dateKey();
        const now = new Date().toISOString();
        set((state) => {
          const nextRecurrence = changes.recurrence;
          const limit = nextRecurrence?.count;
          const updated = state.tasks.map((task) => {
            if (task.seriesId !== seriesId) return task;
            if (task.date && task.date < today) {
              // Przeszłe/ukończone wystąpienia zostają nietknięte, ale zmianę widoczności
              // propagujemy na całą serię — inaczej split po `visibility` rozdzieliłby ją
              // między dokument wspólny i prywatny przy synchronizacji.
              return changes.visibility && changes.visibility !== task.visibility
                ? { ...task, visibility: changes.visibility, updatedAt: now }
                : task;
            }
            const merged: Task = { ...task, ...changes, updatedAt: now };
            if (nextRecurrence && task.seriesIndex !== undefined) {
              const occurrence = occurrenceDate(nextRecurrence, task.seriesIndex);
              merged.date = occurrence.date;
              merged.time = occurrence.time ?? task.time;
            }
            return merged;
          });
          // Zmniejszenie limitu `count` usuwa przyszłe wystąpienia ponad nowy limit;
          // przeszłe (historia) zostają.
          const trimmed =
            limit === undefined
              ? updated
              : updated.filter(
                  (task) =>
                    task.seriesId !== seriesId ||
                    (task.seriesIndex ?? 0) < limit ||
                    Boolean(task.date && task.date < today),
                );
          return { tasks: expandSeries(trimmed, today) };
        });
      },
      deleteSeries: (seriesId) =>
        set((state) => ({ tasks: state.tasks.filter((task) => task.seriesId !== seriesId) })),
      addEvent: (event) => {
        const eventId = id();
        set((state) => ({
          events: [
            ...state.events,
            {
              ...event,
              id: eventId,
              updatedAt: new Date().toISOString(),
              visibility: event.visibility ?? "private",
              ownerId: event.ownerId ?? "me",
            },
          ],
        }));
        return eventId;
      },
      updateEvent: (eventId, changes) =>
        set((state) => ({
          events: state.events.map((event) =>
            event.id === eventId ? { ...event, ...changes, updatedAt: new Date().toISOString() } : event,
          ),
        })),
      deleteEvent: (eventId) =>
        set((state) => ({
          events: state.events.filter((event) => event.id !== eventId),
        })),
      addRecurringEvent: (event, recurrence) => {
        const seriesId = id();
        const timestamp = new Date().toISOString();
        const duration = durationMinutes(event.startTime, event.endTime);
        const windowCount = recurrence.count !== undefined ? Math.min(SERIES_WINDOW, recurrence.count) : SERIES_WINDOW;
        const occurrences: CalendarEvent[] = [];
        for (let index = 0; index < windowCount; index += 1) {
          const occurrence = occurrenceDate(recurrence, index);
          const startTime = occurrence.time ?? event.startTime;
          occurrences.push({
            ...event,
            id: `${seriesId}#${index}`,
            date: occurrence.date,
            startTime,
            endTime: addMinutesToTime(startTime, duration),
            updatedAt: timestamp,
            visibility: event.visibility ?? "private",
            ownerId: event.ownerId ?? "me",
            seriesId,
            seriesIndex: index,
            recurrence,
          });
        }
        set((state) => ({ events: [...state.events, ...occurrences] }));
        return seriesId;
      },
      // Analogicznie do `updateSeries`, ale dla wydarzeń: zachowuje czas trwania (endTime - startTime)
      // przy przeliczaniu godziny startu z nowej reguły.
      updateEventSeries: (seriesId, changes) => {
        const today = dateKey();
        const now = new Date().toISOString();
        set((state) => {
          const nextRecurrence = changes.recurrence;
          const limit = nextRecurrence?.count;
          const updated = state.events.map((event) => {
            if (event.seriesId !== seriesId) return event;
            if (event.date < today) {
              // Jak w updateSeries: przeszłe wystąpienia bez zmian, ale widoczność
              // propagujemy na całą serię, by nie rozszczepić jej między dokumenty.
              return changes.visibility && changes.visibility !== event.visibility
                ? { ...event, visibility: changes.visibility, updatedAt: now }
                : event;
            }
            const merged: CalendarEvent = { ...event, ...changes, updatedAt: now };
            if (nextRecurrence && event.seriesIndex !== undefined) {
              // Czas trwania liczony z wartości PO scaleniu `changes` (nie z oryginalnego
              // wystąpienia), żeby edycja godzin w formularzu serii dotyczyła jednolicie
              // wszystkich przyszłych wystąpień.
              const occurrence = occurrenceDate(nextRecurrence, event.seriesIndex);
              const duration = durationMinutes(merged.startTime, merged.endTime);
              const startTime = occurrence.time ?? merged.startTime;
              merged.date = occurrence.date;
              merged.startTime = startTime;
              merged.endTime = addMinutesToTime(startTime, duration);
            }
            return merged;
          });
          const trimmed =
            limit === undefined
              ? updated
              : updated.filter(
                  (event) =>
                    event.seriesId !== seriesId ||
                    (event.seriesIndex ?? 0) < limit ||
                    event.date < today,
                );
          return { events: expandSeries(trimmed, today) };
        });
      },
      deleteEventSeries: (seriesId) =>
        set((state) => ({ events: state.events.filter((event) => event.seriesId !== seriesId) })),
      addReminder: (reminder) => {
        const reminderId = id();
        set((state) => ({
          reminders: [
            {
              ...reminder,
              id: reminderId,
              done: false,
              updatedAt: new Date().toISOString(),
              visibility: reminder.visibility ?? "private",
              ownerId: reminder.ownerId ?? "me",
            },
            ...state.reminders,
          ],
        }));
        return reminderId;
      },
      toggleReminder: (reminderId) =>
        set((state) => ({
          reminders: state.reminders.map((reminder) =>
            reminder.id === reminderId
              ? { ...reminder, done: !reminder.done, updatedAt: new Date().toISOString() }
              : reminder,
          ),
        })),
      snoozeReminder: (reminderId, minutes) => {
        const next = new Date(Date.now() + minutes * 60_000);
        set((state) => ({
          reminders: state.reminders.map((reminder) =>
            reminder.id === reminderId
              ? {
                  ...reminder,
                  date: format(next, "yyyy-MM-dd"),
                  time: format(next, "HH:mm"),
                  notifiedAt: undefined,
                  updatedAt: new Date().toISOString(),
                }
              : reminder,
          ),
        }));
      },
      deleteReminder: (reminderId) =>
        set((state) => ({
          reminders: state.reminders.filter((reminder) => reminder.id !== reminderId),
        })),
      markReminderNotified: (reminderId) =>
        set((state) => ({
          reminders: state.reminders.map((reminder) =>
            reminder.id === reminderId
              ? { ...reminder, notifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
              : reminder,
          ),
        })),
      addNote: (note) => {
        const noteId = id();
        const timestamp = new Date().toISOString();
        set((state) => ({
          notes: [
            {
              ...note,
              id: noteId,
              createdAt: timestamp,
              updatedAt: timestamp,
              visibility: note.visibility ?? "private",
              ownerId: note.ownerId ?? "me",
            },
            ...state.notes,
          ],
        }));
        return noteId;
      },
      updateNote: (noteId, changes) =>
        set((state) => ({
          notes: state.notes.map((note) =>
            note.id === noteId
              ? { ...note, ...changes, updatedAt: new Date().toISOString() }
              : note,
          ),
        })),
      deleteNote: (noteId) =>
        set((state) => ({ notes: state.notes.filter((note) => note.id !== noteId) })),
      toggleHabit: (habitId, date) =>
        set((state) => ({
          habits: state.habits.map((habit) => {
            if (habit.id !== habitId) return habit;
            const completed = habit.completedDates.includes(date);
            return {
              ...habit,
              completedDates: completed
                ? habit.completedDates.filter((value) => value !== date)
                : [...habit.completedDates, date],
              updatedAt: new Date().toISOString(),
            };
          }),
        })),
      addHabit: (habit) =>
        set((state) => ({
          habits: [
            ...state.habits,
            {
              ...habit,
              id: id(),
              completedDates: [],
              updatedAt: new Date().toISOString(),
              visibility: habit.visibility ?? "private",
              ownerId: habit.ownerId ?? "me",
            },
          ],
        })),
      deleteHabit: (habitId) =>
        set((state) => ({ habits: state.habits.filter((habit) => habit.id !== habitId) })),
      setScratchpad: (scratchpad) => set({ scratchpad }),
      setIntention: (intention) => set({ intention }),
      setEnergy: (energy) => set({ energy }),
      updatePreferences: (changes) =>
        set((state) => ({ preferences: { ...state.preferences, ...changes } })),
      replaceData: (data) => set(data),
      resetData: () => set(createSampleData()),
      // Dosuwa okno przyszłych wystąpień serii (wołane przy montażu appki i powrocie do niej).
      // No-op (bez `set`), gdy okna są już pełne — unika zbędnych zapisów/synchronizacji
      // (patrz „Ryzyka — pętla zapisu przy rozwijaniu" w planie).
      expandRecurringSeries: () => {
        const state = get();
        const today = dateKey();
        const tasks = expandSeries(state.tasks, today);
        const events = expandSeries(state.events, today);
        if (tasks === state.tasks && events === state.events) return;
        set({ tasks, events });
      },
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      merge: (persistedState, currentState) => {
        if (!persistedState || typeof persistedState !== "object") {
          reportStorageWarning("Zapisane dane miały niezgodny format — zachowano bezpieczne dane startowe");
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;

        const tasks = parseArrayField(state.tasks, taskSchema);
        const events = parseArrayField(state.events, eventSchema);
        const reminders = parseArrayField(state.reminders, reminderSchema);
        const notes = parseArrayField(state.notes, noteSchema);
        const habits = parseArrayField(state.habits, habitSchema);
        const scratchpad = parseScalarField(state.scratchpad, z.string(), currentState.scratchpad);
        const intention = parseScalarField(state.intention, z.string(), currentState.intention);
        const energy = parseScalarField(state.energy, energySchema, currentState.energy);
        const preferences = parseScalarField(state.preferences, preferencesSchema, currentState.preferences);

        const droppedCount =
          tasks.dropped + events.dropped + reminders.dropped + notes.dropped + habits.dropped +
          scratchpad.dropped + intention.dropped + energy.dropped + preferences.dropped;

        if (droppedCount > 0) {
          reportStorageWarning("Część zapisanych danych była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane");
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          tasks: tasks.items,
          events: events.items,
          reminders: reminders.items,
          notes: notes.items,
          habits: habits.items,
          scratchpad: scratchpad.value,
          intention: intention.value,
          energy: energy.value,
          preferences: preferences.value,
        };
      },
      partialize: (state) => ({
        tasks: state.tasks,
        events: state.events,
        reminders: state.reminders,
        notes: state.notes,
        habits: state.habits,
        scratchpad: state.scratchpad,
        intention: state.intention,
        energy: state.energy,
        preferences: state.preferences,
      }),
    },
  ),
);

export function exportData(): LifeData {
  const state = useLifeStore.getState();
  return {
    tasks: state.tasks,
    events: state.events,
    reminders: state.reminders,
    notes: state.notes,
    habits: state.habits,
    scratchpad: state.scratchpad,
    intention: state.intention,
    energy: state.energy,
    preferences: state.preferences,
  };
}
