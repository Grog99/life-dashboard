// Dedykowany store modułu Life (Zadania/Kalendarz/Przypomnienia/Notatki/Nawyki) — patrz
// docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("Frontend — dedykowany store + silnik
// sync"). Pięć kolekcji (`tasks`/`events`/`reminders`/`notes`/`habits`) nie są już częścią
// dokumentu JSONB (`LifeData`/`useLifeStore`) — mają własne znormalizowane tabele SQL i endpointy
// `/api/v1/life` (snapshot) + `/api/v1/life/mutations` (batch mutacji z idempotencją +
// optymistyczną współbieżnością per rekord, kolumna `version`). Wzór 1:1 z
// src/store/useHealthStore.ts (STRICTLY PROSTSZY moduł: bez pola agregującego, bez relacji
// rodzic/dziecko, pięć CAŁKOWICIE NIEZALEŻNYCH kolekcji płaskich), z jedną istotną różnicą: Life
// niesie też logikę powtarzalności (`addRecurringTask`/`addRecurringEvent`/`updateSeries`/
// `updateEventSeries`/`deleteSeries`/`deleteEventSeries`/`expandRecurringSeries`) przeniesioną 1:1
// z poprzedniego `src/store/useLifeStore.ts` — materializacja okna zostaje czystą, testowalną
// logiką w `src/lib/recurrence.ts` (Wariant A, bez zmian), a ten store tylko dokleja do niej
// kolejkowanie mutacji zamiast bezpośredniego zapisu dokumentu JSONB.
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji (src/hooks/useLifeRecordsSync.ts,
// src/server/LifeRecordsSync.tsx) obserwuje ten store z zewnątrz (`useLifeRecordsStore.subscribe`)
// i odpowiada za GET/POST, dokładnie jak HealthSync robi to dla Zdrowia.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { addDays, format } from "date-fns";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { eventSchema, habitSchema, noteSchema, reminderSchema, taskSchema } from "../lib/schema";
import { addMinutesToTime, dateKey, durationMinutes } from "../lib/date";
import { expandSeries, occurrenceDate, SERIES_WINDOW } from "../lib/recurrence";
import type { CalendarEvent, Habit, Note, Recurrence, Reminder, Task } from "../types";

const STORAGE_NAME = "puls-life-records";

export type LifeOp =
  | "task.create"
  | "task.update"
  | "task.delete"
  | "event.create"
  | "event.update"
  | "event.delete"
  | "reminder.create"
  | "reminder.update"
  | "reminder.delete"
  | "note.create"
  | "note.update"
  | "note.delete"
  | "habit.create"
  | "habit.update"
  | "habit.delete";

export interface PendingLifeMutation {
  idempotencyKey: string;
  op: LifeOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface LifeMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface LifeRecordsSnapshot {
  tasks: Task[];
  events: CalendarEvent[];
  reminders: Reminder[];
  notes: Note[];
  habits: Habit[];
  serverAt: string;
}

// Pola edytowalne przez `*.update` — muszą być 1:1 zgodne z *_UPDATE_KEYS w server/src/life.mjs.
// `visibility` JEST w każdym zestawie — modale edycji pozwalają zmienić widoczność istniejącego
// rekordu po utworzeniu (parytet z dzisiejszym splitWorkspaceData/updateTask itd.).
const TASK_UPDATE_KEYS = [
  "title",
  "description",
  "status",
  "priority",
  "date",
  "time",
  "estimatedMinutes",
  "category",
  "isFocus",
  "energy",
  "completedAt",
  "visibility",
  "seriesId",
  "seriesIndex",
  "recurrence",
] as const;

const EVENT_UPDATE_KEYS = [
  "title",
  "date",
  "startTime",
  "endTime",
  "kind",
  "location",
  "notes",
  "source",
  "externalId",
  "externalUpdatedAt",
  "visibility",
  "seriesId",
  "seriesIndex",
  "recurrence",
] as const;

// Uwaga: `reminders`/`habits` NIE mają tu generycznej akcji `update*` (żadnej nie miały też w
// poprzednim useLifeStore.ts) — tylko dedykowane toggle/snooze/mark akcje niżej, które budują
// swoje `changes` bezpośrednio. `REMINDER_UPDATE_KEYS`/`HABIT_UPDATE_KEYS` z server/src/life.mjs
// (title/date/time/done/notifiedAt/visibility i name/icon/targetLabel/completedDates/visibility)
// więc nie mają odpowiednika po stronie klienta.
const NOTE_UPDATE_KEYS = ["title", "content", "color", "pinned", "visibility"] as const;

function pickChanges<T extends Record<string, unknown>>(
  source: T,
  keys: readonly string[],
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) changes[key] = source[key];
  }
  return changes;
}

