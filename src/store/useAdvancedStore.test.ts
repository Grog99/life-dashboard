import { beforeEach, describe, expect, it } from "vitest";
import { createAdvancedData } from "../data/advancedData";
import { useAdvancedStore } from "./useAdvancedStore";

describe("advanced store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAdvancedStore.setState(createAdvancedData());
  });

  it("dodaje subskrypcję prywatną", () => {
    const id = useAdvancedStore.getState().addSubscription({
      name: "HBO Max",
      category: "Wideo",
      amountMinor: 2999,
      currency: "PLN",
      cycle: "monthly",
      nextPayment: "2026-08-01",
      payer: "Ty",
      status: "active",
      reminderDays: 1,
      color: "#123456",
      ownerId: "me",
      visibility: "private",
    });

    expect(useAdvancedStore.getState().subscriptions.find((item) => item.id === id)).toMatchObject({
      name: "HBO Max",
      visibility: "private",
    });
  });

  it("pozwala edytować subskrypcję bez utraty tożsamości rekordu", () => {
    const subscriptionId = useAdvancedStore.getState().subscriptions[0].id;
    useAdvancedStore.getState().updateSubscription(subscriptionId, { visibility: "household" });
    expect(
      useAdvancedStore.getState().subscriptions.find((item) => item.id === subscriptionId)
        ?.visibility,
    ).toBe("household");
  });

  it("usuwa subskrypcję", () => {
    const subscriptionId = useAdvancedStore.getState().subscriptions[0].id;
    useAdvancedStore.getState().deleteSubscription(subscriptionId);
    expect(
      useAdvancedStore.getState().subscriptions.find((item) => item.id === subscriptionId),
    ).toBeUndefined();
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

  it("odrzuca tylko uszkodzony rekord przy scalaniu zapisanych danych modułów, zachowując resztę", () => {
    const sample = createAdvancedData();
    const persistedState = {
      ...sample,
      subscriptions: [sample.subscriptions[0], { id: "bad" }],
    };
    const merge = useAdvancedStore.persist.getOptions().merge!;
    const merged = merge(persistedState, useAdvancedStore.getState()) as ReturnType<
      typeof useAdvancedStore.getState
    >;

    expect(merged.subscriptions).toHaveLength(1);
    expect(merged.subscriptions[0].id).toBe(sample.subscriptions[0].id);
    expect(merged.householdMembers).toEqual(sample.householdMembers);
  });
});
