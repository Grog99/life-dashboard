// Finanse (konta/transakcje/budżety/cele) żyją teraz w znormalizowanych tabelach SQL,
// nie w tym dokumencie — patrz docs/plans/model-synchronizacji-danych.md i src/financeTypes.ts.
// `Visibility`/`CurrencyCode`/`SharedMeta` zostają re-eksportowane stąd, bo reszta modułów
// w tym pliku (Subscription, Vehicle, Pet, Health, ...) nadal z nich korzysta.
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
  // Pole wariantowe akwarium (kind === "aquarium"):
  fishStock?: FishStockEntry[]; // obsada: lista {gatunek, liczba}
  notes?: string;
}

export interface PetExpense extends SharedMeta {
  id: string;
  petId: string;
  date: string; // isoDate
  type: "food" | "vet" | "accessories" | "grooming" | "other";
  amountMinor: number;
  title: string;
  notes?: string;
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
  pets: Pet[];
  petExpenses: PetExpense[];
  petVisits: PetVisit[];
  healthAppointments: HealthAppointment[];
  medications: Medication[];
  healthMeasurements: HealthMeasurement[];
  householdMembers: HouseholdMember[];
  householdName: string;
  hideAmounts: boolean;
}

export type AdvancedDataWithHealth = AdvancedData;
