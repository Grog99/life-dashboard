import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Banknote,
  CalendarDays,
  Check,
  CircleAlert,
  CreditCard,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Landmark,
  LockKeyhole,
  PiggyBank,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Target,
  Trash2,
  Upload,
  Users,
  Wallet,
  X,
} from "lucide-react";
import type {
  CurrencyCode,
  FinanceAccount,
  FinanceBudget,
  FinanceTransaction,
  SavingsGoal,
  Visibility,
} from "../advancedTypes";
import { Modal } from "../components/Modal";
import {
  decodeCsvBytes,
  mapCsvRows,
  previewCsv,
  type CsvEncoding,
  type CsvMapping,
  type CsvPreview,
} from "../lib/csvImport";
import { formatMoney, parseMoneyToMinor } from "../lib/money";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useServerAuth } from "../server/AuthGate";
import "../styles/finance.css";

interface FinancePageProps {
  onToast: (message: string) => void;
}

type TransactionDirection = "expense" | "income";
type TransactionFilter = "all" | TransactionDirection;

interface TransactionFormState {
  direction: TransactionDirection;
  accountId: string;
  bookedOn: string;
  amount: string;
  title: string;
  merchant: string;
  category: string;
  notes: string;
  visibility: Visibility;
}

interface AccountFormState {
  name: string;
  type: FinanceAccount["type"];
  balance: string;
  currency: CurrencyCode;
  visibility: Visibility;
  color: string;
}

interface BudgetFormState { category: string; limit: string; currency: CurrencyCode; color: string }
interface GoalFormState { name: string; target: string; saved: string; currency: CurrencyCode; deadline: string; visibility: Visibility }

const currencyOptions: CurrencyCode[] = ["PLN", "EUR", "USD", "GBP"];

const defaultCategories = [
  "Dom",
  "Jedzenie",
  "Przychody",
  "Restauracje",
  "Rozrywka",
  "Samochód",
  "Subskrypcje",
  "Transport",
  "Zdrowie",
  "Inne",
];

const accountTypeMeta: Record<
  FinanceAccount["type"],
  { label: string; icon: typeof Wallet }
> = {
  checking: { label: "Konto osobiste", icon: Landmark },
  savings: { label: "Oszczędności", icon: PiggyBank },
  cash: { label: "Gotówka", icon: Banknote },
  credit: { label: "Karta kredytowa", icon: CreditCard },
};

const sourceLabels: Record<FinanceTransaction["source"], string> = {
  manual: "Ręcznie",
  csv: "CSV",
  subscription: "Subskrypcja",
  trip: "Podróż",
  car: "Samochód",
};

const todayKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatDate = (date: string, compact = false) => {
  if (!date) return "Bez terminu";
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: compact ? "short" : "long",
    year: compact ? undefined : "numeric",
  }).format(parsed);
};

const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase("pl") + value.slice(1);

const normalizeCategoryName = (value: string) => value.trim().toLocaleLowerCase("pl");

const initialTransactionForm = (account?: FinanceAccount): TransactionFormState => ({
  direction: "expense",
  accountId: account?.id ?? "",
  bookedOn: todayKey(),
  amount: "",
  title: "",
  merchant: "",
  category: "Jedzenie",
  notes: "",
  visibility: account?.visibility ?? "private",
});

const initialAccountForm: AccountFormState = {
  name: "",
  type: "checking",
  balance: "",
  currency: "PLN",
  visibility: "private",
  color: "#397763",
};
const initialBudgetForm: BudgetFormState = { category: "Jedzenie", limit: "", currency: "PLN", color: "#4f8a6f" };
const initialGoalForm: GoalFormState = { name: "", target: "", saved: "", currency: "PLN", deadline: "", visibility: "private" };

