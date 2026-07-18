// Finanse (konta/transakcje/budżety/cele) żyją teraz w znormalizowanych tabelach SQL,
// nie w tym dokumencie — patrz docs/plans/model-synchronizacji-danych.md i src/financeTypes.ts.
// `Visibility`/`CurrencyCode`/`SharedMeta` zostają re-eksportowane stąd, bo reszta modułów
// w tym pliku (Subscription, Health, ...) nadal z nich korzysta.
import type { Visibility, CurrencyCode, SharedMeta } from "./financeTypes";

export type { Visibility, CurrencyCode, SharedMeta };

// Podróże (trips/tripItinerary/tripBookings/packingItems) żyją teraz w znormalizowanych
// tabelach SQL, nie w tym dokumencie — patrz docs/plans/podroze-trips.md i src/tripsTypes.ts.
// Re-eksportowane stąd dla plików, które wciąż importują je z `advancedTypes` (jak zrobiono
// z typami finance).
export type { Trip, TripItineraryItem, TripBooking, PackingItem } from "./tripsTypes";

// Posiłki (recipes/mealSlots/shoppingItems) żyją teraz w znormalizowanych tabelach SQL, nie w
// tym dokumencie — patrz docs/plans/lista-zakupow-meals.md i src/mealsTypes.ts. Re-eksportowane
// stąd dla plików, które wciąż importują je z `advancedTypes` (jak zrobiono z typami trips).
export type { Recipe, MealSlot, ShoppingItem } from "./mealsTypes";

// Auto (vehicles/carExpenses/vehicleDeadlines) żyje teraz w znormalizowanych tabelach SQL, nie
// w tym dokumencie — patrz docs/plans/auto-car.md i src/carTypes.ts. Re-eksportowane stąd dla
// plików, które wciąż importują je z `advancedTypes` (jak zrobiono z typami trips/meals).
export type { Vehicle, CarExpense, VehicleDeadline } from "./carTypes";

// Zwierzęta (pets/petExpenses/petVisits) żyją teraz w znormalizowanych tabelach SQL, nie w tym
// dokumencie — patrz docs/plans/zwierzeta-sql.md i src/petsTypes.ts. Re-eksportowane stąd dla
// plików, które wciąż importują je z `advancedTypes` (jak zrobiono z typami car).
export type { Pet, PetExpense, PetVisit, PetKind, FishStockEntry } from "./petsTypes";

export interface Subscription extends SharedMeta {
  id: string;
  name: string;
  category: string;
  amountMinor: number;
  currency: CurrencyCode;
  cycle: "monthly" | "quarterly" | "yearly";
  nextPayment: string;
  payer: string;
  status: "active" | "trial" | "paused" | "cancelled";
  reminderDays: number;
  color: string;
  cancelUrl?: string;
}

export interface HealthAppointment extends SharedMeta {
  id: string;
  title: string;
  clinician: string;
  specialty?: string;
  date: string;
  time: string;
  location?: string;
  status: "scheduled" | "completed" | "cancelled";
  notes?: string;
}

export interface Medication extends SharedMeta {
  id: string;
  name: string;
  dosage: string;
  schedule: string;
  active: boolean;
  lastTakenOn?: string;
  reminderTime?: string;
}

export type HealthMeasurementType =
  "weight" | "blood_pressure" | "glucose" | "temperature" | "other";

export interface HealthMeasurement extends SharedMeta {
  id: string;
  type: HealthMeasurementType;
  value: string;
  unit: string;
  measuredAt: string;
  notes?: string;
}

export interface HouseholdMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  color: string;
}

export interface AdvancedData {
  subscriptions: Subscription[];
  healthAppointments: HealthAppointment[];
  medications: Medication[];
  healthMeasurements: HealthMeasurement[];
  householdMembers: HouseholdMember[];
  householdName: string;
  hideAmounts: boolean;
}

export type AdvancedDataWithHealth = AdvancedData;
