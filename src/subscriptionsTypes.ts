// Typy modułu Subskrypcje (Subscriptions). Od docs/plans/subskrypcje-sql.md dane Subskrypcji
// (subscriptions) nie są już częścią dokumentu JSONB (AdvancedData) — mają własną znormalizowaną
// tabelę SQL (server/migrations/012_subscriptions_normalized.sql) z optymistyczną współbieżnością
// per rekord (pole `version`, bez wyjątku — Subskrypcje nie mają pola agregującego jak
// `Vehicle.mileage`). Ten plik jest wspólnym źródłem prawdy dla backendu i frontendu Subskrypcji
// (wzór: src/healthTypes.ts).
//
// Jedna płaska kolekcja, bez relacji rodzic/dziecko (w odróżnieniu od Zwierząt/Auta/Podróży).
// Nadal rozszerza `SharedMeta` (`ownerId`/`visibility`) i zachowuje rozróżnienie prywatne/wspólne
// per rekord, jak `Pet`/`HealthAppointment`.

import type { CurrencyCode, SharedMeta } from "./financeTypes";

export interface Subscription extends SharedMeta {
  id: string;
  name: string;
  category: string;
  amountMinor: number;
  currency: CurrencyCode;
  cycle: "monthly" | "quarterly" | "yearly";
  nextPayment: string; // isoDate
  payer: string;
  status: "active" | "trial" | "paused" | "cancelled";
  reminderDays: number;
  color: string;
  cancelUrl?: string;
  version: number;
  updatedAt: string;
}
