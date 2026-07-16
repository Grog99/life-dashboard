// Wspólny formularz reguły powtarzania (freq / interval / dni tygodnia / limit).
// Reużywany przez QuickAddModal oraz modale edycji zadań i wydarzeń, żeby logika
// budowania reguły i UI istniały w jednym miejscu (patrz docs/plans/zadania-wydarzenia-powtarzalne.md).
import { useState } from "react";
import { WEEKDAY_LABELS } from "../lib/recurrence";
import type { Recurrence, RecurrenceFreq } from "../types";

export interface RecurrenceForm {
  freq: RecurrenceFreq;
  interval: string;
  weekdays: number[];
  count: string;
  setFreq: (value: RecurrenceFreq) => void;
  setInterval: (value: string) => void;
  setCount: (value: string) => void;
  setWeekdays: (value: number[]) => void;
  toggleWeekday: (iso: number) => void;
  /** Przywraca stan formularza do podanej reguły (lub wartości domyślnych). */
  reset: (recurrence?: Recurrence) => void;
  /** Buduje regułę; anchorDate/anchorTime dostarcza wywołujący (nowy przy tworzeniu, zachowany przy edycji). */
  build: (anchorDate: string, anchorTime?: string) => Recurrence;
  /** Czy stan różni się od podanej reguły — do wykrywania niezapisanych zmian. */
  differsFrom: (recurrence?: Recurrence) => boolean;
}

const normalizeWeekdays = (freq: RecurrenceFreq, weekdays: number[]): number[] | undefined =>
  freq === "weekly" && weekdays.length ? [...weekdays].sort((a, b) => a - b) : undefined;

const parsedInterval = (value: string) => Math.max(1, Number(value) || 1);
const parsedCount = (value: string) => (value ? Math.max(1, Number(value) || 1) : undefined);

// eslint-disable-next-line react-refresh/only-export-components -- hook celowo współdzielony z komponentem RecurrenceFields w tym samym pliku (patrz komentarz na górze pliku); podział na osobne pliki nie jest wart utraty spójności.
export function useRecurrenceForm(initial?: Recurrence): RecurrenceForm {
  const [freq, setFreq] = useState<RecurrenceFreq>(initial?.freq ?? "weekly");
  const [interval, setInterval] = useState(String(initial?.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? []);
  const [count, setCount] = useState(initial?.count ? String(initial.count) : "");

  const toggleWeekday = (iso: number) =>
    setWeekdays((current) =>
      current.includes(iso)
        ? current.filter((value) => value !== iso)
        : [...current, iso].sort((a, b) => a - b),
    );

  const reset = (recurrence?: Recurrence) => {
    setFreq(recurrence?.freq ?? "weekly");
    setInterval(String(recurrence?.interval ?? 1));
    setWeekdays(recurrence?.weekdays ?? []);
    setCount(recurrence?.count ? String(recurrence.count) : "");
  };

  const build = (anchorDate: string, anchorTime?: string): Recurrence => ({
    freq,
    interval: parsedInterval(interval),
    weekdays: normalizeWeekdays(freq, weekdays),
    count: parsedCount(count),
    anchorDate,
    anchorTime,
  });

  const differsFrom = (recurrence?: Recurrence): boolean => {
    if (!recurrence) return false;
    const currentWeekdays = normalizeWeekdays(freq, weekdays);
    const recurrenceWeekdays =
      recurrence.weekdays && recurrence.weekdays.length
        ? [...recurrence.weekdays].sort((a, b) => a - b)
        : undefined;
    return (
      freq !== recurrence.freq ||
      parsedInterval(interval) !== recurrence.interval ||
      JSON.stringify(currentWeekdays ?? null) !== JSON.stringify(recurrenceWeekdays ?? null) ||
      parsedCount(count) !== recurrence.count
    );
  };

  return {
    freq,
    interval,
    weekdays,
    count,
    setFreq,
    setInterval,
    setCount,
    setWeekdays,
    toggleWeekday,
    reset,
    build,
    differsFrom,
  };
}

export function RecurrenceFields({ form }: { form: RecurrenceForm }) {
  return (
    <div className="quick-add-details repeat-panel">
      <div className="form-grid form-grid--3">
        <label className="field">
          <span>Co ile</span>
          <select
            value={form.freq}
            onChange={(event) => form.setFreq(event.target.value as RecurrenceFreq)}
          >
            <option value="daily">Dni</option>
            <option value="weekly">Tygodni</option>
            <option value="monthly">Miesięcy</option>
          </select>
        </label>
        <label className="field">
          <span>Co ile jednostek</span>
          <input
            type="number"
            min={1}
            value={form.interval}
            onChange={(event) => form.setInterval(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Zakończ po (opcjonalnie)</span>
          <input
            type="number"
            min={1}
            placeholder="Bez limitu"
            value={form.count}
            onChange={(event) => form.setCount(event.target.value)}
          />
        </label>
      </div>
      {form.freq === "weekly" && (
        <fieldset className="weekday-picker">
          <legend>Dni tygodnia</legend>
          {WEEKDAY_LABELS.map(({ iso, label }) => (
            <button
              type="button"
              key={iso}
              className={form.weekdays.includes(iso) ? "active" : ""}
              aria-pressed={form.weekdays.includes(iso)}
              onClick={() => form.toggleWeekday(iso)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}
