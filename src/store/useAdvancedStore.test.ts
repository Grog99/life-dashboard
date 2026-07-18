import { beforeEach, describe, expect, it } from "vitest";
import { createAdvancedData } from "../data/advancedData";
import { useAdvancedStore } from "./useAdvancedStore";

describe("advanced store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAdvancedStore.setState(createAdvancedData());
  });

  // Rezerwacje podróży żyją teraz w znormalizowanych tabelach SQL / src/store/useTripsStore.ts,
  // nie w tym dokumencie -- patrz docs/plans/podroze-trips.md.
  // Posiłki (recipes/mealSlots/shoppingItems, w tym addRecipeIngredientsToShopping) żyją teraz w
  // znormalizowanych tabelach SQL / src/store/useMealsStore.ts, nie w tym dokumencie -- patrz
  // docs/plans/lista-zakupow-meals.md. Test dedupu przy generowaniu listy z przepisu przenosi się
  // do src/store/useMealsStore.test.ts (etap Testy planu).
  // Zdrowie (healthAppointments/medications/healthMeasurements) żyje teraz w znormalizowanych
  // tabelach SQL / src/store/useHealthStore.ts, nie w tym dokumencie -- patrz
  // docs/plans/zdrowie-sql.md.
  // Subskrypcje (subscriptions) żyją teraz w znormalizowanej tabeli SQL / src/store/
  // useSubscriptionsStore.ts, nie w tym dokumencie -- patrz docs/plans/subskrypcje-sql.md. Testy
  // CRUD i scalania przenoszą się do src/store/useSubscriptionsStore.test.ts (etap Testy planu).

  it("odrzuca tylko uszkodzony rekord przy scalaniu zapisanych danych modułów, zachowując resztę", () => {
    const sample = createAdvancedData();
    const persistedState = {
      ...sample,
      householdMembers: [sample.householdMembers[0], { id: "bad" }],
    };
    const merge = useAdvancedStore.persist.getOptions().merge!;
    const merged = merge(persistedState, useAdvancedStore.getState()) as ReturnType<
      typeof useAdvancedStore.getState
    >;

    expect(merged.householdMembers).toHaveLength(1);
    expect(merged.householdMembers[0].id).toBe(sample.householdMembers[0].id);
    expect(merged.householdName).toEqual(sample.householdName);
  });
});
