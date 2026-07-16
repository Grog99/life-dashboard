import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { createAdvancedData } from "../data/advancedData";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { generateId as makeId } from "../lib/id";
import {
  carExpenseSchema,
  healthAppointmentSchema,
  healthMeasurementSchema,
  hideAmountsSchema,
  householdMemberSchema,
  householdNameSchema,
  mealSlotSchema,
  medicationSchema,
  petExpenseSchema,
  petSchema,
  petVisitSchema,
  recipeSchema,
  shoppingItemSchema,
  subscriptionSchema,
  vehicleDeadlineSchema,
  vehicleSchema,
} from "../lib/schema";
import type {
  AdvancedData,
  AdvancedDataWithHealth,
  CarExpense,
  HealthAppointment,
  HealthMeasurement,
  Medication,
  MealSlot,
  Pet,
  PetExpense,
  PetVisit,
  Recipe,
  ShoppingItem,
  Subscription,
  Vehicle,
} from "../advancedTypes";

const STORAGE_NAME = "puls-advanced-dashboard";

function parseArrayField<T>(value: unknown, schema: z.ZodType<T>): { items: T[]; dropped: number } {
  if (value === undefined) return { items: [], dropped: 0 };
  if (!Array.isArray(value)) return { items: [], dropped: 1 };
  let dropped = 0;
  const items: T[] = [];
  for (const raw of value) {
    const result = schema.safeParse(raw);
    if (result.success) items.push(result.data);
    else dropped += 1;
  }
  return { items, dropped };
}

function parseScalarField<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
): { value: T; dropped: number } {
  if (value === undefined) return { value: fallback, dropped: 0 };
  const result = schema.safeParse(value);
  return result.success ? { value: result.data, dropped: 0 } : { value: fallback, dropped: 1 };
}

interface AdvancedActions {
  toggleHideAmounts: () => void;
  addSubscription: (subscription: Omit<Subscription, "id">) => string;
  updateSubscription: (subscriptionId: string, changes: Partial<Subscription>) => void;
  deleteSubscription: (subscriptionId: string) => void;
  setMealSlot: (slot: Omit<MealSlot, "id"> & { id?: string }) => void;
  addRecipe: (recipe: Omit<Recipe, "id">) => string;
  toggleShoppingItem: (itemId: string) => void;
  addShoppingItem: (item: Omit<ShoppingItem, "id">) => void;
  addRecipeIngredientsToShopping: (recipeId: string) => number;
  addVehicle: (vehicle: Omit<Vehicle, "id">) => string;
  updateVehicle: (vehicleId: string, changes: Partial<Vehicle>) => void;
  addCarExpense: (expense: Omit<CarExpense, "id">) => string;
  toggleVehicleDeadline: (deadlineId: string) => void;
  addPet: (pet: Omit<Pet, "id">) => string;
  updatePet: (petId: string, changes: Partial<Pet>) => void;
  deletePet: (petId: string) => void;
  addPetExpense: (expense: Omit<PetExpense, "id">) => string;
  deletePetExpense: (expenseId: string) => void;
  addPetVisit: (visit: Omit<PetVisit, "id">) => string;
  updatePetVisit: (visitId: string, changes: Partial<PetVisit>) => void;
  deletePetVisit: (visitId: string) => void;
  togglePetVisitCompleted: (visitId: string) => void;
  addHealthAppointment: (appointment: Omit<HealthAppointment, "id">) => string;
  updateHealthAppointment: (appointmentId: string, changes: Partial<HealthAppointment>) => void;
  deleteHealthAppointment: (appointmentId: string) => void;
  addMedication: (medication: Omit<Medication, "id">) => string;
  updateMedication: (medicationId: string, changes: Partial<Medication>) => void;
  deleteMedication: (medicationId: string) => void;
  toggleMedicationTaken: (medicationId: string, date: string) => void;
  toggleMedicationActive: (medicationId: string) => void;
  addHealthMeasurement: (measurement: Omit<HealthMeasurement, "id">) => string;
  updateHealthMeasurement: (measurementId: string, changes: Partial<HealthMeasurement>) => void;
  deleteHealthMeasurement: (measurementId: string) => void;
  replaceAdvancedData: (data: AdvancedData) => void;
  resetAdvancedData: () => void;
}

