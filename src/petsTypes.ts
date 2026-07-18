// Typy modułu Zwierzęta (Pets). Od docs/plans/zwierzeta-sql.md dane Zwierząt (pets/petExpenses/
// petVisits) nie są już częścią dokumentu JSONB (AdvancedData) — mają własne znormalizowane
// tabele SQL (server/migrations/010_pets_normalized.sql) z optymistyczną współbieżnością per
// rekord (pole `version`, bez wyjątku — Zwierzęta nie mają pola agregującego jak
// `Vehicle.mileage`). Ten plik jest wspólnym źródłem prawdy dla backendu i frontendu Zwierząt
// (wzór: src/carTypes.ts).
//
// Jak Auto (w odróżnieniu od Podróży/Meals, które porzuciły widoczność), Zwierzęta ZACHOWUJĄ
// rozróżnienie prywatne/wspólne: `Pet`/`PetExpense`/`PetVisit` rozszerzają `SharedMeta`
// (`ownerId`/`visibility`), tak jak dziś w `advancedTypes.ts`. W ODRÓŻNIENIU od Auta (gdzie
// `VehicleDeadline` nie ma własnej widoczności) OBA dzieci Zwierząt — `PetExpense` i `PetVisit`
// — mają WŁASNĄ `visibility`, dziedziczoną z profilu tylko przy tworzeniu bez jawnej wartości.

import type { SharedMeta } from "./financeTypes";

export type PetKind = "rabbit" | "dog" | "cat" | "guinea_pig" | "aquarium" | "other";

export interface FishStockEntry {
  id: string;
  species: string; // gatunek ryby, np. "Neonek innesa"
  count: number; // liczba sztuk
}

export interface Pet extends SharedMeta {
  id: string;
  name: string; // imię, np. "Fistaszek"
  kind: PetKind; // typ profilu (steruje wariantem pól)
  color: string; // kolor karty w selektorze (jak Vehicle.color)
  // Pola zwierzęcia standardowego (kind !== "aquarium"):
  species?: string; // gatunek/rasa, np. "Królik miniaturka"
  birthDate?: string; // isoDate — wiek liczony w UI
  // Pole wariantowe akwarium (kind === "aquarium") — zagnieżdżona kolumna JSONB, wędruje
  // atomowo z profilem, bez własnej wersji/kolizji (wzór Trip.travelers).
  fishStock?: FishStockEntry[]; // obsada: lista {gatunek, liczba}
  notes?: string;
  version: number;
  updatedAt: string;
}

export interface PetExpense extends SharedMeta {
  id: string;
  petId: string;
  date: string; // isoDate
  type: "food" | "vet" | "accessories" | "grooming" | "other";
  amountMinor: number;
  title: string;
  notes?: string;
  version: number;
  updatedAt: string;
}

export interface PetVisit extends SharedMeta {
  id: string;
  petId: string;
  title: string; // np. "Szczepienie", "Serwis filtra"
  clinician: string; // weterynarz / placówka / serwis
  specialty?: string;
  date: string; // isoDate
  time: string; // clockTime — potrzebne dla push -24 h
  location?: string;
  status: "scheduled" | "completed" | "cancelled";
  notes?: string;
  version: number;
  updatedAt: string;
}
