// Typy modułu Auto (Car). Od docs/plans/auto-car.md dane Auta (vehicles/carExpenses/
// vehicleDeadlines) nie są już częścią dokumentu JSONB (AdvancedData) — mają własne
// znormalizowane tabele SQL (server/migrations/009_car_normalized.sql) z optymistyczną
// współbieżnością per rekord (pole `version`, z wyjątkiem `Vehicle.mileage` — patrz plan
// "Projekt mileage"). Ten plik jest wspólnym źródłem prawdy dla backendu i frontendu Auta
// (wzór: src/financeTypes.ts).
//
// W odróżnieniu od Podróży/Meals (które porzuciły widoczność), Auto ZACHOWUJE rozróżnienie
// prywatne/wspólne: `Vehicle`/`CarExpense` nadal rozszerzają `SharedMeta` (`ownerId`/
// `visibility`), tak jak dziś w `advancedTypes.ts` — model referencyjny to Finanse, nie
// Podróże/Meals. `VehicleDeadline` NIE rozszerza `SharedMeta` — dziedziczy widoczność po
// pojeździe-rodzicu (jak dziś, `CHILD_RELATIONS` w `server/src/workspace.mjs`).

import type { SharedMeta } from "./financeTypes";

export interface Vehicle extends SharedMeta {
  id: string;
  name: string;
  make: string;
  model: string;
  year: number;
  plate: string;
  mileage: number;
  fuelType: "petrol" | "diesel" | "hybrid" | "electric";
  inspectionDate: string;
  insuranceDate: string;
  color: string;
  version: number;
  updatedAt: string;
}

export interface CarExpense extends SharedMeta {
  id: string;
  vehicleId: string;
  date: string;
  type: "fuel" | "service" | "insurance" | "parking" | "other";
  amountMinor: number;
  mileage?: number;
  liters?: number;
  title: string;
  version: number;
  updatedAt: string;
}

// Stabilny identyfikator logiczny terminu — `kind` (nie `title`) jest kluczem auto-upsertu
// serwerowego przy `vehicle.create`/`vehicle.update` (unikat częściowy `(vehicle_id, kind)`
// dla `inspection`/`insurance`). `title` zostaje jako opisowa etykieta, dowolna dla `custom`.
export interface VehicleDeadline {
  id: string;
  vehicleId: string;
  kind: "inspection" | "insurance" | "custom";
  title: string;
  dueDate?: string;
  dueMileage?: number;
  completed: boolean;
  version: number;
  updatedAt: string;
}
