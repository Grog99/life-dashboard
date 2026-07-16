import { describe, expect, it } from "vitest";
import { getISODay, parseISO } from "date-fns";
import {
  alignWeeklyAnchor,
  buildSeriesOccurrence,
  expandSeries,
  nextOccurrences,
  occurrenceDate,
  SERIES_WINDOW,
  type SeriesItem,
} from "./recurrence";
import type { Recurrence } from "../types";

const iso = (value: string) => getISODay(parseISO(value));

describe("occurrenceDate — determinizm generowania dat", () => {
  it("daily: kotwica + index * interval dni", () => {
    const rec: Recurrence = { freq: "daily", interval: 1, anchorDate: "2026-03-01" };
    expect(occurrenceDate(rec, 0).date).toBe("2026-03-01");
    expect(occurrenceDate(rec, 5).date).toBe("2026-03-06");
    const every2: Recurrence = { freq: "daily", interval: 2, anchorDate: "2026-03-01" };
    expect(occurrenceDate(every2, 3).date).toBe("2026-03-07");
  });

  it("weekly bez dni tygodnia: kotwica + index * interval tygodni", () => {
    const rec: Recurrence = { freq: "weekly", interval: 1, anchorDate: "2026-03-02" };
    expect(occurrenceDate(rec, 0).date).toBe("2026-03-02");
    expect(occurrenceDate(rec, 2).date).toBe("2026-03-16");
    const every2: Recurrence = { freq: "weekly", interval: 2, anchorDate: "2026-03-02" };
    expect(occurrenceDate(every2, 2).date).toBe("2026-03-30");
  });

  it("weekly z dniami tygodnia: chronologicznie, każda data w wybranym dniu, index 0 = kotwica", () => {
    const anchorDate = "2026-03-02";
    const anchorISO = iso(anchorDate);
    const weekdays = [...new Set([anchorISO, (anchorISO % 7) + 1])].sort((a, b) => a - b);
    const rec: Recurrence = { freq: "weekly", interval: 1, weekdays, anchorDate };

    // Kotwica jest zaznaczonym dniem tygodnia → index 0 równy kotwicy.
    expect(occurrenceDate(rec, 0).date).toBe(anchorDate);

    const dates = Array.from({ length: 6 }, (_, i) => occurrenceDate(rec, i).date);
    // Ściśle rosnące.
    for (let i = 1; i < dates.length; i += 1) {
      expect(dates[i] > dates[i - 1]).toBe(true);
    }
    // Każde wystąpienie wypada w jednym z wybranych dni tygodnia.
    for (const date of dates) {
      expect(weekdays).toContain(iso(date));
    }
  });

  it("monthly: klamp 31 → ostatni dzień krótszego miesiąca (2026 nieprzestępny)", () => {
    const rec: Recurrence = { freq: "monthly", interval: 1, anchorDate: "2026-01-31" };
    expect(occurrenceDate(rec, 0).date).toBe("2026-01-31");
    expect(occurrenceDate(rec, 1).date).toBe("2026-02-28"); // luty → klamp
    expect(occurrenceDate(rec, 2).date).toBe("2026-03-31");
    expect(occurrenceDate(rec, 3).date).toBe("2026-04-30"); // kwiecień → klamp
  });

  it("przenosi anchorTime do wystąpienia", () => {
    const rec: Recurrence = { freq: "daily", interval: 1, anchorDate: "2026-03-01", anchorTime: "07:30" };
    expect(occurrenceDate(rec, 2).time).toBe("07:30");
  });
});

describe("alignWeeklyAnchor", () => {
  it("zwraca pierwszy dzień >= wskazanego, który jest wybranym dniem tygodnia", () => {
    const from = "2026-03-02";
    const fromISO = iso(from);
    const targetISO = (fromISO % 7) + 1; // dzień po `from`
    const aligned = alignWeeklyAnchor(from, [targetISO]);
    expect(iso(aligned)).toBe(targetISO);
    expect(aligned >= from).toBe(true);
  });

  it("nie zmienia daty, gdy jej dzień tygodnia jest już wybrany", () => {
    const from = "2026-03-02";
    expect(alignWeeklyAnchor(from, [iso(from)])).toBe(from);
  });
});