// Payload `*.create` niesie `id` + wszystkie pola tworzenia + `visibility` (server/src/life.mjs
// "Ops mutacji"). Budowane z rekordu PO nadaniu domyślnych wartości (id/version/visibility) —
// dlatego przyjmują już zmaterializowany rekord, nie surowe dane formularza.
function taskCreatePayload(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    date: task.date,
    time: task.time,
    estimatedMinutes: task.estimatedMinutes,
    category: task.category,
    isFocus: task.isFocus,
    energy: task.energy,
    completedAt: task.completedAt,
    visibility: task.visibility,
    seriesId: task.seriesId,
    seriesIndex: task.seriesIndex,
    recurrence: task.recurrence,
  };
}

function eventCreatePayload(event: CalendarEvent): Record<string, unknown> {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    startTime: event.startTime,
    endTime: event.endTime,
    kind: event.kind,
    location: event.location,
    notes: event.notes,
    source: event.source,
    externalId: event.externalId,
    externalUpdatedAt: event.externalUpdatedAt,
    visibility: event.visibility,
    seriesId: event.seriesId,
    seriesIndex: event.seriesIndex,
    recurrence: event.recurrence,
  };
}

function reminderCreatePayload(reminder: Reminder): Record<string, unknown> {
  return {
    id: reminder.id,
    title: reminder.title,
    date: reminder.date,
    time: reminder.time,
    done: reminder.done,
    notifiedAt: reminder.notifiedAt,
    visibility: reminder.visibility,
  };
}

function noteCreatePayload(note: Note): Record<string, unknown> {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    color: note.color,
    pinned: note.pinned,
    visibility: note.visibility,
  };
}

function habitCreatePayload(habit: Habit): Record<string, unknown> {
  return {
    id: habit.id,
    name: habit.name,
    icon: habit.icon,
    targetLabel: habit.targetLabel,
    completedDates: habit.completedDates,
    visibility: habit.visibility,
  };
}

function upsertById<T extends { id: string }>(list: T[], record: T): T[] {
  const index = list.findIndex((item) => item.id === record.id);
  if (index === -1) return [record, ...list];
  const next = list.slice();
  next[index] = record;
  return next;
}

function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((item) => item.id !== id);
}

// Wszystkie pięć `*.update` niosą `baseVersion` i podlegają cichemu rebase'owi przy konflikcie
// (wzór isUpdateOp w useHealthStore.ts/useCarStore.ts). Delete-y są idempotentne (brak rekordu =
// applied), create-y na kolizję id (deterministyczne `seriesId#index`) trafiają do
// reconcileTerminal jak każdy inny wynik terminalny — to właśnie obsługuje adopcję `ID_TAKEN`.
function isUpdateOp(
  op: LifeOp,
): op is "task.update" | "event.update" | "reminder.update" | "note.update" | "habit.update" {
  return (
    op === "task.update" ||
    op === "event.update" ||
    op === "reminder.update" ||
    op === "note.update" ||
    op === "habit.update"
  );
}

interface Collections {
  tasks: Task[];
  events: CalendarEvent[];
  reminders: Reminder[];
  notes: Note[];
  habits: Habit[];
}

// Rebase konfliktu update: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
// którą ta mutacja próbowała zapisać (wzór: upsertByUpdateOp w useHealthStore.ts).
function upsertByUpdateOp(op: LifeOp, record: unknown, collections: Collections): Collections {
  switch (op) {
    case "task.update":
      return { ...collections, tasks: upsertById(collections.tasks, record as Task) };
    case "event.update":
      return { ...collections, events: upsertById(collections.events, record as CalendarEvent) };
    case "reminder.update":
      return { ...collections, reminders: upsertById(collections.reminders, record as Reminder) };
    case "note.update":
      return { ...collections, notes: upsertById(collections.notes, record as Note) };
    case "habit.update":
      return { ...collections, habits: upsertById(collections.habits, record as Habit) };
    default:
      return collections;
  }
}

