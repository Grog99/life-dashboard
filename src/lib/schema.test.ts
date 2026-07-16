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
  taskSchema,
} from "./schema";

describe("lifeDataSchema", () => {
  it("przyjmuje dane startowe", () => {
    expect(lifeDataSchema.safeParse(createSampleData()).success).toBe(true);
  });

  it("odrzuca semantycznie błędną datę i godzinę", () => {
    const data = createSampleData();
    data.reminders[0] = { ...data.reminders[0], date: "2026-99-99", time: "29:99" };
    expect(lifeDataSchema.safeParse(data).success).toBe(false);
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
    expect(
      backupEnvelopeSchema.safeParse({ ...backup, schemaVersion: 99 }).success,
    ).toBe(false);
  });

  it("waliduje wszystkie moduły zaawansowane, w tym zdrowie", () => {
    const data = createAdvancedData();
    expect(advancedDataSchema.safeParse(data).success).toBe(true);
    expect(advancedDataSchema.safeParse({ ...data, medications: [{ id: "bad" }] }).success).toBe(false);
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
  const baseTask = {
    id: "t1",
    title: "Sprzątanie",
    status: "todo" as const,
    priority: "medium" as const,
    category: "Dom",
    isFocus: false,
    energy: "low" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const baseEvent = {
    id: "e1",
    title: "Trening",
    date: "2026-03-02",
    startTime: "09:00",
    endTime: "10:00",
    kind: "personal" as const,
    updatedAt: timestamp,
  };

  it("przyjmuje poprawną regułę i pola serii na zadaniu oraz wydarzeniu", () => {
    expect(recurrenceSchema.safeParse(validRecurrence).success).toBe(true);
    expect(
      taskSchema.safeParse({ ...baseTask, seriesId: "s1", seriesIndex: 0, recurrence: validRecurrence }).success,
    ).toBe(true);
    expect(
      eventSchema.safeParse({ ...baseEvent, seriesId: "s1", seriesIndex: 3, recurrence: validRecurrence }).success,
    ).toBe(true);
  });

  it("zachowuje wsteczną zgodność — brak pól serii jest poprawny", () => {
    expect(taskSchema.safeParse(baseTask).success).toBe(true);
    expect(eventSchema.safeParse(baseEvent).success).toBe(true);
  });

  it("odrzuca interval < 1", () => {
    expect(recurrenceSchema.safeParse({ ...validRecurrence, interval: 0 }).success).toBe(false);
    expect(
      taskSchema.safeParse({ ...baseTask, recurrence: { ...validRecurrence, interval: 0 } }).success,
    ).toBe(false);
  });

  it("odrzuca dzień tygodnia spoza zakresu 1–7", () => {
    expect(recurrenceSchema.safeParse({ ...validRecurrence, weekdays: [8] }).success).toBe(false);
    expect(recurrenceSchema.safeParse({ ...validRecurrence, weekdays: [] }).success).toBe(false);
  });

  it("odrzuca count < 1 i niepoprawną datę kotwicy", () => {
    expect(recurrenceSchema.safeParse({ ...validRecurrence, count: 0 }).success).toBe(false);
    expect(recurrenceSchema.safeParse({ ...validRecurrence, anchorDate: "2026-13-40" }).success).toBe(false);
  });
});