export type AdvancedStore = AdvancedDataWithHealth & AdvancedActions;

export const useAdvancedStore = create<AdvancedStore>()(
  persist(
    (set, get) => ({
      ...createAdvancedData(),
      toggleHideAmounts: () => set((state) => ({ hideAmounts: !state.hideAmounts })),
      addSubscription: (subscription) => {
        const id = makeId();
        set((state) => ({ subscriptions: [{ ...subscription, id }, ...state.subscriptions] }));
        return id;
      },
      updateSubscription: (subscriptionId, changes) =>
        set((state) => ({
          subscriptions: state.subscriptions.map((subscription) =>
            subscription.id === subscriptionId ? { ...subscription, ...changes } : subscription,
          ),
        })),
      deleteSubscription: (subscriptionId) =>
        set((state) => ({
          subscriptions: state.subscriptions.filter(
            (subscription) => subscription.id !== subscriptionId,
          ),
        })),
      setMealSlot: (slot) =>
        set((state) => {
          const existing = state.mealSlots.find(
            (item) => item.id === slot.id || (item.date === slot.date && item.type === slot.type),
          );
          return {
            mealSlots: existing
              ? state.mealSlots.map((item) =>
                  item.id === existing.id ? { ...item, ...slot, id: existing.id } : item,
                )
              : [...state.mealSlots, { ...slot, id: makeId() }],
          };
        }),
      addRecipe: (recipe) => {
        const id = makeId();
        set((state) => ({ recipes: [{ ...recipe, id }, ...state.recipes] }));
        return id;
      },
      toggleShoppingItem: (itemId) =>
        set((state) => ({
          shoppingItems: state.shoppingItems.map((item) =>
            item.id === itemId ? { ...item, checked: !item.checked } : item,
          ),
        })),
      addShoppingItem: (item) =>
        set((state) => ({ shoppingItems: [...state.shoppingItems, { ...item, id: makeId() }] })),
      addRecipeIngredientsToShopping: (recipeId) => {
        const recipe = get().recipes.find((item) => item.id === recipeId);
        if (!recipe) return 0;
        const normalize = (value: string) => value.trim().toLocaleLowerCase("pl");
        const seen = new Set(get().shoppingItems.map((item) => normalize(item.name)));
        const additions = recipe.ingredients
          .map((ingredient) => {
            const match = ingredient.match(/^(.+?)\s+(\d.*)$/);
            return {
              name: (match?.[1] ?? ingredient).trim(),
              quantity: (match?.[2] ?? "1 szt.").trim(),
            };
          })
          .filter((ingredient) => {
            const key = normalize(ingredient.name);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((ingredient) => ({
            ...ingredient,
            id: makeId(),
            category: "Z przepisu",
            checked: false,
            sourceRecipeId: recipeId,
          }));
        set((state) => ({ shoppingItems: [...state.shoppingItems, ...additions] }));
        return additions.length;
      },
      addVehicle: (vehicle) => {
        const id = makeId();
        set((state) => ({ vehicles: [...state.vehicles, { ...vehicle, id }] }));
        return id;
      },
      updateVehicle: (vehicleId, changes) =>
        set((state) => ({
          vehicles: state.vehicles.map((vehicle) =>
            vehicle.id === vehicleId ? { ...vehicle, ...changes } : vehicle,
          ),
        })),
      addCarExpense: (expense) => {
        const id = makeId();
        set((state) => ({
          carExpenses: [{ ...expense, id }, ...state.carExpenses],
          vehicles: state.vehicles.map((vehicle) =>
            vehicle.id === expense.vehicleId && expense.mileage && expense.mileage > vehicle.mileage
              ? { ...vehicle, mileage: expense.mileage }
              : vehicle,
          ),
        }));
        return id;
      },
      toggleVehicleDeadline: (deadlineId) =>
        set((state) => ({
          vehicleDeadlines: state.vehicleDeadlines.map((deadline) =>
            deadline.id === deadlineId ? { ...deadline, completed: !deadline.completed } : deadline,
          ),
        })),
      addPet: (pet) => {
        const id = makeId();
        set((state) => ({ pets: [...state.pets, { ...pet, id }] }));
        return id;
      },
      updatePet: (petId, changes) =>
        set((state) => ({
          pets: state.pets.map((pet) => (pet.id === petId ? { ...pet, ...changes } : pet)),
        })),
      deletePet: (petId) =>
        set((state) => ({
          pets: state.pets.filter((pet) => pet.id !== petId),
          petExpenses: state.petExpenses.filter((expense) => expense.petId !== petId),
          petVisits: state.petVisits.filter((visit) => visit.petId !== petId),
        })),
      addPetExpense: (expense) => {
        const id = makeId();
        set((state) => ({ petExpenses: [{ ...expense, id }, ...state.petExpenses] }));
        return id;
      },
      deletePetExpense: (expenseId) =>
        set((state) => ({
          petExpenses: state.petExpenses.filter((expense) => expense.id !== expenseId),
        })),
      addPetVisit: (visit) => {
        const id = makeId();
        set((state) => ({ petVisits: [...state.petVisits, { ...visit, id }] }));
        return id;
      },
      updatePetVisit: (visitId, changes) =>
        set((state) => ({
          petVisits: state.petVisits.map((visit) =>
            visit.id === visitId ? { ...visit, ...changes } : visit,
          ),
        })),
      deletePetVisit: (visitId) =>
        set((state) => ({ petVisits: state.petVisits.filter((visit) => visit.id !== visitId) })),
      togglePetVisitCompleted: (visitId) =>
        set((state) => ({
          petVisits: state.petVisits.map((visit) =>
            visit.id === visitId
              ? { ...visit, status: visit.status === "completed" ? "scheduled" : "completed" }
              : visit,
          ),
        })),
      addHealthAppointment: (appointment) => {
        const id = makeId();
        set((state) => ({
          healthAppointments: [...state.healthAppointments, { ...appointment, id }],
        }));
        return id;
      },
      updateHealthAppointment: (appointmentId, changes) =>
        set((state) => ({
          healthAppointments: state.healthAppointments.map((appointment) =>
            appointment.id === appointmentId ? { ...appointment, ...changes } : appointment,
          ),
        })),
      deleteHealthAppointment: (appointmentId) =>
        set((state) => ({
          healthAppointments: state.healthAppointments.filter(
            (appointment) => appointment.id !== appointmentId,
          ),
        })),
      addMedication: (medication) => {
        const id = makeId();
        set((state) => ({ medications: [...state.medications, { ...medication, id }] }));
        return id;
      },
      updateMedication: (medicationId, changes) =>
        set((state) => ({
          medications: state.medications.map((medication) =>
            medication.id === medicationId ? { ...medication, ...changes } : medication,
          ),
        })),
      deleteMedication: (medicationId) =>
        set((state) => ({
          medications: state.medications.filter((medication) => medication.id !== medicationId),
        })),
      toggleMedicationTaken: (medicationId, date) =>
        set((state) => ({
          medications: state.medications.map((medication) =>
            medication.id === medicationId
              ? { ...medication, lastTakenOn: medication.lastTakenOn === date ? undefined : date }
              : medication,
          ),
        })),
      toggleMedicationActive: (medicationId) =>
        set((state) => ({
          medications: state.medications.map((medication) =>
            medication.id === medicationId
              ? { ...medication, active: !medication.active }
              : medication,
          ),
        })),
      addHealthMeasurement: (measurement) => {
        const id = makeId();
        set((state) => ({
          healthMeasurements: [{ ...measurement, id }, ...state.healthMeasurements],
        }));
        return id;
      },
      updateHealthMeasurement: (measurementId, changes) =>
        set((state) => ({
          healthMeasurements: state.healthMeasurements.map((measurement) =>
            measurement.id === measurementId ? { ...measurement, ...changes } : measurement,
          ),
        })),
      deleteHealthMeasurement: (measurementId) =>
        set((state) => ({
          healthMeasurements: state.healthMeasurements.filter(
            (measurement) => measurement.id !== measurementId,
          ),
        })),
      replaceAdvancedData: (data) =>
        set({
          ...data,
          pets: data.pets ?? [],
          petExpenses: data.petExpenses ?? [],
          petVisits: data.petVisits ?? [],
          healthAppointments: data.healthAppointments ?? [],
          medications: data.medications ?? [],
          healthMeasurements: data.healthMeasurements ?? [],
        }),
      resetAdvancedData: () => set(createAdvancedData()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      merge: (persistedState, currentState) => {
        if (!persistedState || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis modułów miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;

        const subscriptions = parseArrayField(state.subscriptions, subscriptionSchema);
        const recipes = parseArrayField(state.recipes, recipeSchema);
        const mealSlots = parseArrayField(state.mealSlots, mealSlotSchema);
        const shoppingItems = parseArrayField(state.shoppingItems, shoppingItemSchema);
        const vehicles = parseArrayField(state.vehicles, vehicleSchema);
        const carExpenses = parseArrayField(state.carExpenses, carExpenseSchema);
        const vehicleDeadlines = parseArrayField(state.vehicleDeadlines, vehicleDeadlineSchema);
        const pets = parseArrayField(state.pets, petSchema);
        const petExpenses = parseArrayField(state.petExpenses, petExpenseSchema);
        const petVisits = parseArrayField(state.petVisits, petVisitSchema);
        const healthAppointments = parseArrayField(
          state.healthAppointments,
          healthAppointmentSchema,
        );
        const medications = parseArrayField(state.medications, medicationSchema);
        const healthMeasurements = parseArrayField(
          state.healthMeasurements,
          healthMeasurementSchema,
        );
        const householdMembers = parseArrayField(state.householdMembers, householdMemberSchema);
        const householdName = parseScalarField(
          state.householdName,
          householdNameSchema,
          currentState.householdName,
        );
        const hideAmounts = parseScalarField(
          state.hideAmounts,
          hideAmountsSchema,
          currentState.hideAmounts,
        );

        const arrayFields = [
          subscriptions,
          recipes,
          mealSlots,
          shoppingItems,
          vehicles,
          carExpenses,
          vehicleDeadlines,
          pets,
          petExpenses,
          petVisits,
          healthAppointments,
          medications,
          healthMeasurements,
          householdMembers,
        ];
        const droppedCount =
          arrayFields.reduce((sum, field) => sum + field.dropped, 0) +
          householdName.dropped +
          hideAmounts.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych modułów była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          subscriptions: subscriptions.items,
          recipes: recipes.items,
          mealSlots: mealSlots.items,
          shoppingItems: shoppingItems.items,
          vehicles: vehicles.items,
          carExpenses: carExpenses.items,
          vehicleDeadlines: vehicleDeadlines.items,
          pets: pets.items,
          petExpenses: petExpenses.items,
          petVisits: petVisits.items,
          healthAppointments: healthAppointments.items,
          medications: medications.items,
          healthMeasurements: healthMeasurements.items,
          householdMembers: householdMembers.items,
          householdName: householdName.value,
          hideAmounts: hideAmounts.value,
        };
      },
      partialize: (state) => ({
        subscriptions: state.subscriptions,
        recipes: state.recipes,
        mealSlots: state.mealSlots,
        shoppingItems: state.shoppingItems,
        vehicles: state.vehicles,
        carExpenses: state.carExpenses,
        vehicleDeadlines: state.vehicleDeadlines,
        pets: state.pets,
        petExpenses: state.petExpenses,
        petVisits: state.petVisits,
        healthAppointments: state.healthAppointments,
        medications: state.medications,
        healthMeasurements: state.healthMeasurements,
        householdMembers: state.householdMembers,
        householdName: state.householdName,
        hideAmounts: state.hideAmounts,
      }),
    },
  ),
);

export function exportAdvancedData(): AdvancedDataWithHealth {
  const state = useAdvancedStore.getState();
  return {
    subscriptions: state.subscriptions,
    recipes: state.recipes,
    mealSlots: state.mealSlots,
    shoppingItems: state.shoppingItems,
    vehicles: state.vehicles,
    carExpenses: state.carExpenses,
    vehicleDeadlines: state.vehicleDeadlines,
    pets: state.pets,
    petExpenses: state.petExpenses,
    petVisits: state.petVisits,
    healthAppointments: state.healthAppointments,
    medications: state.medications,
    healthMeasurements: state.healthMeasurements,
    householdMembers: state.householdMembers,
    householdName: state.householdName,
    hideAmounts: state.hideAmounts,
  };
}
