import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { createAdvancedData } from "../data/advancedData";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { generateId as makeId } from "../lib/id";
import {
  healthAppointmentSchema,
  healthMeasurementSchema,
  hideAmountsSchema,
  householdMemberSchema,
  householdNameSchema,
  medicationSchema,
  petExpenseSchema,
  petSchema,
  petVisitSchema,
  subscriptionSchema,
} from "../lib/schema";
import type {
  AdvancedData,
  AdvancedDataWithHealth,
  HealthAppointment,
  HealthMeasurement,
  Medication,
  Pet,
  PetExpense,
  PetVisit,
  Subscription,
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
    (set) => ({
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