describe("buildSeriesOccurrence", () => {
  it("nadaje deterministyczne id = seriesId#index i pola serii", () => {
    const rec: Recurrence = { freq: "daily", interval: 1, anchorDate: "2026-03-01" };
    const occ = buildSeriesOccurrence<SeriesItem>({ id: "ignored" }, rec, "s1", 4);
    expect(occ.id).toBe("s1#4");
    expect(occ.seriesId).toBe("s1");
    expect(occ.seriesIndex).toBe(4);
    expect(occ.date).toBe(occurrenceDate(rec, 4).date);
    expect(occ.recurrence).toBe(rec);
  });
});

describe("expandSeries — rozwijanie okna", () => {
  const rec: Recurrence = { freq: "daily", interval: 1, anchorDate: "2026-03-01" };
  const seed = () => buildSeriesOccurrence<SeriesItem>({ id: "x" }, rec, "s1", 0);

  it("dosuwa okno do SERIES_WINDOW przyszłych wystąpień z deterministycznymi id", () => {
    const grown = expandSeries<SeriesItem>([seed()], "2026-03-01");
    expect(grown).toHaveLength(SERIES_WINDOW);
    expect(grown.map((item) => item.id)).toEqual(
      Array.from({ length: SERIES_WINDOW }, (_, i) => `s1#${i}`),
    );
  });

  it("jest idempotentne — drugie wywołanie nie dodaje nic (ta sama referencja)", () => {
    const grown = expandSeries<SeriesItem>([seed()], "2026-03-01");
    expect(expandSeries<SeriesItem>(grown, "2026-03-01")).toBe(grown);
  });

  it("rozwija tylko w przód (frontier) — nie wskrzesza usuniętego wystąpienia ze środka", () => {
    const grown = expandSeries<SeriesItem>([seed()], "2026-03-01");
    const withoutMiddle = grown.filter((item) => item.id !== "s1#5");
    const regrown = expandSeries<SeriesItem>(withoutMiddle, "2026-03-01");
    const ids = regrown.map((item) => item.id);
    expect(ids).not.toContain("s1#5"); // usunięte nie wraca
    expect(ids).toContain("s1#10"); // dosunięte na froncie
    expect(regrown).toHaveLength(SERIES_WINDOW);
  });

  it("respektuje limit count", () => {
    const capped: Recurrence = { freq: "daily", interval: 1, count: 3, anchorDate: "2026-03-01" };
    const seedCapped = buildSeriesOccurrence<SeriesItem>({ id: "y" }, capped, "s2", 0);
    expect(expandSeries<SeriesItem>([seedCapped], "2026-03-01")).toHaveLength(3);
  });

  it("dwa niezależne rozwinięcia dają identyczne id (bezpieczne dla scalania między urządzeniami)", () => {
    const a = expandSeries<SeriesItem>([seed()], "2026-03-01").map((item) => item.id);
    const b = expandSeries<SeriesItem>([seed()], "2026-03-01").map((item) => item.id);
    expect(a).toEqual(b);
  });

  it("catch-up: zaległa seria materializuje wyłącznie wystąpienia od dziś, nie w przeszłości", () => {
    // Ostatnie zmaterializowane wystąpienie (index 5) wypada 2026-03-06 — daleko przed `today`.
    const stale = buildSeriesOccurrence<SeriesItem>({ id: "x" }, rec, "s1", 5);
    const today = "2026-04-01";
    const grown = expandSeries<SeriesItem>([stale], today);
    const added = grown.filter((item) => item.id !== "s1#5");
    expect(added).toHaveLength(SERIES_WINDOW); // dosunięto pełne okno
    expect(added.every((item) => Boolean(item.date && item.date >= today))).toBe(true); // żadnego wystąpienia w przeszłości
  });
});

describe("nextOccurrences — podgląd dat", () => {
  it("zwraca kolejne daty i respektuje count", () => {
    const rec: Recurrence = { freq: "daily", interval: 1, anchorDate: "2026-03-01" };
    expect(nextOccurrences(rec, 3)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    const capped: Recurrence = { freq: "daily", interval: 1, count: 2, anchorDate: "2026-03-01" };
    expect(nextOccurrences(capped, 5)).toHaveLength(2);
  });
});
