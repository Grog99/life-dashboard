import {
  addDays,
  addMinutes,
  differenceInMinutes,
  endOfWeek,
  format,
  formatDistanceToNowStrict,
  isBefore,
  isSameDay,
  parse,
  parseISO,
  startOfDay,
  startOfWeek,
} from "date-fns";
import { pl } from "date-fns/locale";

export const DATE_KEY = "yyyy-MM-dd";

export function dateKey(date = new Date()): string {
  return format(date, DATE_KEY);
}

export function formatLongDate(date = new Date()): string {
  const formatted = format(date, "EEEE, d MMMM", { locale: pl });
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

export function formatShortDate(value: string): string {
  return format(parseISO(value), "d MMM", { locale: pl });
}

export function formatDayName(value: Date): string {
  return format(value, "EEE", { locale: pl }).replace(".", "");
}

export function weekDays(anchor = new Date(), weekStartsOnMonday = true): Date[] {
  const weekStartsOn = weekStartsOnMonday ? 1 : 0;
  const start = startOfWeek(anchor, { weekStartsOn });
  const end = endOfWeek(anchor, { weekStartsOn });
  const days: Date[] = [];
  let current = start;
  while (!isBefore(end, current)) {
    days.push(current);
    current = addDays(current, 1);
  }
  return days;
}

export function relativeDay(value: string): string {
  const date = parseISO(value);
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  if (isSameDay(date, today)) return "Dziś";
  if (isSameDay(date, tomorrow)) return "Jutro";
  if (isSameDay(date, yesterday)) return "Wczoraj";
  return format(date, "EEEE, d MMM", { locale: pl });
}

export function isOverdue(date?: string, status?: string): boolean {
  if (!date || status === "done") return false;
  return isBefore(parseISO(date), startOfDay(new Date()));
}

export function toDateTime(date: string, time: string): Date {
  return parse(`${date} ${time}`, "yyyy-MM-dd HH:mm", new Date());
}

export function relativeTime(date: string, time: string): string {
  const value = toDateTime(date, time);
  if (isBefore(value, new Date())) return "teraz";
  return `za ${formatDistanceToNowStrict(value, { locale: pl })}`;
}

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 11) return "Dzień dobry";
  if (hour < 18) return "Miłego popołudnia";
  return "Dobry wieczór";
}

export function formatMinutes(minutes?: number): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Różnica w minutach między dwiema godzinami "HH:mm" (używane przy przeliczaniu wystąpień serii wydarzeń). */
export function durationMinutes(startTime: string, endTime: string): number {
  const base = new Date(2000, 0, 1);
  return differenceInMinutes(parse(endTime, "HH:mm", base), parse(startTime, "HH:mm", base));
}

/** Dodaje minuty do godziny "HH:mm", zwraca "HH:mm" (zachowanie czasu trwania przy generowaniu wystąpień). */
export function addMinutesToTime(time: string, minutes: number): string {
  const base = new Date(2000, 0, 1);
  return format(addMinutes(parse(time, "HH:mm", base), minutes), "HH:mm");
}
