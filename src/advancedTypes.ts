export type Visibility = "private" | "household";
export type CurrencyCode = "PLN" | "EUR" | "USD" | "GBP";

export interface SharedMeta {
  ownerId: string;
  visibility: Visibility;
}

export interface FinanceAccount extends SharedMeta {
  id: string;
  name: string;
  type: "checking" | "savings" | "cash" | "credit";
  balanceMinor: number;
  currency: CurrencyCode;
  color: string;
  archived: boolean;
  updatedAt: string;
}

export interface FinanceTransaction extends SharedMeta {
  id: string;
  accountId: string;
  bookedOn: string;
  amountMinor: number;
  currency: CurrencyCode;
  merchant: string;
  title: string;
  category: string;
  source: "manual" | "csv" | "subscription" | "trip" | "car";
  fingerprint?: string;
  notes?: string;
  updatedAt: string;
}

export interface FinanceBudget {
  id: string;
  category: string;
  limitMinor: number;
  currency: CurrencyCode;
  color: string;
  updatedAt: string;
}

export interface SavingsGoal extends SharedMeta {
  id: string;
  name: string;
  targetMinor: number;
  savedMinor: number;
  currency: CurrencyCode;
  deadline?: string;
  updatedAt: string;
}

export interface Trip extends SharedMeta {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: "idea" | "planning" | "active" | "archived";
  budgetMinor?: number;
  currency: CurrencyCode;
  travelers: string[];
  progress: number;
  accent: "terracotta" | "ocean" | "forest" | "violet";
  notes: string;
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
  updatedAt: string;
}

export interface PackingItem {
  id: string;
  tripId: string;
  name: string;
  category: "documents" | "clothes" | "electronics" | "health" | "other";
  packed: boolean;
  assignedTo?: string;
  updatedAt: string;
}

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

export interface Recipe extends SharedMeta {
  id: string;
  name: string;
  minutes: number;
  servings: number;
  tags: string[];
  ingredients: string[];
  favorite: boolean;
}

export interface MealSlot {
  id: string;
  date: string;
  type: "breakfast" | "lunch" | "dinner";
  recipeId?: string;
  title: string;
  servings: number;
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string;
  category: string;
  checked: boolean;
  assignedTo?: string;
  sourceRecipeId?: string;
}

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
}

export interface VehicleDeadline {
  id: string;
  vehicleId: string;
  title: string;
  dueDate?: string;
  dueMileage?: number;
  completed: boolean;
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
  financeAccounts: FinanceAccount[];
  financeTransactions: FinanceTransaction[];
  financeBudgets: FinanceBudget[];
  savingsGoals: SavingsGoal[];
  trips: Trip[];
  tripItinerary: TripItineraryItem[];
  tripBookings: TripBooking[];
  packingItems: PackingItem[];
  subscriptions: Subscription[];
  recipes: Recipe[];
  mealSlots: MealSlot[];
  shoppingItems: ShoppingItem[];
  vehicles: Vehicle[];
  carExpenses: CarExpense[];
  vehicleDeadlines: VehicleDeadline[];
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
