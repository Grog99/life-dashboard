import { beforeEach, describe, expect, it } from "vitest";
import { usePetsStore, type PetsMutationResult } from "./usePetsStore";

const pet = () => usePetsStore.getState().pets.find((item) => item.id === "pet-1")!;
const visit = () => usePetsStore.getState().petVisits.find((item) => item.id === "visit-1")!;

function seedPet(overrides: Partial<ReturnType<typeof pet>> = {}) {
  usePetsStore.setState({
    pets: [
      {
        id: "pet-1",
        ownerId: "me",
        visibility: "household",
        name: "Fistaszek",
        kind: "rabbit",
        color: "#b17a42",
        species: "Królik miniaturka",
        birthDate: "2024-01-01",
        notes: undefined,
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
    ],
  });
}

function seedVisit(overrides: Partial<ReturnType<typeof visit>> = {}) {
  usePetsStore.setState({
    petVisits: [
      {
        id: "visit-1",
        ownerId: "me",
        visibility: "household",
        petId: "pet-1",
        title: "Kontrola",
        clinician: "dr Nowak",
        date: "2026-08-01",
        time: "10:00",
        status: "scheduled",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
    ],
  });
}

describe("usePetsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    usePetsStore.setState({
      pets: [],
      petExpenses: [],
      petVisits: [],
      pendingMutations: [],
      serverAt: null,
      hydrated: false,
    });
  });

  it("addPet dodaje profil optymistycznie i kolejkuje pet.create z prywatnością w ładunku", () => {
    const id = usePetsStore.getState().addPet({
      name: "Fistaszek",
      kind: "rabbit",
      color: "#b17a42",
      species: "Królik miniaturka",
      birthDate: "2024-01-01",
      ownerId: "me",
      visibility: "household",
    });

    const created = usePetsStore.getState().pets.find((item) => item.id === id);
    expect(created).toMatchObject({ name: "Fistaszek", kind: "rabbit", version: 1 });

    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("pet.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({
      id,
      name: "Fistaszek",
      ownerId: "me",
      visibility: "household",
    });
  });

  it("addPet niesie fishStock w całości dla profilu akwarium", () => {
    const fishStock = [
      { id: "fish-1", species: "Neonek innesa", count: 12 },
      { id: "fish-2", species: "Kirysek panda", count: 6 },
    ];
    const id = usePetsStore.getState().addPet({
      name: "Akwarium w salonie",
      kind: "aquarium",
      color: "#397763",
      fishStock,
      ownerId: "me",
      visibility: "household",
    });

    expect(usePetsStore.getState().pets.find((item) => item.id === id)?.fishStock).toEqual(
      fishStock,
    );
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation.payload.fishStock).toEqual(fishStock);
  });

  it("updatePet wysyła tylko dozwolone pola (w tym visibility) z baseVersion bieżącego rekordu", () => {
    seedPet();
    usePetsStore.getState().updatePet("pet-1", {
      name: "Zmienione imię",
      visibility: "private",
      ownerId: "someone-else",
    } as never);

    expect(pet().name).toBe("Zmienione imię");
    expect(pet().visibility).toBe("private");

    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "pet.update", baseVersion: 1 });
    expect(mutation.payload).toEqual({
      id: "pet-1",
      changes: { name: "Zmienione imię", visibility: "private" },
    });
  });

  it("updatePet niesie fishStock w całości przy edycji obsady akwarium", () => {
    seedPet({ kind: "aquarium", species: undefined, birthDate: undefined } as never);
    const nextFishStock = [{ id: "fish-1", species: "Gupik", count: 4 }];
    usePetsStore.getState().updatePet("pet-1", { fishStock: nextFishStock });

    expect(pet().fishStock).toEqual(nextFishStock);
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation.payload).toEqual({
      id: "pet-1",
      changes: { fishStock: nextFishStock },
    });
  });

  it("deletePet usuwa lokalnie profil i wszystkie jego wydatki/wizyty (kaskada odbita natychmiast)", () => {
    seedPet();
    usePetsStore.setState({
      petExpenses: [
        {
          id: "exp-1",
          ownerId: "me",
          visibility: "household",
          petId: "pet-1",
          date: "2026-07-01",
          type: "food",
          amountMinor: 1000,
          title: "Karma",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      petVisits: [
        {
          id: "visit-1",
          ownerId: "me",
          visibility: "household",
          petId: "pet-1",
          title: "Kontrola",
          clinician: "dr Nowak",
          date: "2026-08-01",
          time: "10:00",
          status: "scheduled",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    usePetsStore.getState().deletePet("pet-1");
    expect(usePetsStore.getState().pets).toHaveLength(0);
    expect(usePetsStore.getState().petExpenses).toHaveLength(0);
    expect(usePetsStore.getState().petVisits).toHaveLength(0);
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "pet.delete", payload: { id: "pet-1" } });
  });

  it("addPetExpense dodaje wydatek optymistycznie i kolejkuje expense.create", () => {
    seedPet();
    const id = usePetsStore.getState().addPetExpense({
      petId: "pet-1",
      date: "2026-07-01",
      type: "food",
      amountMinor: 4200,
      title: "Siano i granulat",
      ownerId: "me",
      visibility: "household",
    });

    expect(usePetsStore.getState().petExpenses).toHaveLength(1);
    expect(usePetsStore.getState().petExpenses[0].id).toBe(id);
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("expense.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({ id, petId: "pet-1", amountMinor: 4200 });
  });

  it("deletePetExpense usuwa lokalnie i kolejkuje expense.delete bez baseVersion", () => {
    usePetsStore.setState({
      petExpenses: [
        {
          id: "exp-1",
          ownerId: "me",
          visibility: "household",
          petId: "pet-1",
          date: "2026-07-01",
          type: "food",
          amountMinor: 1000,
          title: "Karma",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    usePetsStore.getState().deletePetExpense("exp-1");
    expect(usePetsStore.getState().petExpenses).toHaveLength(0);
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "expense.delete", payload: { id: "exp-1" } });
    expect(mutation.baseVersion).toBeUndefined();
  });

  it("addPetVisit dodaje wizytę optymistycznie i kolejkuje visit.create", () => {
    seedPet();
    const id = usePetsStore.getState().addPetVisit({
      petId: "pet-1",
      title: "Szczepienie",
      clinician: "dr Nowak",
      date: "2026-08-01",
      time: "10:00",
      status: "scheduled",
      ownerId: "me",
      visibility: "household",
    });

    expect(usePetsStore.getState().petVisits).toHaveLength(1);
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("visit.create");
    expect(mutation.payload).toMatchObject({ id, petId: "pet-1", title: "Szczepienie" });
  });

  it("updatePetVisit wysyła tylko dozwolone pola z baseVersion bieżącego rekordu", () => {
    seedVisit();
    usePetsStore.getState().updatePetVisit("visit-1", {
      title: "Zmieniony tytuł",
      visibility: "private",
      petId: "someone-elses-pet",
    } as never);

    expect(visit().title).toBe("Zmieniony tytuł");
    expect(visit().visibility).toBe("private");
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "visit.update", baseVersion: 1 });
    expect(mutation.payload).toEqual({
      id: "visit-1",
      changes: { title: "Zmieniony tytuł", visibility: "private" },
    });
  });

  it("togglePetVisitCompleted liczy nowy status lokalnie i wysyła visit.update z changes:{status}", () => {
    seedVisit({ status: "scheduled" } as never);
    usePetsStore.getState().togglePetVisitCompleted("visit-1");
    expect(visit().status).toBe("completed");
    let mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "visit.update",
      baseVersion: 1,
      payload: { id: "visit-1", changes: { status: "completed" } },
    });

    // Przełączenie z powrotem liczy się z bieżącego (już zmienionego) stanu lokalnego.
    usePetsStore.getState().togglePetVisitCompleted("visit-1");
    expect(visit().status).toBe("scheduled");
    mutation = usePetsStore.getState().pendingMutations[1];
    expect(mutation.payload).toEqual({ id: "visit-1", changes: { status: "scheduled" } });
  });

  it("deletePetVisit usuwa lokalnie i kolejkuje visit.delete", () => {
    seedVisit();
    usePetsStore.getState().deletePetVisit("visit-1");
    expect(usePetsStore.getState().petVisits).toHaveLength(0);
    const mutation = usePetsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "visit.delete", payload: { id: "visit-1" } });
  });

  it("applyMutationResults zdejmuje z kolejki applied i duplicate bez ponawiania (idempotencja retry)", () => {
    seedPet();
    usePetsStore.getState().deletePetExpense("does-not-matter");
    const mutation = usePetsStore.getState().pendingMutations[0];
    const results: PetsMutationResult[] = [
      { idempotencyKey: mutation.idempotencyKey, status: "duplicate" },
    ];
    usePetsStore.getState().applyMutationResults(results);
    expect(usePetsStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults adoptuje serwerowy rekord na pet.create applied", () => {
    const id = usePetsStore.getState().addPet({
      name: "Fistaszek",
      kind: "rabbit",
      color: "#b17a42",
      ownerId: "me",
      visibility: "household",
    });
    const mutation = usePetsStore.getState().pendingMutations[0];
    usePetsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          id,
          ownerId: "me",
          visibility: "household",
          name: "Fistaszek",
          kind: "rabbit",
          color: "#b17a42",
          version: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ]);
    expect(usePetsStore.getState().pendingMutations).toHaveLength(0);
    expect(usePetsStore.getState().pets.find((item) => item.id === id)?.updatedAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("applyMutationResults na conflict (pet.update) robi cichy rebase: nowy idempotencyKey, świeży baseVersion, reaplikowana delta", () => {
    seedPet({ version: 3 } as never);
    usePetsStore.getState().updatePet("pet-1", { name: "Nowe imię" });
    const originalMutation = usePetsStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(3);

    usePetsStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 4,
        record: { ...pet(), color: "#ff0000", version: 4, updatedAt: "2026-01-03T00:00:00.000Z" },
      },
    ]);

    expect(pet()).toMatchObject({ color: "#ff0000", name: "Nowe imię", version: 4 });
    const rebased = usePetsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].idempotencyKey).not.toBe(originalMutation.idempotencyKey);
    expect(rebased[0].baseVersion).toBe(4);
    expect(rebased[0].payload).toEqual({ id: "pet-1", changes: { name: "Nowe imię" } });
  });

  it("applyMutationResults na conflict (visit.update) robi cichy rebase per rekord", () => {
    seedVisit({ version: 2 } as never);
    usePetsStore.getState().togglePetVisitCompleted("visit-1");
    const originalMutation = usePetsStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(2);

    usePetsStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 3,
        record: {
          ...visit(),
          clinician: "dr Inny",
          version: 3,
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    ]);

    expect(visit()).toMatchObject({ clinician: "dr Inny", status: "completed", version: 3 });
    const rebased = usePetsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].baseVersion).toBe(3);
    expect(rebased[0].payload).toEqual({ id: "visit-1", changes: { status: "completed" } });
  });

  it("applyMutationResults zdejmuje z kolejki trwałe błędy (error) bez ponawiania", () => {
    seedPet();
    usePetsStore.getState().deletePetExpense("does-not-matter");
    const mutation = usePetsStore.getState().pendingMutations[0];
    usePetsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "error",
        error: "Zły ładunek",
        code: "NOT_FOUND",
      },
    ]);
    expect(usePetsStore.getState().pendingMutations).toHaveLength(0);
  });

  it("merge nie pokazuje fałszywego ostrzeżenia o uszkodzonych danych na czystej instalacji (persistedState === undefined)", () => {
    const warnings: string[] = [];
    const onWarning = (event: Event) => warnings.push((event as CustomEvent<string>).detail);
    window.addEventListener("puls:storage-warning", onWarning);
    try {
      const merge = usePetsStore.persist.getOptions().merge!;
      const currentState = usePetsStore.getState();
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

  it("resetPetsData czyści cały stan i kolejkę", () => {
    seedPet();
    seedVisit();
    usePetsStore.getState().resetPetsData();
    const state = usePetsStore.getState();
    expect(state.pets).toHaveLength(0);
    expect(state.petVisits).toHaveLength(0);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.hydrated).toBe(false);
  });
});
