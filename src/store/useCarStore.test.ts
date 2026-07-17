import { beforeEach, describe, expect, it } from "vitest";
import { useCarStore, type CarMutationResult } from "./useCarStore";

const vehicle = () => useCarStore.getState().vehicles.find((item) => item.id === "vehicle-1")!;

function seedVehicle(overrides: Partial<ReturnType<typeof vehicle>> = {}) {
  useCarStore.setState({
    vehicles: [
      {
        id: "vehicle-1",
        ownerId: "me",
        visibility: "private",
        name: "Auto testowe",
        make: "Toyota",
        model: "Corolla",
        year: 2020,
        plate: "WA12345",
        mileage: 1000,
        fuelType: "petrol",
        inspectionDate: "2026-08-01",
        insuranceDate: "2026-09-01",
        color: "#397763",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
    ],
  });
}

describe("useCarStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useCarStore.setState({
      vehicles: [],
      carExpenses: [],
      vehicleDeadlines: [],
      pendingMutations: [],
      serverAt: null,
      hydrated: false,
    });
  });

  it("addVehicle dodaje pojazd optymistycznie i kolejkuje mutację vehicle.create z prywatnością w ładunku", () => {
    const id = useCarStore.getState().addVehicle({
      name: "Nowe auto",
      make: "Skoda",
      model: "Octavia",
      year: 2022,
      plate: "WA99999",
      mileage: 500,
      fuelType: "diesel",
      inspectionDate: "2027-01-01",
      insuranceDate: "2027-02-01",
      color: "#000000",
      ownerId: "me",
      visibility: "household",
    });

    const created = useCarStore.getState().vehicles.find((item) => item.id === id);
    expect(created).toMatchObject({ name: "Nowe auto", mileage: 500, version: 1 });

    const mutation = useCarStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("vehicle.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({
      id,
      name: "Nowe auto",
      ownerId: "me",
      visibility: "household",
    });
  });

  it("addVehicle NIE tworzy lokalnie terminów inspection/insurance -- czeka na wynik serwera", () => {
    useCarStore.getState().addVehicle({
      name: "Nowe auto",
      make: "",
      model: "",
      year: 2022,
      plate: "",
      mileage: 0,
      fuelType: "petrol",
      inspectionDate: "2027-01-01",
      insuranceDate: "2027-02-01",
      color: "#000000",
      ownerId: "me",
      visibility: "household",
    });
    expect(useCarStore.getState().vehicleDeadlines).toHaveLength(0);
  });

  it("updateVehicle wysyła tylko dozwolone pola (bez mileage/ownerId/visibility) z baseVersion bieżącego rekordu", () => {
    seedVehicle();
    useCarStore.getState().updateVehicle("vehicle-1", {
      name: "Zmieniona nazwa",
      mileage: 99999,
      ownerId: "someone-else",
      visibility: "household",
    } as never);

    expect(vehicle().name).toBe("Zmieniona nazwa");
    // Local optimistic mileage must be untouched by updateVehicle -- it only moves via setVehicleMileage.
    expect(vehicle().mileage).toBe(1000);

    const mutation = useCarStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "vehicle.update",
      baseVersion: 1,
    });
    expect(mutation.payload).toEqual({
      id: "vehicle-1",
      changes: { name: "Zmieniona nazwa" },
    });
  });

  it("setVehicleMileage podbija przebieg lokalnie do Math.max i wysyła mutację vehicle.mileage bez baseVersion", () => {
    seedVehicle({ mileage: 1000 } as never);
    useCarStore.getState().setVehicleMileage("vehicle-1", 1500);
    expect(vehicle().mileage).toBe(1500);

    // Cofnięcie przebiegu jest lokalnie odrzucane (Math.max), tak jak zrobi to serwer.
    useCarStore.getState().setVehicleMileage("vehicle-1", 1200);
    expect(vehicle().mileage).toBe(1500);

    const mutations = useCarStore.getState().pendingMutations;
    expect(mutations).toHaveLength(2);
    for (const mutation of mutations) {
      expect(mutation.op).toBe("vehicle.mileage");
      expect(mutation.baseVersion).toBeUndefined();
    }
    expect(mutations[1].payload).toEqual({ id: "vehicle-1", mileage: 1200 });
  });

  it("addCarExpense z mileage podbija przebieg pojazdu lokalnie (Math.max), bez mileage nie rusza go", () => {
    seedVehicle({ mileage: 1000 } as never);
    useCarStore.getState().addCarExpense({
      vehicleId: "vehicle-1",
      date: "2026-07-01",
      type: "fuel",
      amountMinor: 15000,
      mileage: 1300,
      liters: 40,
      title: "Tankowanie",
      ownerId: "me",
      visibility: "private",
    });
    expect(vehicle().mileage).toBe(1300);

    useCarStore.getState().addCarExpense({
      vehicleId: "vehicle-1",
      date: "2026-07-02",
      type: "parking",
      amountMinor: 500,
      title: "Parking",
      ownerId: "me",
      visibility: "private",
    });
    expect(vehicle().mileage).toBe(1300);
    expect(useCarStore.getState().carExpenses).toHaveLength(2);
  });

  it("applyMutationResults zdejmuje z kolejki applied/duplicate i adoptuje serwerowe deadlines na vehicle.create", () => {
    const id = useCarStore.getState().addVehicle({
      name: "Nowe auto",
      make: "",
      model: "",
      year: 2022,
      plate: "",
      mileage: 500,
      fuelType: "petrol",
      inspectionDate: "2027-01-01",
      insuranceDate: "2027-02-01",
      color: "#000000",
      ownerId: "me",
      visibility: "household",
    });
    const mutation = useCarStore.getState().pendingMutations[0];
    const results: CarMutationResult[] = [
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          id,
          ownerId: "me",
          visibility: "household",
          name: "Nowe auto",
          make: "",
          model: "",
          year: 2022,
          plate: "",
          mileage: 500,
          fuelType: "petrol",
          inspectionDate: "2027-01-01",
          insuranceDate: "2027-02-01",
          color: "#000000",
          version: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        deadlines: [
          {
            id: "dl-inspection",
            vehicleId: id,
            kind: "inspection",
            title: "Badanie techniczne",
            dueDate: "2027-01-01",
            completed: false,
            version: 1,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "dl-insurance",
            vehicleId: id,
            kind: "insurance",
            title: "Odnowienie OC/AC",
            dueDate: "2027-02-01",
            completed: false,
            version: 1,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
    ];
    useCarStore.getState().applyMutationResults(results);

    expect(useCarStore.getState().pendingMutations).toHaveLength(0);
    expect(useCarStore.getState().vehicleDeadlines).toHaveLength(2);
    expect(
      useCarStore
        .getState()
        .vehicleDeadlines.map((deadline) => deadline.kind)
        .sort(),
    ).toEqual(["inspection", "insurance"]);
  });

  it("applyMutationResults adoptuje serwerowe deadlines zwrócone z vehicle.update (upsert po kind)", () => {
    seedVehicle();
    useCarStore.setState({
      vehicleDeadlines: [
        {
          id: "dl-inspection",
          vehicleId: "vehicle-1",
          kind: "inspection",
          title: "Badanie techniczne",
          dueDate: "2026-08-01",
          completed: false,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    useCarStore.getState().updateVehicle("vehicle-1", { inspectionDate: "2027-03-01" });
    const mutation = useCarStore.getState().pendingMutations[0];

    useCarStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          ...vehicle(),
          inspectionDate: "2027-03-01",
          version: 2,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        deadlines: [
          {
            id: "dl-inspection",
            vehicleId: "vehicle-1",
            kind: "inspection",
            title: "Badanie techniczne",
            dueDate: "2027-03-01",
            completed: false,
            version: 2,
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
    ]);

    expect(useCarStore.getState().vehicleDeadlines).toHaveLength(1);
    expect(useCarStore.getState().vehicleDeadlines[0].dueDate).toBe("2027-03-01");
    expect(useCarStore.getState().vehicleDeadlines[0].version).toBe(2);
  });

  it("applyMutationResults na vehicle.mileage adoptuje ZAWSZE zwrócony rekord -- także przy conflict (autorytatywna wartość), bez rebase'u", () => {
    seedVehicle({ mileage: 1000 } as never);
    useCarStore.getState().setVehicleMileage("vehicle-1", 1200);
    const mutation = useCarStore.getState().pendingMutations[0];
    expect(mutation.baseVersion).toBeUndefined();

    // Serwer: równoległe urządzenie już podbiło przebieg wyżej (1800) zanim ten batch dotarł.
    useCarStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "conflict",
        record: { ...vehicle(), mileage: 1800, version: 1, updatedAt: "2026-01-02T00:00:00.000Z" },
      },
    ]);

    expect(vehicle().mileage).toBe(1800);
    // To NIE jest rebase-i-retry: kolejka musi być pusta, żadna nowa mutacja mileage nie powstaje.
    expect(useCarStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults na conflict (vehicle.update) robi cichy rebase: nowy idempotencyKey, świeży baseVersion, reaplikowana delta", () => {
    seedVehicle({ version: 3 } as never);
    useCarStore.getState().updateVehicle("vehicle-1", { name: "Nowa nazwa" });
    const originalMutation = useCarStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(3);

    useCarStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 4,
        record: {
          ...vehicle(),
          color: "#ff0000",
          version: 4,
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    ]);

    expect(vehicle()).toMatchObject({ color: "#ff0000", name: "Nowa nazwa", version: 4 });

    const rebased = useCarStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].idempotencyKey).not.toBe(originalMutation.idempotencyKey);
    expect(rebased[0].baseVersion).toBe(4);
    expect(rebased[0].payload).toEqual({ id: "vehicle-1", changes: { name: "Nowa nazwa" } });
  });

  it("applyMutationResults zdejmuje z kolejki trwałe błędy (error) bez ponawiania", () => {
    seedVehicle();
    useCarStore.getState().removeCarExpense("does-not-matter"); // just to have a pending mutation
    const mutation = useCarStore.getState().pendingMutations[0];
    useCarStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "error",
        error: "Zły ładunek",
        code: "NOT_FOUND",
      },
    ]);
    expect(useCarStore.getState().pendingMutations).toHaveLength(0);
  });

  it("toggleVehicleDeadline wysyła deadline.update z baseVersion i przełącza completed lokalnie", () => {
    useCarStore.setState({
      vehicleDeadlines: [
        {
          id: "dl-1",
          vehicleId: "vehicle-1",
          kind: "custom",
          title: "Wymiana opon",
          completed: false,
          version: 2,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    useCarStore.getState().toggleVehicleDeadline("dl-1");
    expect(useCarStore.getState().vehicleDeadlines[0].completed).toBe(true);
    const mutation = useCarStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "deadline.update",
      baseVersion: 2,
      payload: { id: "dl-1", changes: { completed: true } },
    });
  });

  it("deleteVehicle usuwa lokalnie pojazd i wszystkie jego koszty/terminy (kaskada odbita natychmiast)", () => {
    seedVehicle();
    useCarStore.setState({
      carExpenses: [
        {
          id: "exp-1",
          ownerId: "me",
          visibility: "private",
          vehicleId: "vehicle-1",
          date: "2026-07-01",
          type: "fuel",
          amountMinor: 100,
          title: "Tankowanie",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      vehicleDeadlines: [
        {
          id: "dl-1",
          vehicleId: "vehicle-1",
          kind: "custom",
          title: "Wymiana opon",
          completed: false,
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    useCarStore.getState().deleteVehicle("vehicle-1");
    expect(useCarStore.getState().vehicles).toHaveLength(0);
    expect(useCarStore.getState().carExpenses).toHaveLength(0);
    expect(useCarStore.getState().vehicleDeadlines).toHaveLength(0);
    const mutation = useCarStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "vehicle.delete", payload: { id: "vehicle-1" } });
  });

  it("merge nie pokazuje fałszywego ostrzeżenia o uszkodzonych danych na czystej instalacji (persistedState === undefined)", () => {
    const warnings: string[] = [];
    const onWarning = (event: Event) => warnings.push((event as CustomEvent<string>).detail);
    window.addEventListener("puls:storage-warning", onWarning);
    try {
      const merge = useCarStore.persist.getOptions().merge!;
      const currentState = useCarStore.getState();
      const merged = merge(undefined, currentState);
      expect(merged).toBe(currentState);
      expect(warnings).toHaveLength(0);

      merge("not-an-object", currentState);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("niezgodny format");
    } finally {
      window.removeEventListener("puls:storage-warning", onWarning);
    }
  });

  it("resetCarData czyści cały stan i kolejkę", () => {
    seedVehicle();
    useCarStore.getState().addDeadline({ vehicleId: "vehicle-1", title: "Wymiana opon" });
    useCarStore.getState().resetCarData();
    const state = useCarStore.getState();
    expect(state.vehicles).toHaveLength(0);
    expect(state.vehicleDeadlines).toHaveLength(0);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.hydrated).toBe(false);
  });
});
