import { describe, expect, it } from "vitest";
import { createSampleData } from "../data/sampleData";
import { createAdvancedData } from "../data/advancedData";
import {
  BACKUP_SCHEMA_VERSION,
  backupEnvelopeSchema,
  lifeDataSchema,
  advancedDataSchema,
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
