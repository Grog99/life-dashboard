import { describe, expect, it } from "vitest";
import { parseSmartCapture } from "./smartCapture";

const now = new Date(2026, 6, 10, 9, 0, 0);

describe("parseSmartCapture", () => {
  it("rozpoznaje jutro i pełną godzinę", () => {
    expect(parseSmartCapture("Dentysta jutro o 14:30", now)).toEqual({
      title: "Dentysta",
      date: "2026-07-11",
      time: "14:30",
    });
  });

  it("rozpoznaje dzisiaj i godzinę bez minut", () => {
    expect(parseSmartCapture("Oddzwonić do taty dziś o 19", now)).toEqual({
      title: "Oddzwonić do taty",
      date: "2026-07-10",
      time: "19:00",
    });
  });

  it("zostawia zwykły tytuł bez zmian", () => {
    expect(parseSmartCapture("Kupić baterie AAA", now)).toEqual({
      title: "Kupić baterie AAA",
      date: undefined,
      time: undefined,
    });
  });

  it("nie myli wersji i daty z godziną", () => {
    expect(parseSmartCapture("Sprawdzić wersję 2.15 z 10.07.2026", now)).toEqual({
      title: "Sprawdzić wersję 2.15 z 10.07.2026",
      date: undefined,
      time: undefined,
    });
  });

  it("nie wycina liczby z normalnego zdania", () => {
    expect(parseSmartCapture("Porozmawiać o 2 projektach", now).title).toBe(
      "Porozmawiać o 2 projektach",
    );
  });
});
