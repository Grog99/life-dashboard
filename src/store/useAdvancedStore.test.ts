import { beforeEach, describe, expect, it } from "vitest";
import { createAdvancedData } from "../data/advancedData";
import { useAdvancedStore } from "./useAdvancedStore";

describe("advanced health store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAdvancedStore.setState(createAdvancedData());
  });

  it("dodaje prywatną wizytę", () => {
    const id = useAdvancedStore.getState().addHealthAppointment({
      title: "Kontrola",
      clinician: "Przychodnia",
      date: "2026-08-01",
      time: "12:00",
      status: "scheduled",
      ownerId: "me",
      visibility: "private",
    });

    expect(
      useAdvancedStore.getState().healthAppointments.find((item) => item.id === id),
    ).toMatchObject({
      title: "Kontrola",
      visibility: "private",
    });
  });

  it("oznacza lek jako przyjęty i pozwala cofnąć oznaczenie", () => {
    const medicationId = useAdvancedStore.getState().medications[0].id;
    useAdvancedStore.getState().toggleMedicationTaken(medicationId, "2099-01-01");
    expect(
      useAdvancedStore.getState().medications.find((item) => item.id === medicationId)?.lastTakenOn,
    ).toBe("2099-01-01");

    useAdvancedStore.getState().toggleMedicationTaken(medicationId, "2099-01-01");
    expect(
      useAdvancedStore.getState().medications.find((item) => item.id === medicationId)?.lastTakenOn,
    ).toBeUndefined();
  });

  it("dodaje pomiar zdrowia", () => {
    const id = useAdvancedStore.getState().addHealthMeasurement({
      type: "blood_pressure",
      value: "120/80",
      unit: "mmHg",
      measuredAt: "2026-07-10T08:00",
      ownerId: "me",
      visibility: "private",
    });

    expect(useAdvancedStore.getState().healthMeasurements[0]).toMatchObject({
      id,
      value: "120/80",
    });
  });

  it("pozwala edytować lek i pomiar bez utraty tożsamości rekordu", () => {
    const medicationId = useAdvancedStore.getState().medications[0].id;
    useAdvancedStore.getState().updateMedication(medicationId, { visibility: "household" });
    expect(
      useAdvancedStore.getState().medications.find((item) => item.id === medicationId)?.visibility,
    ).toBe("household");

    const measurementId = useAdvancedStore.getState().addHealthMeasurement({
      type: "weight",
      value: "80",
      unit: "kg",
      measuredAt: "2026-07-10T08:00",
      ownerId: "me",
      visibility: "private",
    });
    useAdvancedStore
      .getState()
      .updateHealthMeasurement(measurementId, { value: "79", visibility: "household" });
    expect(
      useAdvancedStore.getState().healthMeasurements.find((item) => item.id === measurementId),
    ).toMatchObject({
      value: "79",
      visibility: "household",
    });
  });

  it("tworzy rezerwację podróży", () => {
    const tripId = useAdvancedStore.getState().trips[0].id;
    const bookingId = useAdvancedStore.getState().addTripBooking({
      tripId,
      type: "stay",
      provider: "Hotel",
      reference: "ABC",
      title: "Nocleg",
      startAt: "2026-08-02T15:00",
      amountMinor: 100000,
      paid: false,
    });

    expect(
      useAdvancedStore.getState().tripBookings.find((item) => item.id === bookingId)?.paid,
    ).toBe(false);
  });

  it("dodaje składniki przepisu do listy zakupów bez duplikatów", () => {
    useAdvancedStore.setState({
      recipes: [
        {
          id: "recipe-test",
          name: "Test",
          minutes: 10,
          servings: 2,
          tags: [],
          ingredients: ["Cebula 1 szt.", "Cebula 2 szt.", "Czosnek 3 ząbki"],
          favorite: false,
          ownerId: "me",
          visibility: "private",
        },
      ],
      shoppingItems: [],
    });
    const added = useAdvancedStore.getState().addRecipeIngredientsToShopping("recipe-test");
    expect(added).toBe(2);
    expect(useAdvancedStore.getState().shoppingItems).toHaveLength(2);
    const names = useAdvancedStore.getState().shoppingItems.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("odrzuca tylko uszkodzony rekord przy scalaniu zapisanych danych modułów, zachowując resztę", () => {
    const sample = createAdvancedData();
    const persistedState = {
      ...sample,
      medications: [sample.medications[0], { id: "bad" }],
    };
    const merge = useAdvancedStore.persist.getOptions().merge!;
    const merged = merge(persistedState, useAdvancedStore.getState()) as ReturnType<
      typeof useAdvancedStore.getState
    >;

    expect(merged.medications).toHaveLength(1);
    expect(merged.medications[0].id).toBe(sample.medications[0].id);
    expect(merged.trips).toEqual(sample.trips);
  });
});
