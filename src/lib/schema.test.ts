import { describe, expect, it } from "vitest";
import { createSampleData } from "../data/sampleData";
import { createAdvancedData } from "../data/advancedData";
import {
  BACKUP_SCHEMA_VERSION,
  backupEnvelopeSchema,
  lifeDataSchema,
  advancedDataSchema,
  eventSchema,
  recurrenceSchema,
  reminderSchema,
  taskSchema,
} from "./schema";

describe("lifeDataSchema", () => {
  it("przyjmuje dane startowe", () => {
    expect(lifeDataSchema.safeParse(createSampleData()).success).toBe(true);
  });

  // Przypomnienia mają teraz własną znormalizowaną tabelę SQL (server/migrations/013_life_normalized.sql)
  // i nie są już częścią `lifeDataSchema` (patrz "KLUCZOWE: co ZOSTAJE w JSONB, a co odchodzi") —
  // walidacja semantyczna daty/godziny przechodzi bezpośrednio przez `reminderSchema`.
  it("odrzuca semantycznie błędną datę i godzinę", () => {
    const reminder = {
      id: "r1",
      title: "Przypomnienie",
      date: "2026-99-99",
      time: "29:99",
      done: false,
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(reminderSchema.safeParse(reminder).success).toBe(false);
  });

  it("waliduje wersjonowaną kopię danych", () => {
    const backup = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: "1.0.0",
      exportedAt: new Date().toISOString(),
      timezone: "Europe/Warsaw",
      data: createSampleData(),
    };
    expect(backupEnvelopeSchema.safeParse(backup).success).toBe(true);
    expect(backupEnvelopeSchema.safeParse({ ...backup, schemaVersion: 99 }).success).toBe(false);
  });

  it("waliduje wszystkie moduły zaawansowane", () => {
    // Subskrypcje nie są już częścią advancedDataSchema (docs/plans/subskrypcje-sql.md) — mają
    // własny schemat (subscriptionSchema) walidujący snapshot/mutacje `/api/v1/subscriptions`,
    // pokryty w src/store/useSubscriptionsStore.test.ts (etap Testy planu).
    const data = createAdvancedData();
    expect(advancedDataSchema.safeParse(data).success).toBe(true);
    expect(
      advancedDataSchema.safeParse({ ...data, householdMembers: [{ id: "bad" }] }).success,
    ).toBe(false);
  });
});

describe("recurrence (powtarzalność serii)", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const validRecurrence = {
    freq: "weekly" as const,
    interval: 2,
    weekdays: [1, 3, 5],
    count: 5,
    anchorDate: "2026-03-02",
    anchorTime: "09:00",
  };
  // Zadania straciły powtarzalność (docs/plans/zadania-redefinicja.md) — `recurrence`/`seriesId`/
  // `seriesIndex` istnieją WYŁĄCZNIE na `CalendarEvent`, więc `baseTask` niżej ma wolne `tags`
  // zamiast sztywnej `category`, bez żadnych pól serii.
  const baseTask = {
    id: "t1",
    title: "Sprzątanie",
    status: "todo" as const,
    priority: "medium" as const,
    tags: ["Dom"],
    isFocus: false,
    energy: "low" as const,
    createdAt: timestamp,
    version: 1,
    updatedAt: timestamp,
  };
  const baseEvent = {
    id: "e1",
    title: "Trening",
    date: "2026-03-02",
    startTime: "09:00",
    endTime: "10:00",
    kind: "personal" as const,
    version: 1,
    updatedAt: timestamp,
  };

  it("przyjmuje poprawną regułę i pola serii na wydarzeniu", () => {
    expect(recurrenceSchema.safeParse(validRecurrence).success).toBe(true);
    expect(
      eventSchema.safeParse({
        ...baseEvent,
        seriesId: "s1",
        seriesIndex: 3,
        recurrence: validRecurrence,
      }).success,
    ).toBe(true);
  });

  it("zachowuje wsteczną zgodność — brak pól serii jest poprawny", () => {
    expect(taskSchema.safeParse(baseTask).success).toBe(true);
    expect(eventSchema.safeParse(baseEvent).success).toBe(true);
  });

  // `taskSchema` odrzuca nadmiarowe klucze CICHO (zod `.object()` domyślnie je ignoruje) --
  // stare zadania z localStorage niosące `date`/`category`/`seriesId`/`seriesIndex`/`recurrence`
  // (sprzed tej redefinicji) nadal parsują się poprawnie, po prostu bez tych pól w wyniku.
  it("ignoruje ciszej usunięte pola zadania (date/category/seriesId/seriesIndex/recurrence)", () => {
    const legacyTask = {
      ...baseTask,
      date: "2026-03-02",
      time: "09:00",
      estimatedMinutes: 30,
      category: "Dom",
      seriesId: "s1",
      seriesIndex: 0,
      recurrence: validRecurrence,
    };
    const result = taskSchema.safeParse(legacyTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("date");
      expect(result.data).not.toHaveProperty("category");
      expect(result.data).not.toHaveProperty("seriesId");
      expect(result.data.tags).toEqual(["Dom"]);
    }
  });

  it("odrzuca interval < 1", () => {
    expect(recurrenceSchema.safeParse({ ...validRecurrence, interval: 0 }).success).toBe(false);
    expect(
      eventSchema.safeParse({ ...baseEvent, recurrence: { ...validRecurrence, interval: 0 } })
        .success,
    ).toBe(false);
  });

  it("odrzuca dzień tygodnia spoza zakresu 1–7", () => {
    expect(recurrenceSchema.safeParse({ ...validRecurrence, weekdays: [8] }).success).toBe(false);
    expect(recurrenceSchema.safeParse({ ...validRecurrence, weekdays: [] }).success).toBe(false);
  });

  it("odrzuca count < 1 i niepoprawną datę kotwicy", () => {
    expect(recurrenceSchema.safeParse({ ...validRecurrence, count: 0 }).success).toBe(false);
    expect(
      recurrenceSchema.safeParse({ ...validRecurrence, anchorDate: "2026-13-40" }).success,
    ).toBe(false);
  });
});
