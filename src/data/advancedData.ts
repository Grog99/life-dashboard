import { addDays, format } from "date-fns";
import type { AdvancedDataWithHealth } from "../advancedTypes";

const day = (offset = 0) => format(addDays(new Date(), offset), "yyyy-MM-dd");

// Auto (vehicles/carExpenses/vehicleDeadlines) nie ma już seedu tutaj — żyje w znormalizowanych
// tabelach SQL, serwer jest źródłem prawdy (domyślny stan offline = pusty), patrz
// docs/plans/auto-car.md i src/store/useCarStore.ts.
// Zwierzęta (pets/petExpenses/petVisits) analogicznie nie mają już seedu tutaj — patrz
// docs/plans/zwierzeta-sql.md i src/store/usePetsStore.ts.
// Zdrowie (healthAppointments/medications/healthMeasurements) analogicznie nie ma już seedu tutaj
// — patrz docs/plans/zdrowie-sql.md i src/store/useHealthStore.ts.

export function createAdvancedData(): AdvancedDataWithHealth {
  return {
    householdName: "Nasz dom",
    hideAmounts: false,
    householdMembers: [
      { id: "me", name: "Ty", email: "ty@example.com", role: "owner", color: "#2f7862" },
      { id: "anna", name: "Anna", email: "anna@example.com", role: "member", color: "#b16e45" },
    ],
    subscriptions: [
      {
        id: "sub-spotify",
        name: "Spotify Family",
        category: "Muzyka",
        amountMinor: 3799,
        currency: "PLN",
        cycle: "monthly",
        nextPayment: day(1),
        payer: "Ty",
        status: "active",
        reminderDays: 1,
        color: "#2f8f5b",
        ownerId: "me",
        visibility: "household",
      },
      {
        id: "sub-netflix",
        name: "Netflix",
        category: "Wideo",
        amountMinor: 6000,
        currency: "PLN",
        cycle: "monthly",
        nextPayment: day(6),
        payer: "Anna",
        status: "active",
        reminderDays: 2,
        color: "#b55252",
        ownerId: "anna",
        visibility: "household",
      },
      {
        id: "sub-icloud",
        name: "iCloud+",
        category: "Chmura",
        amountMinor: 4999,
        currency: "PLN",
        cycle: "monthly",
        nextPayment: day(12),
        payer: "Ty",
        status: "active",
        reminderDays: 2,
        color: "#6684a6",
        ownerId: "me",
        visibility: "private",
      },
      {
        id: "sub-adobe",
        name: "Adobe Creative Cloud",
        category: "Praca",
        amountMinor: 14760,
        currency: "PLN",
        cycle: "monthly",
        nextPayment: day(17),
        payer: "Ty",
        status: "active",
        reminderDays: 3,
        color: "#a85f5f",
        ownerId: "me",
        visibility: "private",
        cancelUrl: "https://account.adobe.com/",
      },
      {
        id: "sub-gym",
        name: "Siłownia",
        category: "Zdrowie",
        amountMinor: 12900,
        currency: "PLN",
        cycle: "monthly",
        nextPayment: day(22),
        payer: "Ty",
        status: "active",
        reminderDays: 2,
        color: "#8b6ca5",
        ownerId: "me",
        visibility: "private",
      },
    ],
  };
}
