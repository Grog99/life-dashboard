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
  | "health"
  | "settings";

export type Priority = "low" | "medium" | "high";
export type TaskStatus = "todo" | "done";
export type Theme = "light" | "dark" | "system";
export type Energy = "low" | "medium" | "high";

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
