// Typy modułu Podróże. Od docs/plans/podroze-trips.md dane podróży nie są już częścią
// dokumentu JSONB (AdvancedData) — mają własne znormalizowane tabele SQL
// (server/migrations/007_trips_normalized.sql) z optymistyczną współbieżnością per rekord
// (pole `version`). Ten plik jest wspólnym źródłem prawdy dla backendu i frontendu Podróży
// (wzór: src/financeTypes.ts).
//
// W odróżnieniu od Finansów, podróże NIE MAJĄ `ownerId`/`visibility` — są zawsze wspólne dla
// gospodarstwa (decyzja użytkownika, patrz plan "Decyzje ustalone z góry" #6), więc `Trip`
// nie rozszerza `SharedMeta`. `CurrencyCode` jest reużyty z `src/financeTypes.ts` zamiast
// duplikowany.

import type { CurrencyCode } from "./financeTypes";

export interface Trip {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: "idea" | "planning" | "active" | "archived";
  budgetMinor?: number;
  currency: CurrencyCode;
  travelers: string[];
  // Serwerowo autorytatywny (computeTripProgress w warstwie backend) — klient przestaje go
  // nadpisywać; zostaje tu wyłącznie do odczytu/optymistycznego przeliczenia lokalnego.
  progress: number;
  accent: "terracotta" | "ocean" | "forest" | "violet";
  notes: string;
  version: number;
  updatedAt: string;
}

export interface TripItineraryItem {
  id: string;
  tripId: string;
  date: string;
  time: string;
  title: string;
  type: "transport" | "stay" | "activity" | "food" | "other";
  location?: string;
  costMinor?: number;
  booked: boolean;
  notes?: string;
  version: number;
  updatedAt: string;
}

export interface TripBooking {
  id: string;
  tripId: string;
  itineraryItemId?: string;
  type: "flight" | "train" | "stay" | "car" | "activity";
  provider: string;
  reference: string;
  title: string;
  startAt: string;
  amountMinor: number;
  paid: boolean;
  version: number;
  updatedAt: string;
}

export interface PackingItem {
  id: string;
  tripId: string;
  name: string;
  category: "documents" | "clothes" | "electronics" | "health" | "other";
  packed: boolean;
  assignedTo?: string;
  version: number;
  updatedAt: string;
}
