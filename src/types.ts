import type { Visibility } from "./advancedTypes";

export type ViewId =
  | "today"
  | "tasks"
  | "calendar"
  | "notes"
  | "habits"
  | "finance"
  | "trips"
  | "subscriptions"
  | "meals"
  | "car"
  | "pets"
  | "health"
  | "settings";

export type Priority = "low" | "medium" | "high";
export type TaskStatus = "todo" | "done";
export type Theme = "light" | "dark" | "system";
export type Energy = "low" | "medium" | "high";

// Powtarzalność wydarzeń (patrz docs/plans/zadania-wydarzenia-powtarzalne.md;
// docs/plans/zadania-redefinicja.md odpiął powtarzalność od zadań -- zostaje wyłącznie dla
// `CalendarEvent`). Wariant A: reguła jest replikowana na każdym zmaterializowanym wystąpieniu
// (self-describing), obok stabilnego `seriesId` i porządkowego `seriesIndex`.
export type RecurrenceFreq = "daily" | "weekly" | "monthly";

export interface Recurrence {
  freq: RecurrenceFreq;
  interval: number; // co ile jednostek (dni/tygodni/miesięcy), liczba całkowita >= 1
  weekdays?: number[]; // TYLKO dla freq="weekly"; ISO 1=pon … 7=niedz, posortowane, unikalne, min. 1
  count?: number; // limit liczby wystąpień (>= 1), liczony od kotwicy; brak = bezterminowo
  anchorDate: string; // "yyyy-MM-dd" — data wystąpienia seriesIndex=0 (start serii)
  anchorTime?: string; // "HH:mm" — godzina startu wystąpienia serii
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  tags: string[];
  isFocus: boolean;
  energy: Energy;
  createdAt: string;
  version: number;
  updatedAt: string;
  completedAt?: string;
  ownerId?: string;
  visibility?: Visibility;
}

export type EventKind = "meeting" | "focus" | "personal";

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  kind: EventKind;
  location?: string;
  notes?: string;
  source?: "manual" | "google";
  externalId?: string;
  externalUpdatedAt?: string;
  version: number;
  updatedAt: string;
  ownerId?: string;
  visibility?: Visibility;
  seriesId?: string;
  seriesIndex?: number;
  recurrence?: Recurrence;
}

export interface Reminder {
  id: string;
  title: string;
  date: string;
  time: string;
  done: boolean;
  notifiedAt?: string;
  version: number;
  updatedAt: string;
  ownerId?: string;
  visibility?: Visibility;
}

export type NoteColor = "cream" | "mint" | "sky" | "lilac";

export interface Note {
  id: string;
  title: string;
  content: string;
  color: NoteColor;
  pinned: boolean;
  createdAt: string;
  version: number;
  updatedAt: string;
  ownerId?: string;
  visibility?: Visibility;
}

export interface Habit {
  id: string;
  name: string;
  icon: "water" | "walk" | "read" | "stretch" | "meditate";
  targetLabel: string;
  completedDates: string[];
  version: number;
  updatedAt: string;
  ownerId?: string;
  visibility?: Visibility;
}

export interface Preferences {
  name: string;
  theme: Theme;
  notificationsEnabled: boolean;
  weekStartsOnMonday: boolean;
}

// `LifeData` niesie dziś WYŁĄCZNIE 4 pola osobiste (`scratchpad`/`intention`/`energy`/
// `preferences`) — nadal synchronizowane przez dokument JSONB workspace/`WorkspaceSync`. Pięć
// kolekcji Life (`tasks`/`events`/`reminders`/`notes`/`habits`) ma własne znormalizowane tabele
// SQL (server/migrations/013_life_normalized.sql) i żyje w `LifeRecordsData` niżej — patrz
// docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("KLUCZOWE: co ZOSTAJE w JSONB, a co
// odchodzi").
export interface LifeData {
  scratchpad: string;
  intention: string;
  energy: Energy;
  preferences: Preferences;
}

// Snapshot znormalizowanych kolekcji Life (`GET /api/v1/life`) — każdy rekord niesie `version`
// (optymistyczna współbieżność per rekord, bez pola agregującego, bez wyjątku — jak Zdrowie/
// Subskrypcje). Wspólny typ dla frontendu (`useLifeRecordsStore`) — backend (`server/src/life.mjs`)
// nie importuje z `src/` i odzwierciedla ten kształt ręcznie.
export interface LifeRecordsData {
  tasks: Task[];
  events: CalendarEvent[];
  reminders: Reminder[];
  notes: Note[];
  habits: Habit[];
}

export type QuickAddType = "task" | "event" | "reminder" | "note";