// Rozliczenie wyniku terminalnego: applied/duplicate dla każdej operacji, ORAZ conflict dla
// `*.create` (kolizja deterministycznego id serii, kod ID_TAKEN) — wzór reconcileTerminal w
// useHealthStore.ts: "zaadoptuj zwrócony rekord tak samo jak przy sukcesie".
function reconcileTerminal(
  mutation: PendingLifeMutation,
  result: LifeMutationResult,
  collections: Collections,
): Collections {
  let { tasks, events, reminders, notes, habits } = collections;
  const payload = mutation.payload as { id?: string };
  switch (mutation.op) {
    case "task.create":
    case "task.update":
      if (result.record) tasks = upsertById(tasks, result.record as Task);
      break;
    case "task.delete":
      tasks = removeById(tasks, String(payload.id));
      break;
    case "event.create":
    case "event.update":
      if (result.record) events = upsertById(events, result.record as CalendarEvent);
      break;
    case "event.delete":
      events = removeById(events, String(payload.id));
      break;
    case "reminder.create":
    case "reminder.update":
      if (result.record) reminders = upsertById(reminders, result.record as Reminder);
      break;
    case "reminder.delete":
      reminders = removeById(reminders, String(payload.id));
      break;
    case "note.create":
    case "note.update":
      if (result.record) notes = upsertById(notes, result.record as Note);
      break;
    case "note.delete":
      notes = removeById(notes, String(payload.id));
      break;
    case "habit.create":
    case "habit.update":
      if (result.record) habits = upsertById(habits, result.record as Habit);
      break;
    case "habit.delete":
      habits = removeById(habits, String(payload.id));
      break;
  }
  return { tasks, events, reminders, notes, habits };
}

interface LifeRecordsState {
  tasks: Task[];
  events: CalendarEvent[];
  reminders: Reminder[];
  notes: Note[];
  habits: Habit[];
  pendingMutations: PendingLifeMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface LifeRecordsActions {
  addTask: (task: Omit<Task, "id" | "createdAt" | "updatedAt" | "status" | "version">) => string;
  updateTask: (taskId: string, changes: Partial<Task>) => void;
  toggleTask: (taskId: string) => void;
  toggleFocus: (taskId: string) => boolean;
  deleteTask: (taskId: string) => void;
  moveTaskToTomorrow: (taskId: string) => void;
  addRecurringTask: (
    task: Omit<Task, "id" | "createdAt" | "updatedAt" | "status" | "version">,
    recurrence: Recurrence,
  ) => string;
  updateSeries: (seriesId: string, changes: Partial<Task>) => void;
  deleteSeries: (seriesId: string) => void;
  addEvent: (event: Omit<CalendarEvent, "id" | "updatedAt" | "version">) => string;
  updateEvent: (eventId: string, changes: Partial<CalendarEvent>) => void;
  deleteEvent: (eventId: string) => void;
  addRecurringEvent: (
    event: Omit<CalendarEvent, "id" | "updatedAt" | "version">,
    recurrence: Recurrence,
  ) => string;
  updateEventSeries: (seriesId: string, changes: Partial<CalendarEvent>) => void;
  deleteEventSeries: (seriesId: string) => void;
  expandRecurringSeries: () => void;
  addReminder: (reminder: Omit<Reminder, "id" | "done" | "updatedAt" | "version">) => string;
  toggleReminder: (reminderId: string) => void;
  snoozeReminder: (reminderId: string, minutes: number) => void;
  deleteReminder: (reminderId: string) => void;
  markReminderNotified: (reminderId: string) => void;
  addNote: (note: Omit<Note, "id" | "createdAt" | "updatedAt" | "version">) => string;
  updateNote: (noteId: string, changes: Partial<Note>) => void;
  deleteNote: (noteId: string) => void;
  toggleHabit: (habitId: string, date: string) => void;
  addHabit: (habit: Omit<Habit, "id" | "completedDates" | "updatedAt" | "version">) => void;
  deleteHabit: (habitId: string) => void;
  hydrateFromSnapshot: (snapshot: LifeRecordsSnapshot) => void;
  applyMutationResults: (results: LifeMutationResult[]) => void;
  resetLifeRecordsData: () => void;
}

export type LifeRecordsStore = LifeRecordsState & LifeRecordsActions;

function emptyState(): LifeRecordsState {
  return {
    tasks: [],
    events: [],
    reminders: [],
    notes: [],
    habits: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const lifeOpSchema = z.enum([
  "task.create",
  "task.update",
  "task.delete",
  "event.create",
  "event.update",
  "event.delete",
  "reminder.create",
  "reminder.update",
  "reminder.delete",
  "note.create",
  "note.update",
  "note.delete",
  "habit.create",
  "habit.update",
  "habit.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: lifeOpSchema,
  payload: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().min(1).optional(),
});

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

export const useLifeRecordsStore = create<LifeRecordsStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addTask: (task) => {
        const taskId = makeId();
        const timestamp = new Date().toISOString();
        const record: Task = {
          ...task,
          id: taskId,
          status: "todo",
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
          visibility: task.visibility ?? "private",
          ownerId: task.ownerId ?? "me",
        };
        set((state) => ({
          tasks: [record, ...state.tasks],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "task.create", payload: taskCreatePayload(record) },
          ],
        }));
        return taskId;
      },

