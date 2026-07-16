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

// Powtarzalność zadań/wydarzeń (patrz docs/plans/zadania-wydarzenia-powtarzalne.md).
// Wariant A: reguła jest replikowana na każdym zmaterializowanym wystąpieniu
// (self-describing), obok stabilnego `seriesId` i porządkowego `seriesIndex`.
export type RecurrenceFreq = "daily" | "weekly" | "monthly";

export interface Recurrence {
  freq: RecurrenceFreq;
  interval: number; // co ile jednostek (dni/tygodni/miesięcy), liczba całkowita >= 1
  weekdays?: number[]; // TYLKO dla freq="weekly"; ISO 1=pon … 7=niedz, posortowane, unikalne, min. 1
  count?: number; // limit liczby wystąpień (>= 1), liczony od kotwicy; brak = bezterminowo
  anchorDate: string; // "yyyy-MM-dd" — data wystąpienia seriesIndex=0 (start serii)
  anchorTime?: string; // "HH:mm" — dla eventów startTime kotwicy; task może nie mieć godziny
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  date?: string;
  time?: string;
  estimatedMinutes?: number;
  category: string;
  isFocus: boolean;
  energy: Energy;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  ownerId?: string;
  visibility?: Visibility;
  seriesId?: string;
  seriesIndex?: number;
  recurrence?: Recurrence;
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

export interface LifeData {
  tasks: Task[];
  events: CalendarEvent[];
  reminders: Reminder[];
  notes: Note[];
  habits: Habit[];
  scratchpad: string;
  intention: string;
  energy: Energy;
  preferences: Preferences;
}

export type QuickAddType = "task" | "event" | "reminder" | "note";
