// Typy modułu Zdrowie (Health). Od docs/plans/zdrowie-sql.md dane Zdrowia (healthAppointments/
// medications/healthMeasurements) nie są już częścią dokumentu JSONB (AdvancedData) — mają
// własne znormalizowane tabele SQL (server/migrations/011_health_normalized.sql) z optymistyczną
// współbieżnością per rekord (pole `version`, bez wyjątku — Zdrowie nie ma pola agregującego jak
// `Vehicle.mileage`). Ten plik jest wspólnym źródłem prawdy dla backendu i frontendu Zdrowia
// (wzór: src/petsTypes.ts).
//
// W ODRÓŻNIENIU od Zwierząt/Auta, trzy kolekcje Zdrowia są całkowicie NIEZALEŻNE — brak relacji
// rodzic/dziecko (żadnego `petId`/`vehicleId`-podobnego FK między nimi). Wszystkie trzy nadal
// rozszerzają `SharedMeta` (`ownerId`/`visibility`) i zachowują rozróżnienie prywatne/wspólne per
// rekord, jak `Pet`/`PetExpense`/`PetVisit`.

import type { SharedMeta } from "./financeTypes";

export interface HealthAppointment extends SharedMeta {
  id: string;
  title: string;
  clinician: string;
  specialty?: string;
  date: string; // isoDate
  time: string; // clockTime — potrzebne dla push -24 h
  location?: string;
  status: "scheduled" | "completed" | "cancelled";
  notes?: string;
  version: number;
  updatedAt: string;
}

export interface Medication extends SharedMeta {
  id: string;
  name: string;
  dosage: string;
  schedule: string; // wolnotekstowa etykieta, nie structured recurrence
  active: boolean;
  lastTakenOn?: string; // isoDate — prawdziwy toggle liczony po stronie klienta, jedno pole
  reminderTime?: string; // clockTime — potrzebne dla codziennego push
  version: number;
  updatedAt: string;
}

export type HealthMeasurementType =
  "weight" | "blood_pressure" | "glucose" | "temperature" | "other";

export interface HealthMeasurement extends SharedMeta {
  id: string;
  type: HealthMeasurementType;
  value: string;
  unit: string;
  // Free-form timestamp (np. "2026-07-18T07:30", bez sekund/strefy) budowany w HealthPage.tsx —
  // NIE isoDate/timestamptz (patrz docs/plans/zdrowie-sql.md "Projekt pól specjalnych").
  measuredAt: string;
  notes?: string;
  version: number;
  updatedAt: string;
}