      updateTask: (taskId, changes) => {
        const existing = get().tasks.find((task) => task.id === taskId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          TASK_UPDATE_KEYS,
        ) as Partial<Task>;
        set((state) => ({
          tasks: upsertById(state.tasks, { ...existing, ...allowedChanges, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "task.update",
              payload: { id: taskId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      // Liczy nowy stan (status/isFocus/completedAt) LOKALNIE z bieżącego rekordu i wysyła
      // task.update z policzoną deltą — serwer nie liczy toggle'a, tylko zapisuje przysłane
      // wartości (wzór togglePetVisitCompleted / toggleMedicationActive).
      toggleTask: (taskId) => {
        const existing = get().tasks.find((task) => task.id === taskId);
        if (!existing) return;
        const done = existing.status !== "done";
        const focusDay = existing.date ?? format(new Date(), "yyyy-MM-dd");
        const focusCount = get().tasks.filter(
          (item) =>
            item.id !== taskId &&
            item.isFocus &&
            item.status !== "done" &&
            (item.date ?? format(new Date(), "yyyy-MM-dd")) === focusDay,
        ).length;
        const nextIsFocus = !done && existing.isFocus && focusCount >= 3 ? false : existing.isFocus;
        const nextCompletedAt = done ? new Date().toISOString() : undefined;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          tasks: upsertById(state.tasks, {
            ...existing,
            status: done ? "done" : "todo",
            isFocus: nextIsFocus,
            completedAt: nextCompletedAt,
            updatedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "task.update",
              payload: {
                id: taskId,
                changes: {
                  status: done ? "done" : "todo",
                  isFocus: nextIsFocus,
                  completedAt: nextCompletedAt ?? null,
                },
              },
              baseVersion: existing.version,
            },
          ],
        }));
      },

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
        const nextIsFocus = !task.isFocus;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          tasks: upsertById(state.tasks, { ...task, isFocus: nextIsFocus, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "task.update",
              payload: { id: taskId, changes: { isFocus: nextIsFocus } },
              baseVersion: task.version,
            },
          ],
        }));
        return true;
      },

