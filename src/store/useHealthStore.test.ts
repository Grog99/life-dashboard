import { beforeEach, describe, expect, it } from "vitest";
import { useHealthStore, type HealthMutationResult } from "./useHealthStore";

const appointment = () =>
  useHealthStore.getState().healthAppointments.find((item) => item.id === "appt-1")!;
const medication = () => useHealthStore.getState().medications.find((item) => item.id === "med-1")!;
const measurement = () =>
  useHealthStore.getState().healthMeasurements.find((item) => item.id === "measure-1")!;

function seedAppointment(overrides: Partial<ReturnType<typeof appointment>> = {}) {
  useHealthStore.setState({
    healthAppointments: [
      {
        id: "appt-1",
        ownerId: "me",
        visibility: "household",
        title: "Kontrola",
        clinician: "Dr. Kowalska",
        date: "2026-07-20",
        time: "10:30",
        status: "scheduled",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
    ],
  });
}

function seedMedication(overrides: Partial<ReturnType<typeof medication>> = {}) {
  useHealthStore.setState({
    medications: [
      {
        id: "med-1",
        ownerId: "me",
        visibility: "household",
        name: "Ibuprom",
        dosage: "200mg",
        schedule: "1x dziennie",
        active: true,
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
    ],
  });
}

function seedMeasurement(overrides: Partial<ReturnType<typeof measurement>> = {}) {
  useHealthStore.setState({
    healthMeasurements: [
      {
        id: "measure-1",
        ownerId: "me",
        visibility: "household",
        type: "blood_pressure",
        value: "120/80",
        unit: "mmHg",
        measuredAt: "2026-07-18T07:30",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
    ],
  });
}

describe("useHealthStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useHealthStore.setState({
      healthAppointments: [],
      medications: [],
      healthMeasurements: [],
      pendingMutations: [],
      serverAt: null,
      hydrated: false,
    });
  });

  // ---------------------------------------------------------------------
  // appointment.* -- optimistic mutations + queueing
  // ---------------------------------------------------------------------

  it("addHealthAppointment dodaje wizytę optymistycznie i kolejkuje appointment.create z prywatnością w ładunku", () => {
    const id = useHealthStore.getState().addHealthAppointment({
      title: "Kontrola",
      clinician: "Dr. Kowalska",
      date: "2026-07-20",
      time: "10:30",
      status: "scheduled",
      ownerId: "me",
      visibility: "private",
    });

    const created = useHealthStore.getState().healthAppointments.find((item) => item.id === id);
    expect(created).toMatchObject({ title: "Kontrola", status: "scheduled", version: 1 });

    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("appointment.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({
      id,
      title: "Kontrola",
      ownerId: "me",
      visibility: "private",
    });
  });

  it("updateHealthAppointment wysyła tylko dozwolone pola (w tym visibility) z baseVersion bieżącego rekordu", () => {
    seedAppointment();
    useHealthStore.getState().updateHealthAppointment("appt-1", {
      title: "Zmieniony tytuł",
      visibility: "private",
      ownerId: "someone-else",
    } as never);

    expect(appointment().title).toBe("Zmieniony tytuł");
    expect(appointment().visibility).toBe("private");

    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "appointment.update", baseVersion: 1 });
    expect(mutation.payload).toEqual({
      id: "appt-1",
      changes: { title: "Zmieniony tytuł", visibility: "private" },
    });
    // ownerId is never an allowed update key -- it must never reach the payload.
    expect((mutation.payload as { changes: Record<string, unknown> }).changes).not.toHaveProperty(
      "ownerId",
    );
  });

  it("toggleAppointmentCompleted (HealthPage wywołuje updateHealthAppointment(id, {status})) liczy się z bieżącego stanu i wysyła changes:{status}", () => {
    seedAppointment({ status: "scheduled" } as never);
    useHealthStore.getState().updateHealthAppointment("appt-1", { status: "completed" });
    expect(appointment().status).toBe("completed");
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "appointment.update",
      baseVersion: 1,
      payload: { id: "appt-1", changes: { status: "completed" } },
    });
  });

  it("deleteHealthAppointment usuwa lokalnie i kolejkuje appointment.delete", () => {
    seedAppointment();
    useHealthStore.getState().deleteHealthAppointment("appt-1");
    expect(useHealthStore.getState().healthAppointments).toHaveLength(0);
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "appointment.delete", payload: { id: "appt-1" } });
    expect(mutation.baseVersion).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // medication.* -- optimistic mutations + queueing
  // ---------------------------------------------------------------------

  it("addMedication dodaje lek optymistycznie i kolejkuje medication.create", () => {
    const id = useHealthStore.getState().addMedication({
      name: "Ibuprom",
      dosage: "200mg",
      schedule: "1x dziennie",
      active: true,
      ownerId: "me",
      visibility: "household",
    });

    expect(useHealthStore.getState().medications).toHaveLength(1);
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("medication.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({ id, name: "Ibuprom", visibility: "household" });
  });

  it("updateMedication wysyła tylko dozwolone pola (w tym visibility) z baseVersion bieżącego rekordu", () => {
    seedMedication();
    useHealthStore.getState().updateMedication("med-1", {
      dosage: "400mg",
      visibility: "private",
    });

    expect(medication().dosage).toBe("400mg");
    expect(medication().visibility).toBe("private");
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "medication.update", baseVersion: 1 });
    expect(mutation.payload).toEqual({
      id: "med-1",
      changes: { dosage: "400mg", visibility: "private" },
    });
  });

  it("deleteMedication usuwa lokalnie i kolejkuje medication.delete", () => {
    seedMedication();
    useHealthStore.getState().deleteMedication("med-1");
    expect(useHealthStore.getState().medications).toHaveLength(0);
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "medication.delete", payload: { id: "med-1" } });
  });

  // ---------------------------------------------------------------------
  // toggleMedicationTaken -- the real client-computed toggle: same date flips lastTakenOn on/off.
  // ---------------------------------------------------------------------

  it("toggleMedicationTaken ustawia lastTakenOn lokalnie i wysyła medication.update z changes:{lastTakenOn: date}", () => {
    seedMedication({ lastTakenOn: undefined } as never);
    useHealthStore.getState().toggleMedicationTaken("med-1", "2026-07-18");

    expect(medication().lastTakenOn).toBe("2026-07-18");
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "medication.update",
      baseVersion: 1,
      payload: { id: "med-1", changes: { lastTakenOn: "2026-07-18" } },
    });
  });

  it("toggleMedicationTaken jest prawdziwym togglem: drugie wywołanie tego samego dnia CZYŚCI lastTakenOn (nie ustawia go ponownie), wysyłając changes:{lastTakenOn: null}", () => {
    seedMedication({ lastTakenOn: "2026-07-18" } as never);
    useHealthStore.getState().toggleMedicationTaken("med-1", "2026-07-18");

    expect(medication().lastTakenOn).toBeUndefined();
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation.payload).toEqual({ id: "med-1", changes: { lastTakenOn: null } });
  });

  it("toggleMedicationTaken liczy każde wywołanie z bieżącego (już zmienionego) stanu lokalnego -- dwa kliknięcia offline nettują się poprawnie", () => {
    seedMedication({ lastTakenOn: undefined } as never);

    // click 1: not taken -> taken
    useHealthStore.getState().toggleMedicationTaken("med-1", "2026-07-18");
    expect(medication().lastTakenOn).toBe("2026-07-18");

    // click 2 (same day, still offline): taken -> cleared
    useHealthStore.getState().toggleMedicationTaken("med-1", "2026-07-18");
    expect(medication().lastTakenOn).toBeUndefined();

    const mutations = useHealthStore.getState().pendingMutations;
    expect(mutations).toHaveLength(2);
    expect(mutations[0].payload).toEqual({ id: "med-1", changes: { lastTakenOn: "2026-07-18" } });
    expect(mutations[1].payload).toEqual({ id: "med-1", changes: { lastTakenOn: null } });
    // Each toggle gets its own idempotency key -- they are never conflated.
    expect(mutations[0].idempotencyKey).not.toBe(mutations[1].idempotencyKey);
  });

  it("toggleMedicationTaken na inny dzień ustawia lastTakenOn na nową datę (nie czyści)", () => {
    seedMedication({ lastTakenOn: "2026-07-17" } as never);
    useHealthStore.getState().toggleMedicationTaken("med-1", "2026-07-18");
    expect(medication().lastTakenOn).toBe("2026-07-18");
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation.payload).toEqual({ id: "med-1", changes: { lastTakenOn: "2026-07-18" } });
  });

  it("retry (applyMutationResults wywołane dwukrotnie z tym samym idempotencyKey) nie przekręca stanu toggle'a lastTakenOn", () => {
    seedMedication({ lastTakenOn: undefined } as never);
    useHealthStore.getState().toggleMedicationTaken("med-1", "2026-07-18");
    expect(medication().lastTakenOn).toBe("2026-07-18");

    const mutation = useHealthStore.getState().pendingMutations[0];
    const results: HealthMutationResult[] = [
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: { ...medication(), version: 2, updatedAt: "2026-01-02T00:00:00.000Z" },
      },
    ];

    // First delivery of the result: flushes the queue and adopts the server record.
    useHealthStore.getState().applyMutationResults(results);
    expect(useHealthStore.getState().pendingMutations).toHaveLength(0);
    expect(medication().lastTakenOn).toBe("2026-07-18");
    expect(medication().version).toBe(2);

    // A duplicate delivery of the SAME result (e.g. a retried response, or an effect re-running)
    // must be a no-op: the mutation is no longer in the queue, so nothing re-applies and the
    // toggle does not flip back.
    useHealthStore.getState().applyMutationResults(results);
    expect(medication().lastTakenOn).toBe("2026-07-18");
    expect(medication().version).toBe(2);
    expect(useHealthStore.getState().pendingMutations).toHaveLength(0);
  });

  it("toggleMedicationActive liczy nowy stan lokalnie i wysyła medication.update z changes:{active}", () => {
    seedMedication({ active: true } as never);
    useHealthStore.getState().toggleMedicationActive("med-1");
    expect(medication().active).toBe(false);
    let mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "medication.update",
      baseVersion: 1,
      payload: { id: "med-1", changes: { active: false } },
    });

    // Toggling back reads the (already-flipped) local state, not the stale server value.
    useHealthStore.getState().toggleMedicationActive("med-1");
    expect(medication().active).toBe(true);
    mutation = useHealthStore.getState().pendingMutations[1];
    expect(mutation.payload).toEqual({ id: "med-1", changes: { active: true } });
  });

  // ---------------------------------------------------------------------
  // measurement.* -- optimistic mutations + queueing
  // ---------------------------------------------------------------------

  it("addHealthMeasurement dodaje pomiar optymistycznie i kolejkuje measurement.create z wolną datą/godziną measuredAt", () => {
    const id = useHealthStore.getState().addHealthMeasurement({
      type: "blood_pressure",
      value: "120/80",
      unit: "mmHg",
      measuredAt: "2026-07-18T07:30",
      ownerId: "me",
      visibility: "private",
    });

    expect(useHealthStore.getState().healthMeasurements).toHaveLength(1);
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("measurement.create");
    expect(mutation.payload).toMatchObject({
      id,
      value: "120/80",
      measuredAt: "2026-07-18T07:30",
      visibility: "private",
    });
  });

  it("updateHealthMeasurement wysyła tylko dozwolone pola (w tym visibility) z baseVersion bieżącego rekordu", () => {
    seedMeasurement();
    useHealthStore.getState().updateHealthMeasurement("measure-1", {
      value: "130/85",
      visibility: "private",
    });

    expect(measurement().value).toBe("130/85");
    expect(measurement().visibility).toBe("private");
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "measurement.update", baseVersion: 1 });
    expect(mutation.payload).toEqual({
      id: "measure-1",
      changes: { value: "130/85", visibility: "private" },
    });
  });

  it("deleteHealthMeasurement usuwa lokalnie i kolejkuje measurement.delete", () => {
    seedMeasurement();
    useHealthStore.getState().deleteHealthMeasurement("measure-1");
    expect(useHealthStore.getState().healthMeasurements).toHaveLength(0);
    const mutation = useHealthStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "measurement.delete", payload: { id: "measure-1" } });
  });

  // ---------------------------------------------------------------------
  // applyMutationResults -- terminal outcomes + silent per-record rebase on conflict
  // ---------------------------------------------------------------------

  it("applyMutationResults zdejmuje z kolejki applied i duplicate bez ponawiania (idempotencja retry)", () => {
    seedAppointment();
    useHealthStore.getState().deleteHealthAppointment("does-not-matter");
    const mutation = useHealthStore.getState().pendingMutations[0];
    const results: HealthMutationResult[] = [
      { idempotencyKey: mutation.idempotencyKey, status: "duplicate" },
    ];
    useHealthStore.getState().applyMutationResults(results);
    expect(useHealthStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults zdejmuje z kolejki trwałe błędy (error) bez ponawiania", () => {
    seedAppointment();
    useHealthStore.getState().deleteHealthAppointment("does-not-matter");
    const mutation = useHealthStore.getState().pendingMutations[0];
    useHealthStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "error",
        error: "Zły ładunek",
        code: "NOT_FOUND",
      },
    ]);
    expect(useHealthStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults adoptuje serwerowy rekord na appointment.create applied", () => {
    const id = useHealthStore.getState().addHealthAppointment({
      title: "Kontrola",
      clinician: "Dr. Kowalska",
      date: "2026-07-20",
      time: "10:30",
      status: "scheduled",
      ownerId: "me",
      visibility: "household",
    });
    const mutation = useHealthStore.getState().pendingMutations[0];
    useHealthStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          id,
          ownerId: "me",
          visibility: "household",
          title: "Kontrola",
          clinician: "Dr. Kowalska",
          date: "2026-07-20",
          time: "10:30",
          status: "scheduled",
          version: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ]);
    expect(useHealthStore.getState().pendingMutations).toHaveLength(0);
    expect(
      useHealthStore.getState().healthAppointments.find((item) => item.id === id)?.updatedAt,
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("applyMutationResults na conflict (appointment.update) robi cichy rebase per rekord: nowy idempotencyKey, świeży baseVersion, reaplikowana delta", () => {
    seedAppointment({ version: 3 } as never);
    useHealthStore.getState().updateHealthAppointment("appt-1", { title: "Nowy tytuł" });
    const originalMutation = useHealthStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(3);

    useHealthStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 4,
        record: {
          ...appointment(),
          location: "Nowa lokalizacja",
          version: 4,
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    ]);

    expect(appointment()).toMatchObject({
      location: "Nowa lokalizacja",
      title: "Nowy tytuł",
      version: 4,
    });
    const rebased = useHealthStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].idempotencyKey).not.toBe(originalMutation.idempotencyKey);
    expect(rebased[0].baseVersion).toBe(4);
    expect(rebased[0].payload).toEqual({ id: "appt-1", changes: { title: "Nowy tytuł" } });
  });

  it("applyMutationResults na conflict (medication.update z toggleMedicationTaken) robi cichy rebase, zachowując zamierzony toggle", () => {
    seedMedication({ version: 2, lastTakenOn: undefined } as never);
    useHealthStore.getState().toggleMedicationTaken("med-1", "2026-07-18");
    const originalMutation = useHealthStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(2);
    expect(originalMutation.payload).toEqual({
      id: "med-1",
      changes: { lastTakenOn: "2026-07-18" },
    });

    // Another device bumped the record (e.g. changed the dosage) in the meantime.
    useHealthStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 3,
        record: { ...medication(), dosage: "400mg", lastTakenOn: undefined, version: 3 },
      },
    ]);

    expect(medication()).toMatchObject({
      dosage: "400mg",
      lastTakenOn: "2026-07-18",
      version: 3,
    });
    const rebased = useHealthStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].baseVersion).toBe(3);
    expect(rebased[0].payload).toEqual({
      id: "med-1",
      changes: { lastTakenOn: "2026-07-18" },
    });
  });

  it("applyMutationResults na conflict (measurement.update) robi cichy rebase per rekord", () => {
    seedMeasurement({ version: 1 } as never);
    useHealthStore.getState().updateHealthMeasurement("measure-1", { value: "125/82" });
    const originalMutation = useHealthStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(1);

    useHealthStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 2,
        record: { ...measurement(), notes: "Dopisane gdzie indziej", version: 2 },
      },
    ]);

    expect(measurement()).toMatchObject({
      notes: "Dopisane gdzie indziej",
      value: "125/82",
      version: 2,
    });
    const rebased = useHealthStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].baseVersion).toBe(2);
    expect(rebased[0].payload).toEqual({ id: "measure-1", changes: { value: "125/82" } });
  });

  it("merge nie pokazuje fałszywego ostrzeżenia o uszkodzonych danych na czystej instalacji (persistedState === undefined)", () => {
    const warnings: string[] = [];
    const onWarning = (event: Event) => warnings.push((event as CustomEvent<string>).detail);
    window.addEventListener("puls:storage-warning", onWarning);
    try {
      const merge = useHealthStore.persist.getOptions().merge!;
      const currentState = useHealthStore.getState();
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

  it("resetHealthData czyści cały stan i kolejkę", () => {
    seedAppointment();
    seedMedication();
    seedMeasurement();
    useHealthStore.getState().resetHealthData();
    const state = useHealthStore.getState();
    expect(state.healthAppointments).toHaveLength(0);
    expect(state.medications).toHaveLength(0);
    expect(state.healthMeasurements).toHaveLength(0);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.hydrated).toBe(false);
  });
});
