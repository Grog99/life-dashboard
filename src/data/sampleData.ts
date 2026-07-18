import type { LifeData } from "../types";

// Pięć kolekcji Life (`tasks`/`events`/`reminders`/`notes`/`habits`) nie mają już seeda tutaj —
// mają własne znormalizowane tabele SQL (server/migrations/013_life_normalized.sql), więc serwer
// jest źródłem prawdy; offline = puste kolekcje (parytet z wycięciem seedów car/pets/health z
// advancedData.ts). `createSampleData` niesie już tylko 4 pola osobiste, patrz
// docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("Odchudzenie useLifeStore").
export function createSampleData(): LifeData {
  return {
    scratchpad: "Kupić baterie AAA\nZapisać pomysł na prezent dla Oli",
    intention: "Jedna rzecz naraz, bez pośpiechu.",
    energy: "medium",
    preferences: {
      name: "",
      theme: "system",
      notificationsEnabled: false,
      weekStartsOnMonday: true,
    },
  };
}