export function FinancePage({ onToast }: FinancePageProps) {
  const { snapshot } = useServerAuth();
  const {
    financeAccounts,
    financeTransactions,
    financeBudgets,
    savingsGoals,
    householdMembers,
    hideAmounts,
    toggleHideAmounts,
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
  } = useAdvancedStore();

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
        return [
          transaction.title,
          transaction.merchant,
          transaction.category,
          accountName,
        ].some((value) => value.toLocaleLowerCase("pl").includes(normalizedSearch));
      })
      .sort((first, second) =>
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
      accountFilter !== "all" ? accountById.get(accountFilter) ?? defaultAccount : defaultAccount;
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
      amountMinor:
        transactionForm.direction === "expense" ? -unsignedAmount : unsignedAmount,
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
    setBudgetForm(budget ? { category: budget.category, limit: String(budget.limitMinor / 100), currency: budget.currency, color: budget.color } : { ...initialBudgetForm, currency: primaryCurrency });
    setBudgetModalOpen(true);
  };

  const saveBudget = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const limitMinor = Math.abs(parseMoneyToMinor(budgetForm.limit));
    if (!budgetForm.category.trim() || !limitMinor) { onToast("Podaj kategorię i miesięczny limit"); return; }
    const category = budgetForm.category.trim();
    const normalizedCategory = normalizeCategoryName(category);
    const isDuplicate = financeBudgets.some(
      (budget) =>
        budget.id !== editingBudget?.id &&
        normalizeCategoryName(budget.category) === normalizedCategory,
    );
    if (isDuplicate) { onToast("Budżet dla tej kategorii już istnieje"); return; }
    const data = { category, limitMinor, currency: budgetForm.currency, color: budgetForm.color };
    if (editingBudget) updateBudget(editingBudget.id, data); else addBudget(data);
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
    setGoalForm(goal ? { name: goal.name, target: String(goal.targetMinor / 100), saved: String(goal.savedMinor / 100), currency: goal.currency, deadline: goal.deadline ?? "", visibility: goal.visibility } : { ...initialGoalForm, currency: primaryCurrency });
    setGoalModalOpen(true);
  };

  const saveGoal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetMinor = Math.abs(parseMoneyToMinor(goalForm.target));
    const savedMinor = Math.abs(parseMoneyToMinor(goalForm.saved));
    if (!goalForm.name.trim() || !targetMinor) { onToast("Podaj nazwę i wartość celu"); return; }
    const data = { name: goalForm.name.trim(), targetMinor, savedMinor, currency: goalForm.currency, deadline: goalForm.deadline || undefined, ownerId: currentOwnerId, visibility: goalForm.visibility };
    if (editingGoal) updateSavingsGoal(editingGoal.id, data); else addSavingsGoal(data);
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

  const updateCsvMapping = <Key extends keyof CsvMapping>(
    key: Key,
    value: CsvMapping[Key],
  ) => {
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

  return (
    <div className="finance-page page-enter">
      <header className="page-header finance-page-header">
        <div>
          <span className="page-eyebrow">Finanse domowe</span>
          <h1>Spokojny obraz pieniędzy</h1>
          <p>
            Salda, wydatki i cele w jednym miejscu. Bez połączenia z bankiem i bez
            przechowywania danych logowania.
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

      <section className="finance-summary-grid" aria-label="Podsumowanie finansów">
        <article className="finance-summary-card finance-summary-card--balance">
          <div className="finance-summary-card__top">
            <span className="finance-summary-icon"><Wallet size={18} /></span>
            <span>{primaryCurrency}</span>
          </div>
          <span className="finance-summary-label">Łączne saldo</span>
          <strong>{formatMoney(totalBalance, primaryCurrency, hideAmounts)}</strong>
          <small>
            {activeAccounts.filter((account) => account.currency === primaryCurrency).length}{" "}
            {activeAccounts.length === 1 ? "aktywny rachunek" : "aktywne rachunki"}
          </small>
        </article>

        <article className="finance-summary-card">
          <div className="finance-summary-card__top">
            <span className="finance-summary-icon finance-summary-icon--expense">
              <ArrowUpRight size={18} />
            </span>
            <span>{monthLabel}</span>
          </div>
          <span className="finance-summary-label">Wydatki w tym miesiącu</span>
          <strong>{formatMoney(monthExpenses, primaryCurrency, hideAmounts)}</strong>
          <small className={monthFlow >= 0 ? "is-positive" : "is-negative"}>
            Bilans miesiąca: {formatMoney(monthFlow, primaryCurrency, hideAmounts)}
          </small>
        </article>

        <article className="finance-summary-card">
          <div className="finance-summary-card__top">
            <span className="finance-summary-icon finance-summary-icon--income">
              <ArrowDownLeft size={18} />
            </span>
            <span>{monthLabel}</span>
          </div>
          <span className="finance-summary-label">Wpływy w tym miesiącu</span>
          <strong>{formatMoney(monthIncome, primaryCurrency, hideAmounts)}</strong>
          <small>{primaryTransactions.filter((transaction) => transaction.amountMinor > 0).length} zaksięgowanych wpływów</small>
        </article>

        <article className="finance-summary-card">
          <div className="finance-summary-card__top">
            <span className="finance-summary-icon finance-summary-icon--budget">
              <Target size={18} />
            </span>
            <span>{primaryBudgets.length ? `${overBudgetCategories.length}/${primaryBudgets.length}` : "—"}</span>
          </div>
          <span className="finance-summary-label">Budżet kategorii</span>
          <strong>
            {formatMoney(
              overBudgetCategories.length ? budgetOverageTotal : budgetUnderTotal,
              primaryCurrency,
              hideAmounts,
            )}
          </strong>
          <small className={overBudgetCategories.length ? "is-negative" : ""}>
            {overBudgetCategories.length
              ? `przekroczono limit w ${overBudgetCategories.length} ${overBudgetCategories.length === 1 ? "kategorii" : "kategoriach"}`
              : "pozostało do wykorzystania"}
          </small>
        </article>
      </section>

      <section className="panel finance-accounts-panel">
        <header className="panel__header panel__header--compact finance-section-heading">
          <div>
            <span className="section-kicker"><Landmark size={14} /> Rachunki</span>
            <h2>Twoje pieniądze</h2>
          </div>
          <button
            className="text-button"
            type="button"
            onClick={() => setAccountModalOpen(true)}
          >
            <Plus size={15} /> Nowy rachunek
          </button>
        </header>
        {activeAccounts.length ? (
          <div className="finance-account-grid">
            {activeAccounts.map((account) => {
              const meta = accountTypeMeta[account.type];
              const AccountIcon = meta.icon;
              const member = memberById.get(account.ownerId);
              const accountTransactionCount = financeTransactions.filter(
                (transaction) => transaction.accountId === account.id,
              ).length;
              return (
                <button
                  className={`finance-account-card${accountFilter === account.id ? " is-selected" : ""}`}
                  type="button"
                  key={account.id}
                  onClick={() => {
                    setAccountFilter((current) => (current === account.id ? "all" : account.id));
                    setVisibleTransactions(8);
                  }}
                  aria-pressed={accountFilter === account.id}
                  style={{ "--account-color": account.color } as CSSProperties}
                >
                  <span className="finance-account-card__icon"><AccountIcon size={19} /></span>
                  <span className="finance-account-card__meta">
                    <small>{meta.label}</small>
                    <strong>{account.name}</strong>
                  </span>
                  <span className="finance-account-card__balance">
                    <strong>{formatMoney(account.balanceMinor, account.currency, hideAmounts)}</strong>
                    <small>
                      {account.visibility === "household" ? <Users size={12} /> : <LockKeyhole size={12} />}
                      {account.visibility === "household" ? "Wspólne" : member?.name ?? "Prywatne"}
                      <span aria-hidden="true">·</span> {accountTransactionCount} operacji
                    </small>
                  </span>
                  <ArrowRight className="finance-account-card__arrow" size={17} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="finance-inline-empty">
            <Wallet size={22} />
            <div><strong>Dodaj pierwszy rachunek</strong><span>Może to być konto, gotówka albo karta.</span></div>
            <button className="button button--soft button--small" type="button" onClick={() => setAccountModalOpen(true)}>Dodaj rachunek</button>
          </div>
        )}
      </section>

      <div className="finance-planning-grid">
        <section className="panel finance-budget-panel">
          <header className="panel__header panel__header--compact finance-section-heading">
            <div>
              <span className="section-kicker"><Target size={14} /> Plan miesiąca</span>
              <h2>Budżety</h2>
            </div>
            <button className="button button--soft button--small" type="button" onClick={() => openBudget()}><Plus size={14} /> Dodaj</button>
          </header>
          <div className="finance-budget-list">
            {financeBudgets.map((budget) => {
              const spent = Math.abs(
                financeTransactions
                  .filter(
                    (transaction) =>
                      transaction.bookedOn.startsWith(currentMonth) &&
                      transaction.currency === budget.currency &&
                      normalizeCategoryName(transaction.category) === normalizeCategoryName(budget.category) &&
                      transaction.amountMinor < 0,
                  )
                  .reduce((sum, transaction) => sum + transaction.amountMinor, 0),
              );
              const progress = budget.limitMinor > 0 ? (spent / budget.limitMinor) * 100 : 0;
              const remaining = budget.limitMinor - spent;
              return (
                <article
                  className={`finance-budget-row${progress > 100 ? " is-over" : ""}`}
                  key={budget.id}
                  style={{ "--budget-color": budget.color } as CSSProperties}
                >
                  <div className="finance-budget-row__heading">
                    <div><span className="finance-budget-dot" /><strong>{budget.category}</strong></div>
                    <span>{formatMoney(spent, budget.currency, hideAmounts)} <small>/ {formatMoney(budget.limitMinor, budget.currency, hideAmounts)}</small></span>
                  </div>
                  <div className="finance-progress-track" role="progressbar" aria-label={`Budżet ${budget.category}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(progress))}>
                    <span style={{ width: `${Math.min(100, progress)}%` }} />
                  </div>
                  <div className="finance-budget-row__footer">
                    <span>{Math.round(progress)}% wykorzystane</span>
                    <span className={remaining < 0 ? "is-negative" : ""}>
                      {remaining < 0 ? "Przekroczono o " : "Zostało "}
                      {formatMoney(Math.abs(remaining), budget.currency, hideAmounts)}
                    </span>
                    <span className="finance-row-actions"><button className="icon-button" type="button" onClick={() => openBudget(budget)} aria-label={`Edytuj budżet ${budget.category}`}><Pencil size={13} /></button><button className="icon-button module-danger-icon" type="button" onClick={() => removeBudget(budget)} aria-label={`Usuń budżet ${budget.category}`}><Trash2 size={13} /></button></span>
                  </div>
                </article>
              );
            })}
            {!financeBudgets.length && (
              <div className="finance-mini-empty"><Target size={19} /><span>Budżety pojawią się tutaj.</span></div>
            )}
          </div>
        </section>

        <section className="panel finance-goals-panel">
          <header className="panel__header panel__header--compact finance-section-heading">
            <div>
              <span className="section-kicker"><PiggyBank size={14} /> Odkładanie</span>
              <h2>Cele oszczędnościowe</h2>
            </div>
            <button className="button button--soft button--small" type="button" onClick={() => openGoal()}><Plus size={14} /> Dodaj</button>
          </header>
          <div className="finance-goal-list">
            {savingsGoals.map((goal, index) => {
              const progress = goal.targetMinor > 0 ? (goal.savedMinor / goal.targetMinor) * 100 : 0;
              const remaining = Math.max(0, goal.targetMinor - goal.savedMinor);
              return (
                <article className="finance-goal-row" key={goal.id}>
                  <div className={`finance-goal-icon finance-goal-icon--${(index % 3) + 1}`}>
                    {index % 2 === 0 ? <ShieldCheck size={19} /> : <PiggyBank size={19} />}
                  </div>
                  <div className="finance-goal-row__body">
                    <div className="finance-goal-row__heading">
                      <div><strong>{goal.name}</strong><span><CalendarDays size={12} /> {goal.deadline ? formatDate(goal.deadline, true) : "Bez terminu"}</span></div>
                      <strong>{Math.min(100, Math.round(progress))}%</strong>
                    </div>
                    <div className="finance-progress-track finance-progress-track--goal" role="progressbar" aria-label={`Cel ${goal.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(progress))}>
                      <span style={{ width: `${Math.min(100, progress)}%` }} />
                    </div>
                    <div className="finance-goal-row__footer">
                      <span>{formatMoney(goal.savedMinor, goal.currency, hideAmounts)} z {formatMoney(goal.targetMinor, goal.currency, hideAmounts)}</span>
                      <span>Brakuje {formatMoney(remaining, goal.currency, hideAmounts)}</span>
                      <span className="finance-row-actions"><button className="icon-button" type="button" onClick={() => openGoal(goal)} aria-label={`Edytuj cel ${goal.name}`}><Pencil size={13} /></button><button className="icon-button module-danger-icon" type="button" onClick={() => removeGoal(goal)} aria-label={`Usuń cel ${goal.name}`}><Trash2 size={13} /></button></span>
                    </div>
                  </div>
                </article>
              );
            })}
            {!savingsGoals.length && (
              <div className="finance-mini-empty"><PiggyBank size={19} /><span>Cele oszczędnościowe pojawią się tutaj.</span></div>
            )}
          </div>
        </section>
      </div>

      <section className="panel finance-transactions-panel" id="finance-transactions">
        <header className="finance-transactions-header">
          <div>
            <span className="section-kicker"><Banknote size={14} /> Historia</span>
            <h2>Transakcje</h2>
            <p>{filteredTransactions.length} pasujących operacji</p>
          </div>
          <div className="finance-transaction-filters">
            <label className="search-field finance-search-field">
              <Search size={16} />
              <span className="sr-only">Szukaj transakcji</span>
              <input value={search} onChange={(event) => { setSearch(event.target.value); setVisibleTransactions(8); }} placeholder="Szukaj transakcji…" />
              {search && <button type="button" onClick={() => setSearch("")} aria-label="Wyczyść wyszukiwanie"><X size={14} /></button>}
            </label>
            <label className="finance-filter-select">
              <span className="sr-only">Filtruj według rachunku</span>
              <select value={accountFilter} onChange={(event) => { setAccountFilter(event.target.value); setVisibleTransactions(8); }}>
                <option value="all">Wszystkie rachunki</option>
                {activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
            <label className="finance-filter-select finance-filter-select--short">
              <span className="sr-only">Filtruj według rodzaju</span>
              <select value={transactionFilter} onChange={(event) => { setTransactionFilter(event.target.value as TransactionFilter); setVisibleTransactions(8); }}>
                <option value="all">Wszystkie</option>
                <option value="expense">Wydatki</option>
                <option value="income">Wpływy</option>
              </select>
            </label>
          </div>
        </header>

        {filteredTransactions.length ? (
          <>
            <div className="finance-transactions-scroll">
              <table className="finance-transaction-table">
                <thead>
                  <tr>
                    <th>Transakcja</th>
                    <th>Kategoria</th>
                    <th>Rachunek</th>
                    <th>Data</th>
                    <th>Kwota</th>
                    <th><span className="sr-only">Działania</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTransactions.slice(0, visibleTransactions).map((transaction) => {
                    const account = accountById.get(transaction.accountId);
                    const owner = memberById.get(transaction.ownerId);
                    const incoming = transaction.amountMinor > 0;
                    return (
                      <tr key={transaction.id}>
                        <td>
                          <div className="finance-transaction-name">
                            <span className={incoming ? "is-income" : "is-expense"}>
                              {incoming ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                            </span>
                            <div>
                              <strong>{transaction.title}</strong>
                              <small>{transaction.merchant} <span aria-hidden="true">·</span> {sourceLabels[transaction.source]}</small>
                            </div>
                          </div>
                        </td>
                        <td><span className="finance-category-pill">{transaction.category}</span></td>
                        <td>
                          <div className="finance-table-account">
                            <span style={{ background: account?.color }} />
                            <div><strong>{account?.name ?? "Usunięty rachunek"}</strong><small>{owner?.name ?? "Domownik"}</small></div>
                          </div>
                        </td>
                        <td><span className="finance-date-cell">{formatDate(transaction.bookedOn, true)}</span></td>
                        <td><strong className={incoming ? "finance-amount is-positive" : "finance-amount"}>{formatMoney(transaction.amountMinor, transaction.currency, hideAmounts)}</strong></td>
                        <td>
                          <button className="icon-button finance-delete-transaction" type="button" onClick={() => removeTransaction(transaction)} aria-label={`Usuń transakcję ${transaction.title}`} title="Usuń transakcję"><Trash2 size={15} /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {visibleTransactions < filteredTransactions.length && (
              <div className="finance-load-more">
                <button className="button button--ghost-border button--small" type="button" onClick={() => setVisibleTransactions((count) => count + 8)}>
                  Pokaż więcej <ArrowDownLeft size={14} />
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="finance-transactions-empty">
            <Search size={22} />
            <strong>Nie znaleziono transakcji</strong>
            <span>Zmień filtry albo dodaj nową operację.</span>
            <button className="button button--soft button--small" type="button" onClick={openTransactionModal}><Plus size={15} /> Dodaj transakcję</button>
          </div>
        )}
      </section>

      <Modal
        open={transactionModalOpen}
        onClose={() => setTransactionModalOpen(false)}
        title="Nowa transakcja"
        eyebrow="Finanse"
        size="medium"
      >
        <form className="finance-form" onSubmit={handleAddTransaction}>
          <div className="finance-direction-switch" role="group" aria-label="Rodzaj transakcji">
            <button className={transactionForm.direction === "expense" ? "active" : ""} type="button" onClick={() => setTransactionForm((form) => ({ ...form, direction: "expense" }))}><ArrowUpRight size={16} /> Wydatek</button>
            <button className={transactionForm.direction === "income" ? "active" : ""} type="button" onClick={() => setTransactionForm((form) => ({ ...form, direction: "income" }))}><ArrowDownLeft size={16} /> Wpływ</button>
          </div>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Rachunek</span>
              <select required value={transactionForm.accountId} onChange={(event) => {
                const account = accountById.get(event.target.value);
                setTransactionForm((form) => ({ ...form, accountId: event.target.value, visibility: account?.visibility ?? form.visibility }));
              }}>
                <option value="" disabled>Wybierz rachunek</option>
                {activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Data księgowania</span>
              <input required type="date" value={transactionForm.bookedOn} onChange={(event) => setTransactionForm((form) => ({ ...form, bookedOn: event.target.value }))} />
            </label>
          </div>
          <label className="field field--prominent">
            <span>Kwota</span>
            <div className="finance-money-input">
              <input autoFocus required inputMode="decimal" placeholder="0,00" value={transactionForm.amount} onChange={(event) => setTransactionForm((form) => ({ ...form, amount: event.target.value }))} />
              <span>{accountById.get(transactionForm.accountId)?.currency ?? primaryCurrency}</span>
            </div>
          </label>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Nazwa transakcji</span>
              <input required maxLength={80} placeholder="np. Zakupy spożywcze" value={transactionForm.title} onChange={(event) => setTransactionForm((form) => ({ ...form, title: event.target.value }))} />
            </label>
            <label className="field">
              <span>Odbiorca / nadawca</span>
              <input maxLength={80} placeholder="np. Carrefour" value={transactionForm.merchant} onChange={(event) => setTransactionForm((form) => ({ ...form, merchant: event.target.value }))} />
            </label>
          </div>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Kategoria</span>
              <input list="finance-category-options" maxLength={50} value={transactionForm.category} onChange={(event) => setTransactionForm((form) => ({ ...form, category: event.target.value }))} />
              <datalist id="finance-category-options">
                {categories.map((category) => <option value={category} key={category} />)}
              </datalist>
            </label>
            <label className="field">
              <span>Widoczność</span>
              <select value={transactionForm.visibility} onChange={(event) => setTransactionForm((form) => ({ ...form, visibility: event.target.value as Visibility }))}>
                <option value="private">Tylko ja</option>
                <option value="household">Wszyscy domownicy</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Notatka <small>(opcjonalnie)</small></span>
            <textarea maxLength={240} placeholder="Dodatkowe informacje…" value={transactionForm.notes} onChange={(event) => setTransactionForm((form) => ({ ...form, notes: event.target.value }))} />
          </label>
          <div className="modal-actions">
            <span className="finance-form-hint"><ShieldCheck size={14} /> Dane zostają w Twoim dashboardzie</span>
            <div>
              <button className="button button--ghost" type="button" onClick={() => setTransactionModalOpen(false)}>Anuluj</button>
              <button className="button button--primary" type="submit">Dodaj transakcję</button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        open={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        title="Nowy rachunek"
        eyebrow="Finanse"
        size="small"
      >
        <form className="finance-form" onSubmit={handleAddAccount}>
          <label className="field field--prominent">
            <span>Nazwa rachunku</span>
            <input autoFocus required maxLength={50} placeholder="np. Konto codzienne" value={accountForm.name} onChange={(event) => setAccountForm((form) => ({ ...form, name: event.target.value }))} />
          </label>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Rodzaj</span>
              <select value={accountForm.type} onChange={(event) => setAccountForm((form) => ({ ...form, type: event.target.value as FinanceAccount["type"] }))}>
                {Object.entries(accountTypeMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Waluta</span>
              <select value={accountForm.currency} onChange={(event) => setAccountForm((form) => ({ ...form, currency: event.target.value as CurrencyCode }))}>
                {currencyOptions.map((currency) => <option key={currency}>{currency}</option>)}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Aktualne saldo</span>
            <div className="finance-money-input">
              <input inputMode="decimal" placeholder="0,00" value={accountForm.balance} onChange={(event) => setAccountForm((form) => ({ ...form, balance: event.target.value }))} />
              <span>{accountForm.currency}</span>
            </div>
          </label>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span>Widoczność</span>
              <select value={accountForm.visibility} onChange={(event) => setAccountForm((form) => ({ ...form, visibility: event.target.value as Visibility }))}>
                <option value="private">Tylko ja</option>
                <option value="household">Wszyscy domownicy</option>
              </select>
            </label>
            <label className="field finance-color-field">
              <span>Kolor rachunku</span>
              <div><input type="color" value={accountForm.color} onChange={(event) => setAccountForm((form) => ({ ...form, color: event.target.value }))} /><span>{accountForm.color.toUpperCase()}</span></div>
            </label>
          </div>
          <div className="modal-actions">
            <span />
            <div>
              <button className="button button--ghost" type="button" onClick={() => setAccountModalOpen(false)}>Anuluj</button>
              <button className="button button--primary" type="submit">Dodaj rachunek</button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal open={budgetModalOpen} onClose={() => setBudgetModalOpen(false)} title={editingBudget ? "Edytuj budżet" : "Nowy budżet"} eyebrow="Plan miesiąca" size="small">
        <form className="finance-form" onSubmit={saveBudget}>
          <label className="field field--prominent"><span>Kategoria</span><input autoFocus required list="finance-category-options" value={budgetForm.category} onChange={(event) => setBudgetForm({ ...budgetForm, category: event.target.value })} /></label>
          <div className="form-grid form-grid--2"><label className="field"><span>Miesięczny limit</span><div className="finance-money-input"><input required inputMode="decimal" value={budgetForm.limit} onChange={(event) => setBudgetForm({ ...budgetForm, limit: event.target.value })} placeholder="0,00" /><span>{budgetForm.currency}</span></div></label><label className="field"><span>Waluta</span><select value={budgetForm.currency} onChange={(event) => setBudgetForm({ ...budgetForm, currency: event.target.value as CurrencyCode })}>{currencyOptions.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div>
          <label className="field finance-color-field"><span>Kolor</span><div><input type="color" value={budgetForm.color} onChange={(event) => setBudgetForm({ ...budgetForm, color: event.target.value })} /><span>{budgetForm.color.toUpperCase()}</span></div></label>
          <div className="modal-actions"><span /><div><button className="button button--ghost" type="button" onClick={() => setBudgetModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">Zapisz budżet</button></div></div>
        </form>
      </Modal>

      <Modal open={goalModalOpen} onClose={() => setGoalModalOpen(false)} title={editingGoal ? "Edytuj cel" : "Nowy cel oszczędnościowy"} eyebrow="Odkładanie" size="small">
        <form className="finance-form" onSubmit={saveGoal}>
          <label className="field field--prominent"><span>Nazwa celu</span><input autoFocus required value={goalForm.name} onChange={(event) => setGoalForm({ ...goalForm, name: event.target.value })} placeholder="np. Poduszka bezpieczeństwa" /></label>
          <div className="form-grid form-grid--2"><label className="field"><span>Wartość celu</span><input required inputMode="decimal" value={goalForm.target} onChange={(event) => setGoalForm({ ...goalForm, target: event.target.value })} placeholder="0,00" /></label><label className="field"><span>Już odłożono</span><input inputMode="decimal" value={goalForm.saved} onChange={(event) => setGoalForm({ ...goalForm, saved: event.target.value })} placeholder="0,00" /></label></div>
          <div className="form-grid form-grid--2"><label className="field"><span>Waluta</span><select value={goalForm.currency} onChange={(event) => setGoalForm({ ...goalForm, currency: event.target.value as CurrencyCode })}>{currencyOptions.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label className="field"><span>Termin</span><input type="date" value={goalForm.deadline} onChange={(event) => setGoalForm({ ...goalForm, deadline: event.target.value })} /></label></div>
          <label className="field"><span>Widoczność</span><select value={goalForm.visibility} onChange={(event) => setGoalForm({ ...goalForm, visibility: event.target.value as Visibility })}><option value="private">Tylko ja</option><option value="household">Domownicy</option></select></label>
          <div className="modal-actions"><span /><div><button className="button button--ghost" type="button" onClick={() => setGoalModalOpen(false)}>Anuluj</button><button className="button button--primary" type="submit">Zapisz cel</button></div></div>
        </form>
      </Modal>

      <Modal
        open={importModalOpen}
        onClose={closeImportModal}
        title={csvPreview ? "Sprawdź import" : "Importuj wyciąg CSV"}
        eyebrow="Bezpieczny import"
        size="large"
      >
        {!csvPreview ? (
          <div className="finance-import-start">
            <label className="field">
              <span>Rachunek docelowy</span>
              <select value={importAccountId} onChange={(event) => setImportAccountId(event.target.value)}>
                <option value="" disabled>Wybierz rachunek</option>
                {activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}
              </select>
            </label>
            <label
              className={`finance-dropzone${csvReading ? " is-reading" : ""}${!importAccountId ? " is-disabled" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleCsvDrop}
            >
              <input ref={fileInputRef} type="file" accept=".csv,text/csv,text/plain" disabled={!importAccountId || csvReading} onChange={handleFileInput} />
              <span className="finance-dropzone__icon">{csvReading ? <FileSpreadsheet size={25} /> : <Upload size={25} />}</span>
              <strong>{csvReading ? "Odczytuję plik…" : "Upuść plik CSV tutaj"}</strong>
              <span>albo kliknij, aby wybrać plik z banku</span>
              <small>UTF-8 / Windows-1250 · maks. 5 MB · do 10 000 operacji</small>
            </label>
            {csvError && <div className="finance-import-error" role="alert"><CircleAlert size={17} /><span>{csvError}</span></div>}
            <div className="finance-import-assurances">
              <div><ShieldCheck size={17} /><span><strong>Bez logowania do banku</strong><small>Wybierasz wyłącznie pobrany wyciąg.</small></span></div>
              <div><Check size={17} /><span><strong>Podgląd przed zapisem</strong><small>Nic nie trafi do historii bez zatwierdzenia.</small></span></div>
              <div><FileSpreadsheet size={17} /><span><strong>Kontrola duplikatów</strong><small>Ponowny import nie dubluje operacji.</small></span></div>
            </div>
          </div>
        ) : csvMapping ? (
          <div className="finance-import-review">
            <div className="finance-import-filebar">
              <span className="finance-import-filebar__icon"><FileSpreadsheet size={19} /></span>
              <div><strong>{csvFileName}</strong><span>{csvPreview.rows.length} odczytanych wierszy · separator {csvPreview.delimiter === "\t" ? "tabulator" : `„${csvPreview.delimiter}”`} · kodowanie {csvEncoding ?? "UTF-8"}</span></div>
              <button className="button button--ghost button--small" type="button" onClick={resetCsvImport}>Zmień plik</button>
            </div>

            <div className="finance-import-mapping">
              <div className="finance-import-subheading">
                <div><strong>Mapowanie kolumn</strong><span>Sprawdź, czy pola zostały rozpoznane poprawnie.</span></div>
                <span className="finance-auto-badge"><Check size={12} /> Wykryto automatycznie</span>
              </div>
              <div className="finance-mapping-grid">
                <label className="field"><span>Data</span><select value={csvMapping.dateColumn} onChange={(event) => updateCsvMapping("dateColumn", event.target.value)}>{csvPreview.headers.map((header) => <option key={header}>{header}</option>)}</select></label>
                <label className="field"><span>Format daty</span><select value={csvMapping.dateFormat} onChange={(event) => updateCsvMapping("dateFormat", event.target.value as CsvMapping["dateFormat"])}><option value="yyyy-MM-dd">RRRR-MM-DD</option><option value="dd.MM.yyyy">DD.MM.RRRR</option><option value="dd-MM-yyyy">DD-MM-RRRR</option><option value="dd/MM/yyyy">DD/MM/RRRR</option></select></label>
                <label className="field"><span>Kwota</span><select value={csvMapping.amountColumn} onChange={(event) => updateCsvMapping("amountColumn", event.target.value)}>{csvPreview.headers.map((header) => <option key={header}>{header}</option>)}</select></label>
                <label className="field"><span>Tytuł</span><select value={csvMapping.titleColumn} onChange={(event) => updateCsvMapping("titleColumn", event.target.value)}>{csvPreview.headers.map((header) => <option key={header}>{header}</option>)}</select></label>
                <label className="field"><span>Kontrahent</span><select value={csvMapping.merchantColumn ?? ""} onChange={(event) => updateCsvMapping("merchantColumn", event.target.value || undefined)}><option value="">Użyj tytułu</option>{csvPreview.headers.map((header) => <option key={header}>{header}</option>)}</select></label>
                <label className="field"><span>Kategoria</span><select value={csvMapping.categoryColumn ?? ""} onChange={(event) => updateCsvMapping("categoryColumn", event.target.value || undefined)}><option value="">Do przypisania</option>{csvPreview.headers.map((header) => <option key={header}>{header}</option>)}</select></label>
              </div>
            </div>

            <div className="finance-import-stats" aria-label="Wynik walidacji importu">
              <div className="is-new"><span><Check size={15} /></span><strong>{csvNewCount}</strong><small>nowe</small></div>
              <div className="is-duplicate"><span><ShieldCheck size={15} /></span><strong>{csvDuplicateCount}</strong><small>duplikaty</small></div>
              <div className="is-invalid"><span><CircleAlert size={15} /></span><strong>{csvInvalidCount}</strong><small>pominięte</small></div>
              <div><span><Landmark size={15} /></span><strong>{selectedImportAccount?.name ?? "—"}</strong><small>rachunek docelowy</small></div>
            </div>

            {csvRowsWithStatus.length ? (
              <div className="finance-import-preview">
                <table>
                  <thead><tr><th>Status</th><th>Data</th><th>Transakcja</th><th>Kategoria</th><th>Kwota</th></tr></thead>
                  <tbody>
                    {csvRowsWithStatus.slice(0, 50).map(({ transaction, duplicate }, index) => (
                      <tr className={duplicate ? "is-duplicate" : ""} key={`${transaction.fingerprint}-${index}`}>
                        <td><span className={`finance-import-status${duplicate ? " is-duplicate" : ""}`}>{duplicate ? <ShieldCheck size={12} /> : <Check size={12} />}{duplicate ? "Duplikat" : "Nowa"}</span></td>
                        <td>{formatDate(transaction.bookedOn, true)}</td>
                        <td><strong>{transaction.title}</strong><small>{transaction.merchant}</small></td>
                        <td>{transaction.category}</td>
                        <td className={transaction.amountMinor > 0 ? "is-positive" : ""}>{formatMoney(transaction.amountMinor, transaction.currency, hideAmounts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {csvRowsWithStatus.length > 50 && (
                  <p className="finance-form-hint">Podgląd pokazuje pierwsze 50 z {csvRowsWithStatus.length} poprawnych operacji. Import obejmie wszystkie.</p>
                )}
              </div>
            ) : (
              <div className="finance-import-error"><CircleAlert size={17} /><span>Mapowanie nie daje żadnych poprawnych transakcji. Sprawdź datę i kwotę.</span></div>
            )}

            <div className="modal-actions finance-import-actions">
              <span className="finance-form-hint"><ShieldCheck size={14} /> Duplikaty zostaną automatycznie pominięte</span>
              <div>
                <button className="button button--ghost" type="button" onClick={closeImportModal}>Anuluj</button>
                <button className="button button--primary" type="button" disabled={!csvNewCount} onClick={handleImport}>Importuj {csvNewCount} {csvNewCount === 1 ? "transakcję" : "transakcji"}</button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
