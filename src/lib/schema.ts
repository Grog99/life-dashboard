import { z } from "zod";
import type { AdvancedData } from "../advancedTypes";

export const energySchema = z.enum(["low", "medium", "high"]);
const energy = energySchema;
const nonEmptyText = z.string().trim().min(1).max(500);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "Nieprawidłowa data");
const clockTime = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .refine((value) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
  }, "Nieprawidłowa godzina");
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Nieprawidłowy znacznik czasu");

// Wyhoistowane ponad schematy life (potrzebne dla opcjonalnych `visibility`/`ownerId` poniżej);
// reużywane też niżej przez sharedMetaSchema (kolekcje advanced).
const idSchema = z.string().min(1).max(200);
const visibilitySchema = z.enum(["private", "household"]);

// Powtarzalność zadań/wydarzeń (patrz docs/plans/zadania-wydarzenia-powtarzalne.md).
// Reużywa istniejących helperów `isoDate`/`clockTime` zamiast duplikować walidację dat/godzin.
export const recurrenceSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  count: z.number().int().min(1).optional(),
  anchorDate: isoDate,
  anchorTime: clockTime.optional(),
});

export const taskSchema = z.object({
  id: z.string(),
  title: nonEmptyText,
  description: z.string().max(5000).optional(),
  status: z.enum(["todo", "done"]),
  priority: z.enum(["low", "medium", "high"]),
  date: isoDate.optional(),
  time: clockTime.optional(),
  estimatedMinutes: z.number().positive().optional(),
  category: nonEmptyText,
  isFocus: z.boolean(),
  energy,
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.optional(),
  ownerId: idSchema.optional(),
  visibility: visibilitySchema.optional(),
  seriesId: idSchema.optional(),
  seriesIndex: z.number().int().min(0).optional(),
  recurrence: recurrenceSchema.optional(),
});

export const eventSchema = z.object({
  id: z.string(),
  title: nonEmptyText,
  date: isoDate,
  startTime: clockTime,
  endTime: clockTime,
  kind: z.enum(["meeting", "focus", "personal"]),
  location: z.string().max(1000).optional(),
  notes: z.string().max(5000).optional(),
  source: z.enum(["manual", "google"]).optional(),
  externalId: z.string().max(500).optional(),
  externalUpdatedAt: timestamp.optional(),
  updatedAt: timestamp,
  ownerId: idSchema.optional(),
  visibility: visibilitySchema.optional(),
  seriesId: idSchema.optional(),
  seriesIndex: z.number().int().min(0).optional(),
  recurrence: recurrenceSchema.optional(),
});

export const reminderSchema = z.object({
  id: z.string(),
  title: nonEmptyText,
  date: isoDate,
  time: clockTime,
  done: z.boolean(),
  notifiedAt: timestamp.optional(),
  updatedAt: timestamp,
  ownerId: idSchema.optional(),
  visibility: visibilitySchema.optional(),
});

export const noteSchema = z.object({
  id: z.string(),
  title: nonEmptyText,
  content: z.string().max(100_000),
  color: z.enum(["cream", "mint", "sky", "lilac"]),
  pinned: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
  ownerId: idSchema.optional(),
  visibility: visibilitySchema.optional(),
});

export const habitSchema = z.object({
  id: z.string(),
  name: nonEmptyText,
  icon: z.enum(["water", "walk", "read", "stretch", "meditate"]),
  targetLabel: nonEmptyText,
  completedDates: z.array(isoDate),
  updatedAt: timestamp,
  ownerId: idSchema.optional(),
  visibility: visibilitySchema.optional(),
});

export const preferencesSchema = z.object({
  name: z.string(),
  theme: z.enum(["light", "dark", "system"]),
  notificationsEnabled: z.boolean(),
  weekStartsOnMonday: z.boolean(),
});

export const lifeDataSchema = z.object({
  tasks: z.array(taskSchema),
  events: z.array(eventSchema),
  reminders: z.array(reminderSchema),
  notes: z.array(noteSchema),
  habits: z.array(habitSchema),
  scratchpad: z.string(),
  intention: z.string(),
  energy,
  preferences: preferencesSchema,
});

export const BACKUP_SCHEMA_VERSION = 1 as const;

