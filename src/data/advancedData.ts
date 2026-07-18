import type { AdvancedDataWithHealth } from "../advancedTypes";

// Auto (vehicles/carExpenses/vehicleDeadlines) nie ma już seedu tutaj — żyje w znormalizowanych
// tabelach SQL, serwer jest źródłem prawdy (domyślny stan offline = pusty), patrz
// docs/plans/auto-car.md i src/store/useCarStore.ts.
// Zwierzęta (pets/petExpenses/petVisits) analogicznie nie mają już seedu tutaj — patrz
// docs/plans/zwierzeta-sql.md i src/store/usePetsStore.ts.
// Zdrowie (healthAppointments/medications/healthMeasurements) analogicznie nie ma już seedu tutaj
// — patrz docs/plans/zdrowie-sql.md i src/store/useHealthStore.ts.
// Subskrypcje (subscriptions) analogicznie nie mają już seedu tutaj — serwer jest źródłem prawdy
// (domyślny stan offline = pusty), patrz docs/plans/subskrypcje-sql.md i
// src/store/useSubscriptionsStore.ts.

export function createAdvancedData(): AdvancedDataWithHealth {
  return {
    householdName: "Nasz dom",
    hideAmounts: false,
    householdMembers: [
      { id: "me", name: "Ty", email: "ty@example.com", role: "owner", color: "#2f7862" },
      { id: "anna", name: "Anna", email: "anna@example.com", role: "member", color: "#b16e45" },
    ],
  };
}
