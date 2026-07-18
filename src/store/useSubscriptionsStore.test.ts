import { beforeEach, describe, expect, it } from "vitest";
import { useSubscriptionsStore, type SubscriptionMutationResult } from "./useSubscriptionsStore";

const subscription = () =>
  useSubscriptionsStore.getState().subscriptions.find((item) => item.id === "sub-1")!;

function seedSubscription(overrides: Partial<ReturnType<typeof subscription>> = {}) {
  useSubscriptionsStore.setState({
    subscriptions: [
      {
        id: "sub-1",
        ownerId: "me",
        visibility: "household",
        name: "Netflix",
        category: "Rozrywka",
        amountMinor: 4390,
        currency: "PLN",
        cycle: "monthly",
        nextPayment: "2026-08-01",
        payer: "Karta",
        status: "active",
        reminderDays: 3,
        color: "#397763",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      },
    ],
  });
}

describe("useSubscriptionsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useSubscriptionsStore.setState({
      subscriptions: [],
      pendingMutations: [],
      serverAt: null,
      hydrated: false,
    });
  });

  // ---------------------------------------------------------------------
  // addSubscription -- optimistic create + queueing
  // ---------------------------------------------------------------------

  it("addSubscription dodaje subskrypcję optymistycznie i kolejkuje subscription.create z prywatnością w ładunku", () => {
    const id = useSubscriptionsStore.getState().addSubscription({
      ownerId: "me",
      visibility: "private",
      name: "Netflix",
      category: "Rozrywka",
      amountMinor: 4390,
      currency: "PLN",
      cycle: "monthly",
      nextPayment: "2026-08-01",
      payer: "Karta",
      status: "active",
      reminderDays: 3,
      color: "#397763",
    });

    const created = useSubscriptionsStore.getState().subscriptions.find((item) => item.id === id);
    expect(created).toMatchObject({ name: "Netflix", status: "active", version: 1 });
    expect(created?.updatedAt).toBeDefined();

    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("subscription.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({
      id,
      name: "Netflix",
      ownerId: "me",
      visibility: "private",
    });
  });

  // ---------------------------------------------------------------------
  // updateSubscription -- optimistic update, only allowed keys, version-carrying queue
  // ---------------------------------------------------------------------

  it("updateSubscription wysyła tylko dozwolone pola (w tym visibility) z baseVersion bieżącego rekordu", () => {
    seedSubscription();
    useSubscriptionsStore.getState().updateSubscription("sub-1", {
      name: "Netflix Premium",
      visibility: "private",
      ownerId: "someone-else",
    } as never);

    expect(subscription().name).toBe("Netflix Premium");
    expect(subscription().visibility).toBe("private");

    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "subscription.update", baseVersion: 1 });
    expect(mutation.payload).toEqual({
      id: "sub-1",
      changes: { name: "Netflix Premium", visibility: "private" },
    });
    // ownerId is never an allowed update key -- it must never reach the payload.
    expect((mutation.payload as { changes: Record<string, unknown> }).changes).not.toHaveProperty(
      "ownerId",
    );
  });

  it("updateSubscription ignoruje zmiany na polach spoza SUBSCRIPTION_UPDATE_KEYS (np. id/version/updatedAt)", () => {
    seedSubscription();
    useSubscriptionsStore.getState().updateSubscription("sub-1", {
      id: "sub-hacked",
      version: 99,
      updatedAt: "2099-01-01T00:00:00.000Z",
      status: "paused",
    } as never);

    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(mutation.payload).toEqual({ id: "sub-1", changes: { status: "paused" } });
  });

  it("updateSubscription nie robi nic (brak mutacji w kolejce), gdy id nie istnieje lokalnie", () => {
    useSubscriptionsStore.getState().updateSubscription("does-not-exist", { status: "paused" });
    expect(useSubscriptionsStore.getState().pendingMutations).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // renew / togglePause (SubscriptionsPage.tsx) -- absolute updateSubscription calls, no
  // dedicated store actions (docs/plans/subskrypcje-sql.md "Czym Subskrypcje są PROSTSZE").
  // ---------------------------------------------------------------------

  it("renew (SubscriptionsPage) liczy absolutną nową datę/status lokalnie i woła zwykłe updateSubscription({nextPayment,status})", () => {
    seedSubscription({ nextPayment: "2026-08-01", status: "cancelled" } as never);
    // SubscriptionsPage.tsx's renew() computes the next occurrence and reactivates a cancelled
    // subscription -- both are absolute values computed client-side, sent as a plain update.
    useSubscriptionsStore.getState().updateSubscription("sub-1", {
      nextPayment: "2026-09-01",
      status: "active",
    });

    expect(subscription().nextPayment).toBe("2026-09-01");
    expect(subscription().status).toBe("active");
    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "subscription.update",
      baseVersion: 1,
      payload: { id: "sub-1", changes: { nextPayment: "2026-09-01", status: "active" } },
    });
  });

  it("togglePause (SubscriptionsPage) liczy nowy status lokalnie (active<->paused) i woła zwykłe updateSubscription({status})", () => {
    seedSubscription({ status: "active" } as never);
    useSubscriptionsStore.getState().updateSubscription("sub-1", { status: "paused" });
    expect(subscription().status).toBe("paused");
    let mutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "subscription.update",
      baseVersion: 1,
      payload: { id: "sub-1", changes: { status: "paused" } },
    });

    // Toggling back reads the (already-updated) local state, not a stale server value.
    useSubscriptionsStore.getState().updateSubscription("sub-1", { status: "active" });
    expect(subscription().status).toBe("active");
    mutation = useSubscriptionsStore.getState().pendingMutations[1];
    expect(mutation.payload).toEqual({ id: "sub-1", changes: { status: "active" } });
    // Second update's baseVersion is still the LOCAL (not-yet-server-confirmed) version -- the
    // store has no aggregate/monotonic field here, it just re-reads `existing.version` each call.
    expect(mutation.baseVersion).toBe(1);
  });

  // ---------------------------------------------------------------------
  // deleteSubscription -- optimistic delete + queueing
  // ---------------------------------------------------------------------

  it("deleteSubscription usuwa lokalnie i kolejkuje subscription.delete (bez baseVersion)", () => {
    seedSubscription();
    useSubscriptionsStore.getState().deleteSubscription("sub-1");
    expect(useSubscriptionsStore.getState().subscriptions).toHaveLength(0);
    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "subscription.delete", payload: { id: "sub-1" } });
    expect(mutation.baseVersion).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // applyMutationResults -- terminal outcomes + idempotent retries + silent per-record rebase
  // ---------------------------------------------------------------------

  it("applyMutationResults zdejmuje z kolejki applied i duplicate bez ponawiania (idempotencja retry)", () => {
    seedSubscription();
    useSubscriptionsStore.getState().deleteSubscription("does-not-matter");
    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    const results: SubscriptionMutationResult[] = [
      { idempotencyKey: mutation.idempotencyKey, status: "duplicate" },
    ];
    useSubscriptionsStore.getState().applyMutationResults(results);
    expect(useSubscriptionsStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults zdejmuje z kolejki trwałe błędy (error) bez ponawiania", () => {
    seedSubscription();
    useSubscriptionsStore.getState().deleteSubscription("does-not-matter");
    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    useSubscriptionsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "error",
        error: "Zły ładunek",
        code: "NOT_FOUND",
      },
    ]);
    expect(useSubscriptionsStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults adoptuje serwerowy rekord na subscription.create applied", () => {
    const id = useSubscriptionsStore.getState().addSubscription({
      ownerId: "me",
      visibility: "household",
      name: "Netflix",
      category: "Rozrywka",
      amountMinor: 4390,
      currency: "PLN",
      cycle: "monthly",
      nextPayment: "2026-08-01",
      payer: "Karta",
      status: "active",
      reminderDays: 3,
      color: "#397763",
    });
    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    useSubscriptionsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          id,
          ownerId: "me",
          visibility: "household",
          name: "Netflix",
          category: "Rozrywka",
          amountMinor: 4390,
          currency: "PLN",
          cycle: "monthly",
          nextPayment: "2026-08-01",
          payer: "Karta",
          status: "active",
          reminderDays: 3,
          color: "#397763",
          version: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ]);
    expect(useSubscriptionsStore.getState().pendingMutations).toHaveLength(0);
    expect(
      useSubscriptionsStore.getState().subscriptions.find((item) => item.id === id)?.updatedAt,
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("retry (applyMutationResults wywołane dwukrotnie z tym samym idempotencyKey) nie dubluje lokalnego stanu ani kolejki", () => {
    seedSubscription({ version: 1 } as never);
    useSubscriptionsStore.getState().updateSubscription("sub-1", { status: "paused" });
    expect(subscription().status).toBe("paused");

    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    const results: SubscriptionMutationResult[] = [
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: { ...subscription(), version: 2, updatedAt: "2026-01-02T00:00:00.000Z" },
      },
    ];

    // First delivery of the result: flushes the queue and adopts the server record.
    useSubscriptionsStore.getState().applyMutationResults(results);
    expect(useSubscriptionsStore.getState().pendingMutations).toHaveLength(0);
    expect(useSubscriptionsStore.getState().subscriptions).toHaveLength(1);
    expect(subscription().status).toBe("paused");
    expect(subscription().version).toBe(2);

    // A duplicate delivery of the SAME result (e.g. a retried response, or an effect re-running)
    // must be a no-op: the mutation is no longer in the queue, so nothing re-applies and no
    // duplicate record/mutation is created.
    useSubscriptionsStore.getState().applyMutationResults(results);
    expect(useSubscriptionsStore.getState().subscriptions).toHaveLength(1);
    expect(subscription().status).toBe("paused");
    expect(subscription().version).toBe(2);
    expect(useSubscriptionsStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults na conflict (subscription.update) robi cichy rebase per rekord: nowy idempotencyKey, świeży baseVersion, reaplikowana delta", () => {
    seedSubscription({ version: 3 } as never);
    useSubscriptionsStore.getState().updateSubscription("sub-1", { name: "Nowa nazwa" });
    const originalMutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(3);

    useSubscriptionsStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 4,
        record: {
          ...subscription(),
          payer: "Konto wspólne",
          version: 4,
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    ]);

    expect(subscription()).toMatchObject({
      payer: "Konto wspólne",
      name: "Nowa nazwa",
      version: 4,
    });
    const rebased = useSubscriptionsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].idempotencyKey).not.toBe(originalMutation.idempotencyKey);
    expect(rebased[0].baseVersion).toBe(4);
    expect(rebased[0].payload).toEqual({ id: "sub-1", changes: { name: "Nowa nazwa" } });
  });

  it("applyMutationResults na conflict (renew/togglePause -- update wielopolowy) reaplikuje CAŁĄ deltę zmian na świeżym rekordzie", () => {
    seedSubscription({ version: 2, nextPayment: "2026-08-01", status: "cancelled" } as never);
    useSubscriptionsStore.getState().updateSubscription("sub-1", {
      nextPayment: "2026-09-01",
      status: "active",
    });
    const originalMutation = useSubscriptionsStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(2);

    // Another device changed the color in the meantime.
    useSubscriptionsStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 3,
        record: {
          ...subscription(),
          color: "#ff0000",
          nextPayment: "2026-08-01",
          status: "cancelled",
          version: 3,
        },
      },
    ]);

    expect(subscription()).toMatchObject({
      color: "#ff0000",
      nextPayment: "2026-09-01",
      status: "active",
      version: 3,
    });
    const rebased = useSubscriptionsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].baseVersion).toBe(3);
    expect(rebased[0].payload).toEqual({
      id: "sub-1",
      changes: { nextPayment: "2026-09-01", status: "active" },
    });
  });

  it("applyMutationResults na conflict (subscription.create -- kolizja id) adoptuje zwrócony rekord tak samo jak applied", () => {
    const id = useSubscriptionsStore.getState().addSubscription({
      ownerId: "me",
      visibility: "household",
      name: "Netflix",
      category: "Rozrywka",
      amountMinor: 4390,
      currency: "PLN",
      cycle: "monthly",
      nextPayment: "2026-08-01",
      payer: "Karta",
      status: "active",
      reminderDays: 3,
      color: "#397763",
    });
    const mutation = useSubscriptionsStore.getState().pendingMutations[0];
    useSubscriptionsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "conflict",
        currentVersion: 1,
        record: {
          id,
          ownerId: "someone-else",
          visibility: "household",
          name: "Już istniejąca subskrypcja",
          category: "Rozrywka",
          amountMinor: 999,
          currency: "PLN",
          cycle: "monthly",
          nextPayment: "2026-08-01",
          payer: "",
          status: "active",
          reminderDays: 0,
          color: "#000000",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    // subscription.create conflicts (ID_TAKEN) are not update ops -- no rebase, the queue simply
    // drains (wzór reconcileTerminal w useHealthStore.ts/usePetsStore.ts).
    expect(useSubscriptionsStore.getState().pendingMutations).toHaveLength(0);
    const adopted = useSubscriptionsStore.getState().subscriptions.find((item) => item.id === id);
    expect(adopted?.name).toBe("Już istniejąca subskrypcja");
    expect(adopted?.ownerId).toBe("someone-else");
  });

  // ---------------------------------------------------------------------
  // hydrateFromSnapshot
  // ---------------------------------------------------------------------

  it("hydrateFromSnapshot zastępuje stan danymi z serwera, gdy kolejka jest pusta", () => {
    useSubscriptionsStore.getState().hydrateFromSnapshot({
      subscriptions: [
        {
          id: "sub-remote",
          ownerId: "me",
          visibility: "household",
          name: "HBO Max",
          category: "Rozrywka",
          amountMinor: 2999,
          currency: "PLN",
          cycle: "monthly",
          nextPayment: "2026-08-15",
          payer: "Karta",
          status: "active",
          reminderDays: 2,
          color: "#5822b4",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      serverAt: "2026-01-05T00:00:00.000Z",
    });

    const state = useSubscriptionsStore.getState();
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].name).toBe("HBO Max");
    expect(state.serverAt).toBe("2026-01-05T00:00:00.000Z");
    expect(state.hydrated).toBe(true);
  });

  it("hydrateFromSnapshot nie nadpisuje stanu, gdy w kolejce są niewysłane mutacje", () => {
    useSubscriptionsStore.getState().addSubscription({
      ownerId: "me",
      visibility: "household",
      name: "Netflix",
      category: "Rozrywka",
      amountMinor: 4390,
      currency: "PLN",
      cycle: "monthly",
      nextPayment: "2026-08-01",
      payer: "Karta",
      status: "active",
      reminderDays: 3,
      color: "#397763",
    });
    expect(useSubscriptionsStore.getState().pendingMutations.length).toBeGreaterThan(0);

    useSubscriptionsStore.getState().hydrateFromSnapshot({
      subscriptions: [],
      serverAt: "2026-01-05T00:00:00.000Z",
    });

    // Local optimistic state (and hydrated flag) untouched -- pending queue must drain first.
    expect(useSubscriptionsStore.getState().subscriptions).toHaveLength(1);
    expect(useSubscriptionsStore.getState().hydrated).toBe(false);
  });

  it("hydrateFromSnapshot przy uszkodzonych danych ustawia hydrated:true bez rzucania wyjątku i zgłasza ostrzeżenie", () => {
    const warnings: string[] = [];
    const onWarning = (event: Event) => warnings.push((event as CustomEvent<string>).detail);
    window.addEventListener("puls:storage-warning", onWarning);
    try {
      useSubscriptionsStore.getState().hydrateFromSnapshot({
        subscriptions: [{ id: "broken" } as never],
        serverAt: "2026-01-05T00:00:00.000Z",
      });
      const state = useSubscriptionsStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.subscriptions).toHaveLength(0);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      window.removeEventListener("puls:storage-warning", onWarning);
    }
  });

  // ---------------------------------------------------------------------
  // persist.merge -- fresh-install guard (docs/plans/subskrypcje-sql.md, luka #3 ze "Status po
  // wdrożeniu" Finansów, wzór useHealthStore.ts/useCarStore.ts)
  // ---------------------------------------------------------------------

  it("merge nie pokazuje fałszywego ostrzeżenia o uszkodzonych danych na czystej instalacji (persistedState === undefined)", () => {
    const warnings: string[] = [];
    const onWarning = (event: Event) => warnings.push((event as CustomEvent<string>).detail);
    window.addEventListener("puls:storage-warning", onWarning);
    try {
      const merge = useSubscriptionsStore.persist.getOptions().merge!;
      const currentState = useSubscriptionsStore.getState();
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

  // ---------------------------------------------------------------------
  // resetSubscriptionsData
  // ---------------------------------------------------------------------

  it("resetSubscriptionsData czyści cały stan i kolejkę", () => {
    seedSubscription();
    useSubscriptionsStore.getState().updateSubscription("sub-1", { status: "paused" });
    useSubscriptionsStore.getState().resetSubscriptionsData();
    const state = useSubscriptionsStore.getState();
    expect(state.subscriptions).toHaveLength(0);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.hydrated).toBe(false);
    expect(state.serverAt).toBeNull();
  });
});
