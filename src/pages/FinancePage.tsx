import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { Eye, EyeOff, Plus, Upload } from "lucide-react";
import type { FinanceBudget, FinanceTransaction, SavingsGoal } from "../financeTypes";
import {
  decodeCsvBytes,
  mapCsvRows,
  previewCsv,
  type CsvEncoding,
  type CsvMapping,
  type CsvPreview,
} from "../lib/csvImport";
import { parseMoneyToMinor } from "../lib/money";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useFinanceStore } from "../store/useFinanceStore";
import { useServerAuth } from "../server/AuthGate";
import {
  capitalize,
  defaultCategories,
  initialAccountForm,
  initialBudgetForm,
  initialGoalForm,
  initialTransactionForm,
  normalizeCategoryName,
  todayKey,
  type AccountFormState,
  type BudgetFormState,
  type GoalFormState,
  type TransactionFilter,
  type TransactionFormState,
} from "./finance/financeConstants";
import { FinanceSummaryCards } from "./finance/components/FinanceSummaryCards";
import { FinanceAccountsPanel } from "./finance/components/FinanceAccountsPanel";
import { FinanceBudgetsPanel } from "./finance/components/FinanceBudgetsPanel";
import { FinanceGoalsPanel } from "./finance/components/FinanceGoalsPanel";
import { FinanceTransactionsPanel } from "./finance/components/FinanceTransactionsPanel";
import { TransactionFormModal } from "./finance/components/TransactionFormModal";
import { AccountFormModal } from "./finance/components/AccountFormModal";
import { BudgetFormModal } from "./finance/components/BudgetFormModal";
import { GoalFormModal } from "./finance/components/GoalFormModal";
import { CsvImportModal } from "./finance/components/CsvImportModal";
import "../styles/finance.css";

interface FinancePageProps {
  onToast: (message: string) => void;
}