export const backupEnvelopeSchema = z.object({
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  appVersion: z.string(),
  exportedAt: timestamp,
  timezone: z.string(),
  data: lifeDataSchema,
});

const currencySchema = z.enum(["PLN", "EUR", "USD", "GBP"]);
const safeMoney = z.number().int().safe();
const sharedMetaSchema = z.object({ ownerId: idSchema, visibility: visibilitySchema });

export const financeAccountSchema = sharedMetaSchema.extend({
  id: idSchema, name: nonEmptyText, type: z.enum(["checking", "savings", "cash", "credit"]),
  balanceMinor: safeMoney, currency: currencySchema, color: z.string().max(32), archived: z.boolean(),
  updatedAt: timestamp,
});
export const financeTransactionSchema = sharedMetaSchema.extend({
  id: idSchema, accountId: idSchema, bookedOn: isoDate, amountMinor: safeMoney, currency: currencySchema,
  merchant: z.string().max(1000), title: nonEmptyText, category: nonEmptyText,
  source: z.enum(["manual", "csv", "subscription", "trip", "car"]), fingerprint: z.string().max(500).optional(), notes: z.string().max(5000).optional(),
  updatedAt: timestamp,
});
export const financeBudgetSchema = z.object({ id: idSchema, category: nonEmptyText, limitMinor: safeMoney.nonnegative(), currency: currencySchema, color: z.string().max(32), updatedAt: timestamp });
export const savingsGoalSchema = sharedMetaSchema.extend({ id: idSchema, name: nonEmptyText, targetMinor: safeMoney.nonnegative(), savedMinor: safeMoney.nonnegative(), currency: currencySchema, deadline: isoDate.optional(), updatedAt: timestamp });
export const tripSchema = sharedMetaSchema.extend({
  id: idSchema, name: nonEmptyText, destination: nonEmptyText, startDate: isoDate, endDate: isoDate,
  status: z.enum(["idea", "planning", "active", "archived"]), budgetMinor: safeMoney.nonnegative().optional(), currency: currencySchema,
  travelers: z.array(z.string().max(200)).max(100), progress: z.number().min(0).max(100),
  accent: z.enum(["terracotta", "ocean", "forest", "violet"]), notes: z.string().max(10_000),
  updatedAt: timestamp,
});
export const tripItinerarySchema = z.object({
  id: idSchema, tripId: idSchema, date: isoDate, time: clockTime, title: nonEmptyText,
  type: z.enum(["transport", "stay", "activity", "food", "other"]), location: z.string().max(1000).optional(),
  costMinor: safeMoney.optional(), booked: z.boolean(), notes: z.string().max(5000).optional(),
  updatedAt: timestamp,
});
export const tripBookingSchema = z.object({
  id: idSchema, tripId: idSchema, itineraryItemId: idSchema.optional(), type: z.enum(["flight", "train", "stay", "car", "activity"]),
  provider: z.string().max(500), reference: z.string().max(500), title: nonEmptyText,
  startAt: timestamp, amountMinor: safeMoney.nonnegative(), paid: z.boolean(),
  updatedAt: timestamp,
});
export const packingItemSchema = z.object({ id: idSchema, tripId: idSchema, name: nonEmptyText, category: z.enum(["documents", "clothes", "electronics", "health", "other"]), packed: z.boolean(), assignedTo: z.string().max(200).optional(), updatedAt: timestamp });
export const subscriptionSchema = sharedMetaSchema.extend({
  id: idSchema, name: nonEmptyText, category: nonEmptyText, amountMinor: safeMoney.nonnegative(), currency: currencySchema,
  cycle: z.enum(["monthly", "quarterly", "yearly"]), nextPayment: isoDate, payer: z.string().max(200),
  status: z.enum(["active", "trial", "paused", "cancelled"]), reminderDays: z.number().int().min(0).max(365),
  color: z.string().max(32), cancelUrl: z.string().url().max(2000).optional(),
});
export const recipeSchema = sharedMetaSchema.extend({ id: idSchema, name: nonEmptyText, minutes: z.number().int().positive().max(1440), servings: z.number().int().positive().max(100), tags: z.array(z.string().max(100)).max(50), ingredients: z.array(z.string().max(1000)).max(500), favorite: z.boolean() });
export const mealSlotSchema = z.object({ id: idSchema, date: isoDate, type: z.enum(["breakfast", "lunch", "dinner"]), recipeId: idSchema.optional(), title: nonEmptyText, servings: z.number().int().positive().max(100) });
export const shoppingItemSchema = z.object({ id: idSchema, name: nonEmptyText, quantity: z.string().max(200), category: z.string().max(200), checked: z.boolean(), assignedTo: z.string().max(200).optional(), sourceRecipeId: idSchema.optional() });
export const vehicleSchema = sharedMetaSchema.extend({
  id: idSchema, name: nonEmptyText, make: z.string().max(200), model: z.string().max(200), year: z.number().int().min(1886).max(2200),
  plate: z.string().max(50), mileage: z.number().int().nonnegative(), fuelType: z.enum(["petrol", "diesel", "hybrid", "electric"]),
  inspectionDate: isoDate, insuranceDate: isoDate, color: z.string().max(32),
});
export const carExpenseSchema = sharedMetaSchema.extend({ id: idSchema, vehicleId: idSchema, date: isoDate, type: z.enum(["fuel", "service", "insurance", "parking", "other"]), amountMinor: safeMoney.nonnegative(), mileage: z.number().int().nonnegative().optional(), liters: z.number().positive().optional(), title: nonEmptyText });
export const vehicleDeadlineSchema = z.object({ id: idSchema, vehicleId: idSchema, title: nonEmptyText, dueDate: isoDate.optional(), dueMileage: z.number().int().nonnegative().optional(), completed: z.boolean() });
export const healthAppointmentSchema = sharedMetaSchema.extend({
  id: idSchema, title: nonEmptyText, clinician: nonEmptyText, specialty: z.string().max(500).optional(),
  date: isoDate, time: clockTime, location: z.string().max(1000).optional(),
  status: z.enum(["scheduled", "completed", "cancelled"]), notes: z.string().max(5000).optional(),
});
export const medicationSchema = sharedMetaSchema.extend({
  id: idSchema, name: nonEmptyText, dosage: nonEmptyText, schedule: nonEmptyText, active: z.boolean(),
  lastTakenOn: isoDate.optional(), reminderTime: clockTime.optional(),
});
export const healthMeasurementSchema = sharedMetaSchema.extend({
  id: idSchema, type: z.enum(["weight", "blood_pressure", "glucose", "temperature", "other"]),
  value: nonEmptyText, unit: z.string().max(100), measuredAt: timestamp, notes: z.string().max(5000).optional(),
});
export const householdMemberSchema = z.object({ id: idSchema, name: nonEmptyText, email: z.string().email().max(254), role: z.enum(["owner", "admin", "member"]), color: z.string().max(32) });
export const householdNameSchema = z.string().min(1).max(500);
export const hideAmountsSchema = z.boolean();

