// Powtarzalność zadań/wydarzeń — patrz docs/plans/zadania-wydarzenia-powtarzalne.md.
// Czysta logika serii (Wariant A: pola serii bezpośrednio na Task/CalendarEvent),
// bez zależności od zustand — łatwa do przetestowania w izolacji.
import { addDays, addMonths, addWeeks, getISODay, isBefore, parseISO } from "date-fns";
import { dateKey } from "./date";
import type { Recurrence } from "../types";

/** Rozmiar okna materializacji przyszłych wystąpień (patrz „Decyzje doprecyzowujące" w planie). */
export const SERIES_WINDOW = 10;

/** Etykiety dni tygodnia (ISO 1=pon…7=niedz) — współdzielone przez formularze tworzenia/edycji serii. */
export const WEEKDAY_LABELS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: "Pon" },
  { iso: 2, label: "Wt" },
  { iso: 3, label: "Śr" },
  { iso: 4, label: "Czw" },
  { iso: 5, label: "Pt" },
  { iso: 6, label: "Sob" },
  { iso: 7, label: "Ndz" },
];

export interface Occurrence {
  date: string;
  time?: string;
}

/** Minimalny kształt pozycji serii wymagany przez logikę poniżej (Task lub CalendarEvent). */
export interface SeriesItem {
  id: string;
  date?: string;
  seriesId?: string;
  seriesIndex?: number;
  recurrence?: Recurrence;
}

/**
 * Dla trybu `weekly` z wybranymi dniami tygodnia: dopasowuje datę kotwicy do pierwszego
 * dnia >= `fromDate`, którego dzień ISO tygodnia (1=pon…7=niedz) znajduje się w `weekdays`.
 * Używane przez UI przy tworzeniu serii, żeby `anchorDate` zawsze spełniał wymóg z planu
 * („anchorDate jest pierwszym zaznaczonym dniem tygodnia w dniu/po dniu wybranym przez użytkownika").
 */
export function alignWeeklyAnchor(fromDate: string, weekdays: number[]): string {
  if (!weekdays.length) return fromDate;
  const from = parseISO(fromDate);
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = addDays(from, offset);
    if (weekdays.includes(getISODay(candidate))) return dateKey(candidate);
  }
  return fromDate;
}

/** Mapuje `seriesIndex` na datę/godzinę wystąpienia — deterministycznie, tylko z `Recurrence`. */
export function occurrenceDate(recurrence: Recurrence, index: number): Occurrence {
  const anchor = parseISO(recurrence.anchorDate);
  const interval = Math.max(1, Math.trunc(recurrence.interval) || 1);
  const time = recurrence.anchorTime;

  if (recurrence.freq === "daily") {
    return { date: dateKey(addDays(anchor, index * interval)), time };
  }

  if (recurrence.freq === "weekly" && recurrence.weekdays && recurrence.weekdays.length > 0) {
    const weekdays = [...new Set(recurrence.weekdays)].sort((a, b) => a - b);
    // Stały poniedziałek ISO jako początek tygodnia w generatorze — niezależnie od
    // preferencji użytkownika (preferences.weekStartsOnMonday) — dla determinizmu
    // między urządzeniami/kontami (patrz „Ryzyka" w planie).
    const anchorWeekStart = addDays(anchor, -(getISODay(anchor) - 1));
    const dates: Date[] = [];
    let block = 0;
    while (dates.length <= index && block < 10_000) {
      const weekStart = addWeeks(anchorWeekStart, block * interval);
      for (const isoDay of weekdays) {
        const candidate = addDays(weekStart, isoDay - 1);
        if (isBefore(candidate, anchor)) continue; // pomiń dni przed kotwicą
        dates.push(candidate);
      }
      block += 1;
    }
    const target = dates[index] ?? dates[dates.length - 1];
    return { date: dateKey(target), time };
  }

  if (recurrence.freq === "weekly") {
    return { date: dateKey(addWeeks(anchor, index * interval)), time };
  }

  // monthly — addMonths klampuje przepełnienie (31 → ostatni dzień krótszego miesiąca).
  return { date: dateKey(addMonths(anchor, index * interval)), time };
}

/**
 * Buduje wystąpienie serii dla danego indeksu na bazie istniejącej pozycji (`base`).
 * Zmienia tylko pola wspólne dla serii (`id`, `date`, `seriesId`, `seriesIndex`, `recurrence`);
 * pola specyficzne dla treści (tytuł, godziny, kategoria…) pochodzą z `base` i muszą być
 * przygotowane przez wywołującego (np. `startTime`/`endTime` z zachowanym czasem trwania).
 */
export function buildSeriesOccurrence<T extends SeriesItem>(
  base: T,
  recurrence: Recurrence,
  seriesId: string,
  index: number,
): T {
  const { date } = occurrenceDate(recurrence, index);
  return { ...base, id: `${seriesId}#${index}`, seriesId, seriesIndex: index, recurrence, date };
}

/**
 * Rozwija okno przyszłych wystąpień dla każdej serii obecnej w `items`.
 * Zasady (patrz „Gdzie i kiedy następuje materializacja" w planie):
 * - tylko dodawanie w przód (frontier) — nowe indeksy > max(seriesIndex istniejących);
 * - nigdy nie nadpisuje istniejących wystąpień (chroni np. `status: "done"`);
 * - respektuje limit `count`;
 * - idempotentne — brak zmian, gdy okno jest już pełne (zwraca to samo `items` przez referencję,
 *   żeby wywołujący mógł wykryć no-op i uniknąć zbędnego zapisu/sync).
 */
export function expandSeries<T extends SeriesItem>(items: T[], today: string, window = SERIES_WINDOW): T[] {
  const bySeries = new Map<string, T[]>();
  for (const item of items) {
    if (!item.seriesId) continue;
    const list = bySeries.get(item.seriesId);
    if (list) list.push(item);
    else bySeries.set(item.seriesId, [item]);
  }

  const additions: T[] = [];
  for (const [seriesId, seriesItems] of bySeries) {
    const recurrence = seriesItems.find((item) => item.recurrence)?.recurrence;
    if (!recurrence) continue;

    let maxIndex = -1;
    let template = seriesItems[0];
    let futureCount = 0;
    for (const item of seriesItems) {
      if ((item.seriesIndex ?? -1) > maxIndex) {
        maxIndex = item.seriesIndex ?? -1;
        template = item;
      }
      if (item.date && item.date >= today) futureCount += 1;
    }

    let index = maxIndex + 1;
    let added = futureCount;
    while (added < window) {
      if (recurrence.count !== undefined && index >= recurrence.count) break;
      additions.push(buildSeriesOccurrence(template, recurrence, seriesId, index));
      added += 1;
      index += 1;
    }
  }

  return additions.length ? [...items, ...additions] : items;
}

/** Podgląd kolejnych dat serii (np. w formularzu tworzenia) — nie materializuje niczego. */
export function nextOccurrences(recurrence: Recurrence, count: number): string[] {
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (recurrence.count !== undefined && index >= recurrence.count) break;
    result.push(occurrenceDate(recurrence, index).date);
  }
  return result;
}