export function FinancePage({ onToast }: FinancePageProps) {
  const { snapshot } = useServerAuth();
  const { householdMembers, hideAmounts, toggleHideAmounts } = useAdvancedStore();
  const {
    accounts: financeAccounts,
    transactions: financeTransactions,
    budgets: financeBudgets,
    goals: savingsGoals,
    addAccount,
    addTransaction,
    importTransactions,
    deleteTransaction,
    addBudget,
    updateBudget,
    deleteBudget,
    addSavingsGoal,
    updateSavingsGoal,
    deleteSavingsGoal,
  } = useFinanceStore();

  const activeAccounts = useMemo(
    () => financeAccounts.filter((account) => !account.archived),
    [financeAccounts],
  );
  const defaultAccount = activeAccounts[0];
  const currentOwnerId =
    snapshot?.user.id ??
    householdMembers.find((member) => member.id === "me")?.id ??
    householdMembers.find((member) => member.role === "owner")?.id ??
    householdMembers[0]?.id ??
    "me";
  const primaryCurrency =
    activeAccounts.find((account) => account.currency === "PLN")?.currency ??
    activeAccounts[0]?.currency ??
    "PLN";
  const currentMonth = todayKey().slice(0, 7);
  const monthLabel = capitalize(
    new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" }).format(new Date()),
  );

  const [transactionModalOpen, setTransactionModalOpen] = useState(false);
  const [transactionForm, setTransactionForm] = useState<TransactionFormState>(() =>
    initialTransactionForm(defaultAccount),
  );
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountForm, setAccountForm] = useState<AccountFormState>(initialAccountForm);
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<FinanceBudget | null>(null);
  const [budgetForm, setBudgetForm] = useState<BudgetFormState>(initialBudgetForm);
  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<SavingsGoal | null>(null);
  const [goalForm, setGoalForm] = useState<GoalFormState>(initialGoalForm);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [csvMapping, setCsvMapping] = useState<CsvMapping | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [csvEncoding, setCsvEncoding] = useState<CsvEncoding | null>(null);
  const [csvError, setCsvError] = useState("");
  const [csvReading, setCsvReading] = useState(false);
  const [importAccountId, setImportAccountId] = useState(defaultAccount?.id ?? "");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>("all");
  const [visibleTransactions, setVisibleTransactions] = useState(8);

  const primaryTransactions = useMemo(
    () =>
      financeTransactions.filter(
        (transaction) =>
          transaction.currency === primaryCurrency && transaction.bookedOn.startsWith(currentMonth),
      ),
    [currentMonth, financeTransactions, primaryCurrency],
  );
  const totalBalance = activeAccounts
    .filter((account) => account.currency === primaryCurrency)
    .reduce((sum, account) => sum + account.balanceMinor, 0);
  const monthIncome = primaryTransactions
    .filter((transaction) => transaction.amountMinor > 0)
    .reduce((sum, transaction) => sum + transaction.amountMinor, 0);
  const monthExpenses = Math.abs(
    primaryTransactions
      .filter((transaction) => transaction.amountMinor < 0)
      .reduce((sum, transaction) => sum + transaction.amountMinor, 0),
  );
  const monthFlow = monthIncome - monthExpenses;
  const primaryBudgets = financeBudgets.filter((budget) => budget.currency === primaryCurrency);
  const categorySpent = new Map<string, number>();
  primaryTransactions
    .filter((transaction) => transaction.amountMinor < 0)
    .forEach((transaction) => {
      const key = normalizeCategoryName(transaction.category);
      categorySpent.set(key, (categorySpent.get(key) ?? 0) + Math.abs(transaction.amountMinor));
    });
  const budgetProgress = primaryBudgets.map((budget) => {
    const spent = categorySpent.get(normalizeCategoryName(budget.category)) ?? 0;
    return { budget, spent, overage: spent - budget.limitMinor };
  });
  const overBudgetCategories = budgetProgress.filter((entry) => entry.overage > 0);
  const budgetOverageTotal = overBudgetCategories.reduce((sum, entry) => sum + entry.overage, 0);
  const budgetUnderTotal = budgetProgress.reduce(
    (sum, entry) => sum + Math.max(0, entry.budget.limitMinor - entry.spent),
    0,
  );

  const categories = useMemo(
    () =>
      Array.from(
        new Set([
          ...defaultCategories,
          ...financeBudgets.map((budget) => budget.category),
          ...financeTransactions.map((transaction) => transaction.category),
        ]),
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [financeBudgets, financeTransactions],
  );

  const accountById = useMemo(
    () => new Map(financeAccounts.map((account) => [account.id, account])),
    [financeAccounts],
  );
  const memberById = useMemo(
    () => new Map(householdMembers.map((member) => [member.id, member])),
    [householdMembers],
  );

  const filteredTransactions = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("pl");
    return [...financeTransactions]
      .filter((transaction) => accountFilter === "all" || transaction.accountId === accountFilter)
      .filter(
        (transaction) =>
          transactionFilter === "all" ||
          (transactionFilter === "income"
            ? transaction.amountMinor > 0
            : transaction.amountMinor < 0),
      )
      .filter((transaction) => {
        if (!normalizedSearch) return true;
        const accountName = accountById.get(transaction.accountId)?.name ?? "";
        return [transaction.title, transaction.merchant, transaction.category, accountName].some(
          (value) => value.toLocaleLowerCase("pl").includes(normalizedSearch),
        );
      })
      .sort(
        (first, second) =>
          second.bookedOn.localeCompare(first.bookedOn) || second.id.localeCompare(first.id),
      );
  }, [accountById, accountFilter, financeTransactions, search, transactionFilter]);

  const selectedImportAccount = accountById.get(importAccountId) ?? defaultAccount;
  const mappedCsvTransactions = useMemo(() => {
    if (!csvPreview || !csvMapping || !selectedImportAccount) return [];
    return mapCsvRows(csvPreview, csvMapping, {
      accountId: selectedImportAccount.id,
      currency: selectedImportAccount.currency,
      ownerId: currentOwnerId,
      visibility: selectedImportAccount.visibility,
    });
  }, [csvMapping, csvPreview, currentOwnerId, selectedImportAccount]);

  const csvRowsWithStatus = useMemo(() => {
    const seen = new Set(
      financeTransactions.map((transaction) => transaction.fingerprint).filter(Boolean),
    );
    return mappedCsvTransactions.map((transaction) => {
      const duplicate = Boolean(transaction.fingerprint && seen.has(transaction.fingerprint));
      if (transaction.fingerprint) seen.add(transaction.fingerprint);
      return { transaction, duplicate };
    });
  }, [financeTransactions, mappedCsvTransactions]);
  const csvDuplicateCount = csvRowsWithStatus.filter((row) => row.duplicate).length;
  const csvNewCount = csvRowsWithStatus.length - csvDuplicateCount;
  const csvInvalidCount = Math.max(
    0,
    (csvPreview?.rows.length ?? 0) - mappedCsvTransactions.length,
  );

  const openTransactionModal = () => {
    const preferredAccount =
      accountFilter !== "all" ? (accountById.get(accountFilter) ?? defaultAccount) : defaultAccount;
    setTransactionForm(initialTransactionForm(preferredAccount));
    setTransactionModalOpen(true);
  };

  const handleAddTransaction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const account = accountById.get(transactionForm.accountId);
    const unsignedAmount = Math.abs(parseMoneyToMinor(transactionForm.amount));
    if (!account || !transactionForm.title.trim() || unsignedAmount <= 0) {
      onToast("Uzupełnij rachunek, nazwę i poprawną kwotę");
      return;
    }
    addTransaction({
      accountId: account.id,
      bookedOn: transactionForm.bookedOn,
      amountMinor: transactionForm.direction === "expense" ? -unsignedAmount : unsignedAmount,
      currency: account.currency,
      merchant: transactionForm.merchant.trim() || transactionForm.title.trim(),
      title: transactionForm.title.trim(),
      category: transactionForm.category.trim() || "Inne",
      source: "manual",
      notes: transactionForm.notes.trim() || undefined,
      ownerId: currentOwnerId,
      visibility: transactionForm.visibility,
    });
    setTransactionModalOpen(false);
    setTransactionForm(initialTransactionForm(defaultAccount));
    onToast(
      transactionForm.direction === "expense" ? "Wydatek został dodany" : "Wpływ został dodany",
    );
  };

  const handleAddAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accountForm.name.trim()) {
      onToast("Podaj nazwę rachunku");
      return;
    }
    const id = addAccount({
      name: accountForm.name.trim(),
      type: accountForm.type,
      balanceMinor: parseMoneyToMinor(accountForm.balance),
      currency: accountForm.currency,
      color: accountForm.color,
      archived: false,
      ownerId: currentOwnerId,
      visibility: accountForm.visibility,
    });
    setAccountForm(initialAccountForm);
    setAccountModalOpen(false);
    setAccountFilter(id);
    onToast("Rachunek jest gotowy");
  };

  const openBudget = (budget?: FinanceBudget) => {
    setEditingBudget(budget ?? null);
    setBudgetForm(
      budget
        ? {
            category: budget.category,
            limit: String(budget.limitMinor / 100),
            currency: budget.currency,
            color: budget.color,
          }
        : { ...initialBudgetForm, currency: primaryCurrency },
    );
    setBudgetModalOpen(true);
  };

  const saveBudget = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const limitMinor = Math.abs(parseMoneyToMinor(budgetForm.limit));
    if (!budgetForm.category.trim() || !limitMinor) {
      onToast("Podaj kategorię i miesięczny limit");
      return;
    }
    const category = budgetForm.category.trim();
    const normalizedCategory = normalizeCategoryName(category);
    const isDuplicate = financeBudgets.some(
      (budget) =>
        budget.id !== editingBudget?.id &&
        normalizeCategoryName(budget.category) === normalizedCategory,
    );
    if (isDuplicate) {
      onToast("Budżet dla tej kategorii już istnieje");
      return;
    }
    const data = { category, limitMinor, currency: budgetForm.currency, color: budgetForm.color };
    if (editingBudget) updateBudget(editingBudget.id, data);
    else addBudget(data);
    setBudgetModalOpen(false);
    onToast(editingBudget ? "Budżet został zaktualizowany" : "Budżet został dodany");
  };

  const removeBudget = (budget: FinanceBudget) => {
    if (!window.confirm(`Usunąć budżet „${budget.category}”?`)) return;
    deleteBudget(budget.id);
    onToast("Budżet został usunięty");
  };

  const openGoal = (goal?: SavingsGoal) => {
    setEditingGoal(goal ?? null);
    setGoalForm(
      goal
        ? {
            name: goal.name,
            target: String(goal.targetMinor / 100),
            saved: String(goal.savedMinor / 100),
            currency: goal.currency,
            deadline: goal.deadline ?? "",
            visibility: goal.visibility,
          }
        : { ...initialGoalForm, currency: primaryCurrency },
    );
    setGoalModalOpen(true);
  };

  const saveGoal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetMinor = Math.abs(parseMoneyToMinor(goalForm.target));
    const savedMinor = Math.abs(parseMoneyToMinor(goalForm.saved));
    if (!goalForm.name.trim() || !targetMinor) {
      onToast("Podaj nazwę i wartość celu");
      return;
    }
    const data = {
      name: goalForm.name.trim(),
      targetMinor,
      savedMinor,
      currency: goalForm.currency,
      deadline: goalForm.deadline || undefined,
      ownerId: currentOwnerId,
      visibility: goalForm.visibility,
    };
    if (editingGoal) updateSavingsGoal(editingGoal.id, data);
    else addSavingsGoal(data);
    setGoalModalOpen(false);
    onToast(editingGoal ? "Cel został zaktualizowany" : "Cel oszczędnościowy został dodany");
  };

  const removeGoal = (goal: SavingsGoal) => {
    if (!window.confirm(`Usunąć cel „${goal.name}”?`)) return;
    deleteSavingsGoal(goal.id);
    onToast("Cel został usunięty");
  };

  const resetCsvImport = () => {
    setCsvPreview(null);
    setCsvMapping(null);
    setCsvFileName("");
    setCsvEncoding(null);
    setCsvError("");
    setCsvReading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const closeImportModal = () => {
    setImportModalOpen(false);
    resetCsvImport();
  };

  const handleCsvFile = async (file?: File) => {
    if (!file) return;
    if (!importAccountId) {
      setCsvError("Najpierw wybierz rachunek docelowy.");
      return;
    }
    setCsvError("");
    if (file.size > 5 * 1024 * 1024) {
      setCsvError("Plik jest za duży. Maksymalny rozmiar to 5 MB.");
      return;
    }
    setCsvReading(true);
    try {
      const { text, encoding } = decodeCsvBytes(await file.arrayBuffer());
      const parsed = previewCsv(text);
      setCsvPreview(parsed);
      setCsvMapping(parsed.suggestedMapping);
      setCsvFileName(file.name);
      setCsvEncoding(encoding);
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : "Nie udało się odczytać pliku CSV");
    } finally {
      setCsvReading(false);
    }
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    void handleCsvFile(event.target.files?.[0]);
  };

  const handleCsvDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (!importAccountId || csvReading) return;
    void handleCsvFile(event.dataTransfer.files?.[0]);
  };

  const updateCsvMapping = <Key extends keyof CsvMapping>(key: Key, value: CsvMapping[Key]) => {
    setCsvMapping((current) => (current ? { ...current, [key]: value } : current));
  };

  const handleImport = () => {
    if (!mappedCsvTransactions.length) {
      onToast("Nie ma poprawnych transakcji do importu");
      return;
    }
    const result = importTransactions(mappedCsvTransactions);
    closeImportModal();
    onToast(
      result.duplicates
        ? `Dodano ${result.added} transakcji · pominięto ${result.duplicates} duplikatów`
        : `Dodano ${result.added} transakcji z CSV`,
    );
  };

  const removeTransaction = (transaction: FinanceTransaction) => {
    if (!globalThis.confirm(`Usunąć transakcję „${transaction.title}”?`)) return;
    deleteTransaction(transaction.id);
    onToast("Transakcja została usunięta");
  };

  const selectAccountFilter = (accountId: string) => {
    setAccountFilter((current) => (current === accountId ? "all" : accountId));
    setVisibleTransactions(8);
  };

  return (
    <div className="finance-page page-enter">
      <header className="page-header finance-page-header">
        <div>
          <span className="page-eyebrow">Finanse domowe</span>
          <h1>Spokojny obraz pieniędzy</h1>
          <p>
            Salda, wydatki i cele w jednym miejscu. Bez połączenia z bankiem i bez przechowywania
            danych logowania.
          </p>
        </div>
        <div className="finance-header-actions">
          <button
            className="button button--ghost-border finance-privacy-button"
            type="button"
            onClick={toggleHideAmounts}
            aria-pressed={hideAmounts}
          >
            {hideAmounts ? <Eye size={16} /> : <EyeOff size={16} />}
            {hideAmounts ? "Pokaż kwoty" : "Ukryj kwoty"}
          </button>
          <button
            className="button button--ghost-border"
            type="button"
            onClick={() => {
              setImportAccountId(defaultAccount?.id ?? "");
              setImportModalOpen(true);
            }}
          >
            <Upload size={16} /> Import CSV
          </button>
          <button
            className="button button--primary"
            type="button"
            onClick={openTransactionModal}
            disabled={!activeAccounts.length}
          >
            <Plus size={17} /> Dodaj transakcję
          </button>
        </div>
      </header>

      <FinanceSummaryCards
        primaryCurrency={primaryCurrency}
        hideAmounts={hideAmounts}
        monthLabel={monthLabel}
        activeAccounts={activeAccounts}
        totalBalance={totalBalance}
        monthExpenses={monthExpenses}
        monthFlow={monthFlow}
        monthIncome={monthIncome}
        primaryTransactions={primaryTransactions}
        primaryBudgetsCount={primaryBudgets.length}
        overBudgetCount={overBudgetCategories.length}
        budgetOverageTotal={budgetOverageTotal}
        budgetUnderTotal={budgetUnderTotal}
      />

      <FinanceAccountsPanel
        activeAccounts={activeAccounts}
        accountFilter={accountFilter}
        financeTransactions={financeTransactions}
        memberById={memberById}
        hideAmounts={hideAmounts}
        onSelectAccount={selectAccountFilter}
        onAddAccount={() => setAccountModalOpen(true)}
      />

      <div className="finance-planning-grid">
        <FinanceBudgetsPanel
          financeBudgets={financeBudgets}
          financeTransactions={financeTransactions}
          currentMonth={currentMonth}
          hideAmounts={hideAmounts}
          onAdd={() => openBudget()}
          onEdit={openBudget}
          onRemove={removeBudget}
        />

        <FinanceGoalsPanel
          savingsGoals={savingsGoals}
          hideAmounts={hideAmounts}
          onAdd={() => openGoal()}
          onEdit={openGoal}
          onRemove={removeGoal}
        />
      </div>

      <FinanceTransactionsPanel
        filteredTransactions={filteredTransactions}
        visibleTransactions={visibleTransactions}
        setVisibleTransactions={setVisibleTransactions}
        search={search}
        setSearch={setSearch}
        accountFilter={accountFilter}
        setAccountFilter={setAccountFilter}
        transactionFilter={transactionFilter}
        setTransactionFilter={setTransactionFilter}
        activeAccounts={activeAccounts}
        accountById={accountById}
        memberById={memberById}
        hideAmounts={hideAmounts}
        onRemoveTransaction={removeTransaction}
        onAddTransaction={openTransactionModal}
      />

      <TransactionFormModal
        open={transactionModalOpen}
        onClose={() => setTransactionModalOpen(false)}
        form={transactionForm}
        setForm={setTransactionForm}
        onSubmit={handleAddTransaction}
        activeAccounts={activeAccounts}
        accountById={accountById}
        categories={categories}
        primaryCurrency={primaryCurrency}
      />

      <AccountFormModal
        open={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        form={accountForm}
        setForm={setAccountForm}
        onSubmit={handleAddAccount}
      />

      <BudgetFormModal
        open={budgetModalOpen}
        onClose={() => setBudgetModalOpen(false)}
        form={budgetForm}
        setForm={setBudgetForm}
        onSubmit={saveBudget}
        editingBudget={editingBudget}
      />

      <GoalFormModal
        open={goalModalOpen}
        onClose={() => setGoalModalOpen(false)}
        form={goalForm}
        setForm={setGoalForm}
        onSubmit={saveGoal}
        editingGoal={editingGoal}
      />

      <CsvImportModal
        open={importModalOpen}
        onClose={closeImportModal}
        csvPreview={csvPreview}
        csvMapping={csvMapping}
        csvFileName={csvFileName}
        csvEncoding={csvEncoding}
        csvError={csvError}
        csvReading={csvReading}
        importAccountId={importAccountId}
        setImportAccountId={setImportAccountId}
        activeAccounts={activeAccounts}
        fileInputRef={fileInputRef}
        onFileInput={handleFileInput}
        onDrop={handleCsvDrop}
        onResetCsvImport={resetCsvImport}
        onUpdateMapping={updateCsvMapping}
        csvRowsWithStatus={csvRowsWithStatus}
        csvNewCount={csvNewCount}
        csvDuplicateCount={csvDuplicateCount}
        csvInvalidCount={csvInvalidCount}
        selectedImportAccount={selectedImportAccount}
        hideAmounts={hideAmounts}
        onImport={handleImport}
      />
    </div>
  );
}