export const advancedDataSchema: z.ZodType<AdvancedData> = z.object({
  financeAccounts: z.array(financeAccountSchema), financeTransactions: z.array(financeTransactionSchema),
  financeBudgets: z.array(financeBudgetSchema), savingsGoals: z.array(savingsGoalSchema), trips: z.array(tripSchema),
  tripItinerary: z.array(tripItinerarySchema), tripBookings: z.array(tripBookingSchema), packingItems: z.array(packingItemSchema),
  subscriptions: z.array(subscriptionSchema), recipes: z.array(recipeSchema), mealSlots: z.array(mealSlotSchema),
  shoppingItems: z.array(shoppingItemSchema), vehicles: z.array(vehicleSchema), carExpenses: z.array(carExpenseSchema),
  vehicleDeadlines: z.array(vehicleDeadlineSchema), healthAppointments: z.array(healthAppointmentSchema),
  medications: z.array(medicationSchema), healthMeasurements: z.array(healthMeasurementSchema),
  householdMembers: z.array(householdMemberSchema),
  householdName: householdNameSchema, hideAmounts: hideAmountsSchema,
});

export const backupEnvelopeV2Schema = z.object({
  schemaVersion: z.literal(2),
  appVersion: z.string(),
  exportedAt: timestamp,
  timezone: z.string(),
  data: z.object({
    life: lifeDataSchema,
    advanced: advancedDataSchema,
  }),
});
