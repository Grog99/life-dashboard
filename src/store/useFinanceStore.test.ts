import { beforeEach, describe, expect, it } from "vitest";
import { useFinanceStore, type FinanceMutationResult } from "./useFinanceStore";

const account = () => useFinanceStore.getState().accounts.find((item) => item.id === "account-1")!;

function seedAccount() {
  useFinanceStore.setState({
    accounts: [
      {
        id: "account-1",
        ownerId: "me",
        visibility: "private",
        name: "Konto testowe",
        type: "checking",
        balanceMinor: 10_000,
        currency: "PLN",
        color: "#397763",
        archived: false,
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
}

describe("useFinanceStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useFinanceStore.setState({
      accounts: [],
      transactions: [],
      budgets: [],
      goals: [],
      pendingMutations: [],
      serverAt: null,
      hydrated: false,
    });
  });

  it("dodaje konto optymistycznie i kolejkuje mutację account.create bez baseVersion", () => {
    const id = useFinanceStore.getState().addAccount({
      name: "Konto główne",
      type: "checking",
      balanceMinor: 50_000,
      currency: "PLN",
      color: "#397763",
      archived: false,
      ownerId: "me",
      visibility: "private",
    });

    const created = useFinanceStore.getState().accounts.find((item) => item.id === id);
    expect(created).toMatchObject({ name: "Konto główne", balanceMinor: 50_000, version: 1 });

    const mutation = useFinanceStore.getState().pendingMutations[0];
    expect(mutation.op).toBe("account.create");
    expect(mutation.baseVersion).toBeUndefined();
    expect(mutation.payload).toMatchObject({ id, name: "Konto główne" });
  });

  it("dodanie transakcji aktualizuje saldo konta o deltę kwoty", () => {
    seedAccount();
    const id = useFinanceStore.getState().addTransaction({
      accountId: "account-1",
      bookedOn: "2026-07-01",
      amountMinor: -2_500,
      currency: "PLN",
      merchant: "Sklep",
      title: "Zakupy",
      category: "Jedzenie",
      source: "manual",
      ownerId: "me",
      visibility: "private",
    });

    expect(account().balanceMinor).toBe(7_500);
    const transaction = useFinanceStore.getState().transactions.find((item) => item.id === id);
    expect(transaction).toMatchObject({ amountMinor: -2_500, version: 1 });
    const mutation = useFinanceStore
      .getState()
      .pendingMutations.find((item) => item.op === "transaction.create");
    expect(mutation?.payload).toMatchObject({ id, accountId: "account-1", amountMinor: -2_500 });
  });

  it("usunięcie zwykłej transakcji odwraca deltę salda, ale import/usunięcie CSV nie rusza salda", () => {
    seedAccount();
    const manualId = useFinanceStore.getState().addTransaction({
      accountId: "account-1",
      bookedOn: "2026-07-01",
      amountMinor: -1_000,
      currency: "PLN",
      merchant: "Sklep",
      title: "Zakupy",
      category: "Jedzenie",
      source: "manual",
      ownerId: "me",
      visibility: "private",
    });
    expect(account().balanceMinor).toBe(9_000);
    useFinanceStore.getState().deleteTransaction(manualId);
    expect(account().balanceMinor).toBe(10_000);

    const result = useFinanceStore.getState().importTransactions([
      {
        accountId: "account-1",
        bookedOn: "2026-06-01",
        amountMinor: -5_000,
        currency: "PLN",
        merchant: "Historia",
        title: "Wyciąg",
        category: "Inne",
        source: "csv",
        fingerprint: "csv-1",
        ownerId: "me",
        visibility: "private",
      },
    ]);
    expect(result.added).toBe(1);
    expect(account().balanceMinor).toBe(10_000);
    const imported = useFinanceStore
      .getState()
      .transactions.find((item) => item.fingerprint === "csv-1")!;
    useFinanceStore.getState().deleteTransaction(imported.id);
    expect(account().balanceMinor).toBe(10_000);
  });

  it("importTransactions odfiltrowuje lokalne duplikaty po fingerprincie i nie wysyła pustej mutacji", () => {
    seedAccount();
    useFinanceStore.getState().importTransactions([
      {
        accountId: "account-1",
        bookedOn: "2026-06-01",
        amountMinor: -100,
        currency: "PLN",
        merchant: "A",
        title: "A",
        category: "Inne",
        source: "csv",
        fingerprint: "dup-1",
        ownerId: "me",
        visibility: "private",
      },
    ]);
    const before = useFinanceStore.getState().pendingMutations.length;
    const result = useFinanceStore.getState().importTransactions([
      {
        accountId: "account-1",
        bookedOn: "2026-06-01",
        amountMinor: -100,
        currency: "PLN",
        merchant: "A",
        title: "A",
        category: "Inne",
        source: "csv",
        fingerprint: "dup-1",
        ownerId: "me",
        visibility: "private",
      },
    ]);
    expect(result).toEqual({ added: 0, duplicates: 1 });
    expect(useFinanceStore.getState().pendingMutations.length).toBe(before);
  });

  it("updateBudget wysyła tylko dozwolone pola zmian z baseVersion bieżącego rekordu", () => {
    useFinanceStore.setState({
      budgets: [
        {
          id: "budget-1",
          category: "Jedzenie",
          limitMinor: 100_000,
          currency: "PLN",
          color: "#4f8a6f",
          version: 3,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    useFinanceStore.getState().updateBudget("budget-1", { limitMinor: 150_000 });
    expect(useFinanceStore.getState().budgets[0].limitMinor).toBe(150_000);
    const mutation = useFinanceStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "budget.update",
      baseVersion: 3,
      payload: { id: "budget-1", changes: { limitMinor: 150_000 } },
    });
  });

  it("updateSavingsGoal wysyła visibility (edytowalne), ale filtruje ownerId (nieedytowalne po utworzeniu)", () => {
    useFinanceStore.setState({
      goals: [
        {
          id: "goal-1",
          ownerId: "me",
          visibility: "private",
          name: "Poduszka",
          targetMinor: 500_000,
          savedMinor: 100_000,
          currency: "PLN",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    useFinanceStore.getState().updateSavingsGoal("goal-1", {
      savedMinor: 150_000,
      ownerId: "someone-else",
      visibility: "household",
    });
    // Lokalny (optymistyczny) stan odzwierciedla dokładnie to, co przekazano — bez redesignu UI.
    expect(useFinanceStore.getState().goals[0]).toMatchObject({
      savedMinor: 150_000,
      visibility: "household",
    });
    // Ładunek wysyłany na serwer zawiera visibility (FinancePage.tsx pozwala je zmienić w edycji
    // celu i backend to wspiera — patrz GOAL_UPDATE_KEYS w finance.mjs), ale NIE ownerId (właściciel
    // ustalony z sesji przy tworzeniu, nie zmienia się przy edycji).
    const mutation = useFinanceStore.getState().pendingMutations[0];
    expect(mutation.payload.changes).toEqual({ savedMinor: 150_000, visibility: "household" });
  });

  it("applyMutationResults zdejmuje z kolejki mutacje ze statusem applied/duplicate i adoptuje autorytatywny rekord", () => {
    const id = useFinanceStore.getState().addBudget({
      category: "Dom",
      limitMinor: 200_000,
      currency: "PLN",
      color: "#647ba0",
    });
    const mutation = useFinanceStore.getState().pendingMutations[0];
    const results: FinanceMutationResult[] = [
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          id,
          category: "Dom",
          limitMinor: 200_000,
          currency: "PLN",
          color: "#647ba0",
          version: 1,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ];
    useFinanceStore.getState().applyMutationResults(results);
    expect(useFinanceStore.getState().pendingMutations).toHaveLength(0);
    expect(useFinanceStore.getState().budgets[0]).toMatchObject({
      version: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("applyMutationResults zdejmuje z kolejki trwałe błędy (error) bez ponawiania", () => {
    useFinanceStore.getState().addBudget({
      category: "Dom",
      limitMinor: 200_000,
      currency: "PLN",
      color: "#647ba0",
    });
    const mutation = useFinanceStore.getState().pendingMutations[0];
    useFinanceStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "error",
        error: "Zły ładunek",
        code: "BUDGET_CATEGORY_DUPLICATE",
      },
    ]);
    expect(useFinanceStore.getState().pendingMutations).toHaveLength(0);
  });

  it("applyMutationResults na conflict robi cichy rebase: nowy idempotencyKey, świeży baseVersion, reaplikowana delta", () => {
    useFinanceStore.setState({
      budgets: [
        {
          id: "budget-1",
          category: "Jedzenie",
          limitMinor: 100_000,
          currency: "PLN",
          color: "#4f8a6f",
          version: 3,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    useFinanceStore.getState().updateBudget("budget-1", { limitMinor: 150_000 });
    const originalMutation = useFinanceStore.getState().pendingMutations[0];
    expect(originalMutation.baseVersion).toBe(3);

    // Serwer odrzucił z powodu równoległej edycji koloru przez inne urządzenie: aktualna wersja
    // to 4, a jej kolor już się zmienił.
    useFinanceStore.getState().applyMutationResults([
      {
        idempotencyKey: originalMutation.idempotencyKey,
        status: "conflict",
        currentVersion: 4,
        record: {
          id: "budget-1",
          category: "Jedzenie",
          limitMinor: 100_000,
          currency: "PLN",
          color: "#ff0000",
          version: 4,
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    ]);

    // Lokalny rekord: kolor świeży z serwera, ale nasza delta (limitMinor) nadal zaaplikowana.
    expect(useFinanceStore.getState().budgets[0]).toMatchObject({
      color: "#ff0000",
      limitMinor: 150_000,
      version: 4,
    });

    // Kolejka ma DOKŁADNIE jedną mutację: tę samą operację/deltę, ale z NOWYM kluczem
    // idempotencji (stary klucz ma już trwale zapisany wynik "conflict" w finance_mutations) i
    // nowym baseVersion = 4.
    const rebased = useFinanceStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].idempotencyKey).not.toBe(originalMutation.idempotencyKey);
    expect(rebased[0].baseVersion).toBe(4);
    expect(rebased[0].payload).toEqual({ id: "budget-1", changes: { limitMinor: 150_000 } });
  });

  it("applyMutationResults na transaction.import usuwa lokalnie wiersze, których serwer nie przyjął (dedup server-side)", () => {
    seedAccount();
    useFinanceStore.getState().importTransactions([
      {
        accountId: "account-1",
        bookedOn: "2026-06-01",
        amountMinor: -100,
        currency: "PLN",
        merchant: "A",
        title: "A",
        category: "Inne",
        source: "csv",
        fingerprint: "row-a",
        ownerId: "me",
        visibility: "private",
      },
      {
        accountId: "account-1",
        bookedOn: "2026-06-02",
        amountMinor: -200,
        currency: "PLN",
        merchant: "B",
        title: "B",
        category: "Inne",
        source: "csv",
        fingerprint: "row-b",
        ownerId: "me",
        visibility: "private",
      },
    ]);
    const mutation = useFinanceStore.getState().pendingMutations[0];
    const sentIds = (
      mutation.payload.transactions as Array<{ id: string; fingerprint?: string }>
    ).map((item) => item.id);
    const rowA = useFinanceStore
      .getState()
      .transactions.find((item) => item.fingerprint === "row-a")!;

    useFinanceStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: {
          transactions: [{ ...rowA, version: 1 }],
          addedCount: 1,
          duplicateCount: 1,
        },
      },
    ]);

    const remaining = useFinanceStore.getState().transactions;
    expect(remaining.some((item) => item.fingerprint === "row-a")).toBe(true);
    expect(remaining.some((item) => item.fingerprint === "row-b")).toBe(false);
    expect(sentIds).toHaveLength(2);
    expect(useFinanceStore.getState().pendingMutations).toHaveLength(0);
  });

  it("merge nie pokazuje fałszywego ostrzeżenia o uszkodzonych danych na czystej instalacji (persistedState === undefined)", () => {
    // zustand wywołuje `merge` bezwarunkowo przy hydratacji, nawet gdy w localStorage nigdy nie
    // było tego klucza (patrz node_modules/zustand/esm/middleware.mjs `hydrate`) -- w takim razie
    // `persistedState` to `undefined`, a to jest zwykły pierwszy start aplikacji, NIE uszkodzone
    // dane, więc nie może pokazywać ostrzeżenia "niezgodny format".
    const warnings: string[] = [];
    const onWarning = (event: Event) => warnings.push((event as CustomEvent<string>).detail);
    window.addEventListener("puls:storage-warning", onWarning);
    try {
      const merge = useFinanceStore.persist.getOptions().merge!;
      const currentState = useFinanceStore.getState();
      const merged = merge(undefined, currentState);
      expect(merged).toBe(currentState);
      expect(warnings).toHaveLength(0);

      // Ale gdy klucz W LOCALSTORAGE ISTNIEJE i ma zły kształt (np. string zamiast obiektu), to
      // faktycznie jest uszkodzenie i ostrzeżenie MA się pojawić.
      merge("not-an-object", currentState);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("niezgodny format");
    } finally {
      window.removeEventListener("puls:storage-warning", onWarning);
    }
  });

  it("resetFinanceData czyści cały stan i kolejkę", () => {
    seedAccount();
    useFinanceStore.getState().addBudget({
      category: "Dom",
      limitMinor: 1,
      currency: "PLN",
      color: "#000000",
    });
    useFinanceStore.getState().resetFinanceData();
    const state = useFinanceStore.getState();
    expect(state.accounts).toHaveLength(0);
    expect(state.budgets).toHaveLength(0);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.hydrated).toBe(false);
  });
});