      deleteTask: (taskId) =>
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== taskId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "task.delete", payload: { id: taskId } },
          ],
        })),

      moveTaskToTomorrow: (taskId) => {
        const existing = get().tasks.find((task) => task.id === taskId);
        if (!existing) return;
        const nextDate = format(addDays(new Date(), 1), "yyyy-MM-dd");
        const updatedAt = new Date().toISOString();
        set((state) => ({
          tasks: upsertById(state.tasks, { ...existing, date: nextDate, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "task.update",
              payload: { id: taskId, changes: { date: nextDate } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      addRecurringTask: (task, recurrence) => {
        const seriesId = makeId();
        const timestamp = new Date().toISOString();
        const windowCount =
          recurrence.count !== undefined
            ? Math.min(SERIES_WINDOW, recurrence.count)
            : SERIES_WINDOW;
        const occurrences: Task[] = [];
        const mutations: PendingLifeMutation[] = [];
        for (let index = 0; index < windowCount; index += 1) {
          const occurrence = occurrenceDate(recurrence, index);
          const record: Task = {
            ...task,
            id: `${seriesId}#${index}`,
            status: "todo",
            date: occurrence.date,
            time: occurrence.time ?? task.time,
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
            visibility: task.visibility ?? "private",
            ownerId: task.ownerId ?? "me",
            seriesId,
            seriesIndex: index,
            recurrence,
          };
          occurrences.push(record);
          mutations.push({
            idempotencyKey: makeId(),
            op: "task.create",
            payload: taskCreatePayload(record),
          });
        }
        set((state) => ({
          tasks: [...occurrences, ...state.tasks],
          pendingMutations: [...state.pendingMutations, ...mutations],
        }));
        return seriesId;
      },

      // Edytuje przyszłe/dzisiejsze wystąpienia serii (przeszłe/ukończone pozostają nietknięte,
      // poza propagacją widoczności). Każde zmienione/utworzone/usunięte wystąpienie dostaje
      // WŁASNĄ mutację z jego `baseVersion` — 1:1 przeniesione z poprzedniego useLifeStore.ts,
      // jedyna różnica to kolejkowanie mutacji obok lokalnej zmiany stanu.
      updateSeries: (seriesId, changes) => {
        const today = dateKey();
        const now = new Date().toISOString();
        const state = get();
        const nextRecurrence = changes.recurrence;
        const limit = nextRecurrence?.count;
        const mutations: PendingLifeMutation[] = [];
        const updated = state.tasks.map((task) => {
          if (task.seriesId !== seriesId) return task;
          if (task.date && task.date < today) {
            if (changes.visibility && changes.visibility !== task.visibility) {
              mutations.push({
                idempotencyKey: makeId(),
                op: "task.update",
                payload: { id: task.id, changes: { visibility: changes.visibility } },
                baseVersion: task.version,
              });
              return { ...task, visibility: changes.visibility, updatedAt: now };
            }
            return task;
          }
          const merged: Task = { ...task, ...changes, updatedAt: now };
          if (nextRecurrence && task.seriesIndex !== undefined) {
            const occurrence = occurrenceDate(nextRecurrence, task.seriesIndex);
            merged.date = occurrence.date;
            merged.time = occurrence.time ?? task.time;
          }
          const mutationChanges = pickChanges(
            { ...changes, date: merged.date, time: merged.time } as Record<string, unknown>,
            TASK_UPDATE_KEYS,
          );
          mutations.push({
            idempotencyKey: makeId(),
            op: "task.update",
            payload: { id: task.id, changes: mutationChanges },
            baseVersion: task.version,
          });
          return merged;
        });
        const trimmed =
          limit === undefined
            ? updated
            : updated.filter((task) => {
                if (task.seriesId !== seriesId) return true;
                if (task.date && task.date < today) return true;
                if ((task.seriesIndex ?? 0) < limit) return true;
                mutations.push({
                  idempotencyKey: makeId(),
                  op: "task.delete",
                  payload: { id: task.id },
                });
                return false;
              });
        const expanded = expandSeries(trimmed, today);
        if (expanded !== trimmed) {
          const trimmedIds = new Set(trimmed.map((task) => task.id));
          for (const task of expanded) {
            if (!trimmedIds.has(task.id)) {
              mutations.push({
                idempotencyKey: makeId(),
                op: "task.create",
                payload: taskCreatePayload(task),
              });
            }
          }
        }
        set({ tasks: expanded, pendingMutations: [...state.pendingMutations, ...mutations] });
      },

      deleteSeries: (seriesId) => {
        const state = get();
        const toDelete = state.tasks.filter((task) => task.seriesId === seriesId);
        set({
          tasks: state.tasks.filter((task) => task.seriesId !== seriesId),
          pendingMutations: [
            ...state.pendingMutations,
            ...toDelete.map((task) => ({
              idempotencyKey: makeId(),
              op: "task.delete" as const,
              payload: { id: task.id },
            })),
          ],
        });
      },

      addEvent: (event) => {
        const eventId = makeId();
        const updatedAt = new Date().toISOString();
        const record: CalendarEvent = {
          ...event,
          id: eventId,
          updatedAt,
          version: 1,
          visibility: event.visibility ?? "private",
          ownerId: event.ownerId ?? "me",
        };
        set((state) => ({
          events: [...state.events, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "event.create", payload: eventCreatePayload(record) },
          ],
        }));
        return eventId;
      },

      updateEvent: (eventId, changes) => {
        const existing = get().events.find((event) => event.id === eventId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          EVENT_UPDATE_KEYS,
        ) as Partial<CalendarEvent>;
        set((state) => ({
          events: upsertById(state.events, { ...existing, ...allowedChanges, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "event.update",
              payload: { id: eventId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteEvent: (eventId) =>
        set((state) => ({
          events: state.events.filter((event) => event.id !== eventId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "event.delete", payload: { id: eventId } },
          ],
        })),

      addRecurringEvent: (event, recurrence) => {
        const seriesId = makeId();
        const timestamp = new Date().toISOString();
        const duration = durationMinutes(event.startTime, event.endTime);
        const windowCount =
          recurrence.count !== undefined
            ? Math.min(SERIES_WINDOW, recurrence.count)
            : SERIES_WINDOW;
        const occurrences: CalendarEvent[] = [];
        const mutations: PendingLifeMutation[] = [];
        for (let index = 0; index < windowCount; index += 1) {
          const occurrence = occurrenceDate(recurrence, index);
          const startTime = occurrence.time ?? event.startTime;
          const record: CalendarEvent = {
            ...event,
            id: `${seriesId}#${index}`,
            date: occurrence.date,
            startTime,
            endTime: addMinutesToTime(startTime, duration),
            updatedAt: timestamp,
            version: 1,
            visibility: event.visibility ?? "private",
            ownerId: event.ownerId ?? "me",
            seriesId,
            seriesIndex: index,
            recurrence,
          };
          occurrences.push(record);
          mutations.push({
            idempotencyKey: makeId(),
            op: "event.create",
            payload: eventCreatePayload(record),
          });
        }
        set((state) => ({
          events: [...state.events, ...occurrences],
          pendingMutations: [...state.pendingMutations, ...mutations],
        }));
        return seriesId;
      },

      // Analogicznie do `updateSeries`, ale dla wydarzeń: zachowuje czas trwania
      // (endTime - startTime) przy przeliczaniu godziny startu z nowej reguły.
      updateEventSeries: (seriesId, changes) => {
        const today = dateKey();
        const now = new Date().toISOString();
        const state = get();
        const nextRecurrence = changes.recurrence;
        const limit = nextRecurrence?.count;
        const mutations: PendingLifeMutation[] = [];
        const updated = state.events.map((event) => {
          if (event.seriesId !== seriesId) return event;
          if (event.date < today) {
            if (changes.visibility && changes.visibility !== event.visibility) {
              mutations.push({
                idempotencyKey: makeId(),
                op: "event.update",
                payload: { id: event.id, changes: { visibility: changes.visibility } },
                baseVersion: event.version,
              });
              return { ...event, visibility: changes.visibility, updatedAt: now };
            }
            return event;
          }
          const merged: CalendarEvent = { ...event, ...changes, updatedAt: now };
          if (nextRecurrence && event.seriesIndex !== undefined) {
            const occurrence = occurrenceDate(nextRecurrence, event.seriesIndex);
            const duration = durationMinutes(merged.startTime, merged.endTime);
            const startTime = occurrence.time ?? merged.startTime;
            merged.date = occurrence.date;
            merged.startTime = startTime;
            merged.endTime = addMinutesToTime(startTime, duration);
          }
          const mutationChanges = pickChanges(
            {
              ...changes,
              date: merged.date,
              startTime: merged.startTime,
              endTime: merged.endTime,
            } as Record<string, unknown>,
            EVENT_UPDATE_KEYS,
          );
          mutations.push({
            idempotencyKey: makeId(),
            op: "event.update",
            payload: { id: event.id, changes: mutationChanges },
            baseVersion: event.version,
          });
          return merged;
        });
        const trimmed =
          limit === undefined
            ? updated
            : updated.filter((event) => {
                if (event.seriesId !== seriesId) return true;
                if (event.date < today) return true;
                if ((event.seriesIndex ?? 0) < limit) return true;
                mutations.push({
                  idempotencyKey: makeId(),
                  op: "event.delete",
                  payload: { id: event.id },
                });
                return false;
              });
        const expanded = expandSeries(trimmed, today);
        if (expanded !== trimmed) {
          const trimmedIds = new Set(trimmed.map((event) => event.id));
          for (const event of expanded) {
            if (!trimmedIds.has(event.id)) {
              mutations.push({
                idempotencyKey: makeId(),
                op: "event.create",
                payload: eventCreatePayload(event),
              });
            }
          }
        }
        set({ events: expanded, pendingMutations: [...state.pendingMutations, ...mutations] });
      },

      deleteEventSeries: (seriesId) => {
        const state = get();
        const toDelete = state.events.filter((event) => event.seriesId === seriesId);
        set({
          events: state.events.filter((event) => event.seriesId !== seriesId),
          pendingMutations: [
            ...state.pendingMutations,
            ...toDelete.map((event) => ({
              idempotencyKey: makeId(),
              op: "event.delete" as const,
              payload: { id: event.id },
            })),
          ],
        });
      },

      // Dosuwa okno przyszłych wystąpień serii (wołane przy montażu appki i powrocie do niej).
      // No-op (bez `set`), gdy okna są już pełne — unika zbędnych zapisów/synchronizacji.
      expandRecurringSeries: () => {
        const state = get();
        const today = dateKey();
        const tasksExpanded = expandSeries(state.tasks, today);
        const eventsExpanded = expandSeries(state.events, today);
        if (tasksExpanded === state.tasks && eventsExpanded === state.events) return;
        const mutations: PendingLifeMutation[] = [];
        if (tasksExpanded !== state.tasks) {
          const existingIds = new Set(state.tasks.map((task) => task.id));
          for (const task of tasksExpanded) {
            if (!existingIds.has(task.id)) {
              mutations.push({
                idempotencyKey: makeId(),
                op: "task.create",
                payload: taskCreatePayload(task),
              });
            }
          }
        }
        if (eventsExpanded !== state.events) {
          const existingIds = new Set(state.events.map((event) => event.id));
          for (const event of eventsExpanded) {
            if (!existingIds.has(event.id)) {
              mutations.push({
                idempotencyKey: makeId(),
                op: "event.create",
                payload: eventCreatePayload(event),
              });
            }
          }
        }
        set({
          tasks: tasksExpanded,
          events: eventsExpanded,
          pendingMutations: [...state.pendingMutations, ...mutations],
        });
      },

      addReminder: (reminder) => {
        const reminderId = makeId();
        const updatedAt = new Date().toISOString();
        const record: Reminder = {
          ...reminder,
          id: reminderId,
          done: false,
          updatedAt,
          version: 1,
          visibility: reminder.visibility ?? "private",
          ownerId: reminder.ownerId ?? "me",
        };
        set((state) => ({
          reminders: [record, ...state.reminders],
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "reminder.create",
              payload: reminderCreatePayload(record),
            },
          ],
        }));
        return reminderId;
      },

      toggleReminder: (reminderId) => {
        const existing = get().reminders.find((reminder) => reminder.id === reminderId);
        if (!existing) return;
        const done = !existing.done;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          reminders: upsertById(state.reminders, { ...existing, done, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "reminder.update",
              payload: { id: reminderId, changes: { done } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      snoozeReminder: (reminderId, minutes) => {
        const existing = get().reminders.find((reminder) => reminder.id === reminderId);
        if (!existing) return;
        const next = new Date(Date.now() + minutes * 60_000);
        const date = format(next, "yyyy-MM-dd");
        const time = format(next, "HH:mm");
        const updatedAt = new Date().toISOString();
        set((state) => ({
          reminders: upsertById(state.reminders, {
            ...existing,
            date,
            time,
            notifiedAt: undefined,
            updatedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "reminder.update",
              payload: { id: reminderId, changes: { date, time, notifiedAt: null } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteReminder: (reminderId) =>
        set((state) => ({
          reminders: state.reminders.filter((reminder) => reminder.id !== reminderId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "reminder.delete", payload: { id: reminderId } },
          ],
        })),

      markReminderNotified: (reminderId) => {
        const existing = get().reminders.find((reminder) => reminder.id === reminderId);
        if (!existing) return;
        const notifiedAt = new Date().toISOString();
        set((state) => ({
          reminders: upsertById(state.reminders, {
            ...existing,
            notifiedAt,
            updatedAt: notifiedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "reminder.update",
              payload: { id: reminderId, changes: { notifiedAt } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      addNote: (note) => {
        const noteId = makeId();
        const timestamp = new Date().toISOString();
        const record: Note = {
          ...note,
          id: noteId,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
          visibility: note.visibility ?? "private",
          ownerId: note.ownerId ?? "me",
        };
        set((state) => ({
          notes: [record, ...state.notes],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "note.create", payload: noteCreatePayload(record) },
          ],
        }));
        return noteId;
      },

      updateNote: (noteId, changes) => {
        const existing = get().notes.find((note) => note.id === noteId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          NOTE_UPDATE_KEYS,
        ) as Partial<Note>;
        set((state) => ({
          notes: upsertById(state.notes, { ...existing, ...allowedChanges, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "note.update",
              payload: { id: noteId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteNote: (noteId) =>
        set((state) => ({
          notes: state.notes.filter((note) => note.id !== noteId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "note.delete", payload: { id: noteId } },
          ],
        })),

      // Toggle jako ABSOLUTNY set (docs/plans/…"Projekt pól specjalnych"): przelicza całą tablicę
      // lokalnie i wysyła ją w całości jako `habit.update { completedDates }` — NIE prawdziwy flip
      // (wzór `renew`/`togglePause` w Subskrypcjach).
      toggleHabit: (habitId, date) => {
        const existing = get().habits.find((habit) => habit.id === habitId);
        if (!existing) return;
        const completed = existing.completedDates.includes(date);
        const nextCompletedDates = completed
          ? existing.completedDates.filter((value) => value !== date)
          : [...existing.completedDates, date];
        const updatedAt = new Date().toISOString();
        set((state) => ({
          habits: upsertById(state.habits, {
            ...existing,
            completedDates: nextCompletedDates,
            updatedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "habit.update",
              payload: { id: habitId, changes: { completedDates: nextCompletedDates } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      addHabit: (habit) => {
        const habitId = makeId();
        const updatedAt = new Date().toISOString();
        const record: Habit = {
          ...habit,
          id: habitId,
          completedDates: [],
          updatedAt,
          version: 1,
          visibility: habit.visibility ?? "private",
          ownerId: habit.ownerId ?? "me",
        };
        set((state) => ({
          habits: [...state.habits, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "habit.create", payload: habitCreatePayload(record) },
          ],
        }));
      },

      deleteHabit: (habitId) =>
        set((state) => ({
          habits: state.habits.filter((habit) => habit.id !== habitId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "habit.delete", payload: { id: habitId } },
          ],
        })),

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (useLifeRecordsSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten
        // guard zostaje na wypadek błędu wywołania (wzór useHealthStore.ts).
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            tasks: z.array(taskSchema).parse(snapshot.tasks),
            events: z.array(eventSchema).parse(snapshot.events),
            reminders: z.array(reminderSchema).parse(snapshot.reminders),
            notes: z.array(noteSchema).parse(snapshot.notes),
            habits: z.array(habitSchema).parse(snapshot.habits),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning(
            "Nie udało się przetworzyć danych zadań/kalendarza/notatek/nawyków z serwera",
          );
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let collections: Collections = {
            tasks: state.tasks,
            events: state.events,
            reminders: state.reminders,
            notes: state.notes,
            habits: state.habits,
          };
          const remaining: PendingLifeMutation[] = [];
          const rebased: PendingLifeMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. NOT_FOUND, INVALID_CHANGES) — zdejmij z kolejki, nie
              // retry'uj w nieskończoność.
              continue;
            }

            if (result.status === "conflict" && isUpdateOp(mutation.op)) {
              // Cichy rebase: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
              // którą ta mutacja próbowała zapisać, z nowym idempotencyKey.
              const freshRecord = result.record as Record<string, unknown> | undefined;
              const currentVersion = result.currentVersion;
              if (!freshRecord || currentVersion === undefined) continue;
              const payload = mutation.payload as { id: string; changes: Record<string, unknown> };
              collections = upsertByUpdateOp(
                mutation.op,
                { ...freshRecord, ...payload.changes },
                collections,
              );
              rebased.push({
                idempotencyKey: makeId(),
                op: mutation.op,
                payload: { id: payload.id, changes: payload.changes },
                baseVersion: currentVersion,
              });
              continue;
            }

            // applied / duplicate / conflict na *.create (kolizja deterministycznego id serii,
            // kod ID_TAKEN) — zaadoptuj zwrócony rekord tak samo jak przy sukcesie.
            collections = reconcileTerminal(mutation, result, collections);
          }

          return { ...collections, pendingMutations: [...remaining, ...rebased] };
        });
      },

      resetLifeRecordsData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        tasks: state.tasks,
        events: state.events,
        reminders: state.reminders,
        notes: state.notes,
        habits: state.habits,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` jest `undefined` na czystej instalacji (localStorage nigdy nie miał
        // tego klucza) — zustand's persist wywołuje `merge` bezwarunkowo, nawet gdy nie było nic
        // do deserializacji. To normalny pierwszy-raz, nie uszkodzenie, więc musi zostać ciche;
        // tylko realnie-obecna-ale-złego-kształtu wartość jest prawdziwym ostrzeżeniem
        // "niezgodny format" (patrz useHealthStore.ts/usePetsStore.ts/useCarStore.ts — ta sama
        // luka #3).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis zadań/kalendarza/notatek/nawyków miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const tasks = parseArrayField(state.tasks, taskSchema);
        const events = parseArrayField(state.events, eventSchema);
        const reminders = parseArrayField(state.reminders, reminderSchema);
        const notes = parseArrayField(state.notes, noteSchema);
        const habits = parseArrayField(state.habits, habitSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount =
          tasks.dropped +
          events.dropped +
          reminders.dropped +
          notes.dropped +
          habits.dropped +
          pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych zadań/kalendarza/notatek/nawyków była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          tasks: tasks.items,
          events: events.items,
          reminders: reminders.items,
          notes: notes.items,
          habits: habits.items,
          pendingMutations: pendingMutations.items as PendingLifeMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);
