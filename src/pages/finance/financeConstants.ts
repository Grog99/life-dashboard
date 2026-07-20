import { Banknote, CreditCard, Landmark, PiggyBank, Wallet } from "lucide-react";
import type {
  CurrencyCode,
  FinanceAccount,
  FinanceTransaction,
  Visibility,
} from "../../financeTypes";

export type TransactionDirection = "expense" | "income";
export type TransactionFilter = "all" | TransactionDirection;

export interface TransactionFormState {
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

export interface AccountFormState {
  name: string;
  type: FinanceAccount["type"];
  balance: string;
  currency: CurrencyCode;
  visibility: Visibility;
  color: string;
}

export interface BudgetFormState {
  category: string;
  limit: string;
  currency: CurrencyCode;
  color: string;
}
export interface GoalFormState {
  name: string;
  target: string;
  saved: string;
  currency: CurrencyCode;
  deadline: string;
  visibility: Visibility;
}

export const currencyOptions: CurrencyCode[] = ["PLN", "EUR", "USD", "GBP"];

export const defaultCategories = [
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

export const accountTypeMeta: Record<
  FinanceAccount["type"],
  { label: string; icon: typeof Wallet }
> = {
  checking: { label: "Konto osobiste", icon: Landmark },
  savings: { label: "Oszczędności", icon: PiggyBank },
  cash: { label: "Gotówka", icon: Banknote },
  credit: { label: "Karta kredytowa", icon: CreditCard },
};

export const sourceLabels: Record<FinanceTransaction["source"], string> = {
  manual: "Ręcznie",
  csv: "CSV",
  subscription: "Subskrypcja",
  trip: "Podróż",
  car: "Samochód",
};

export const todayKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const formatDate = (date: string, compact = false) => {
  if (!date) return "Bez terminu";
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: compact ? "short" : "long",
    year: compact ? undefined : "numeric",
  }).format(parsed);
};

export const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase("pl") + value.slice(1);

export const normalizeCategoryName = (value: string) => value.trim().toLocaleLowerCase("pl");

export const initialTransactionForm = (account?: FinanceAccount): TransactionFormState => ({
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

export const initialAccountForm: AccountFormState = {
  name: "",
  type: "checking",
  balance: "",
  currency: "PLN",
  visibility: "private",
  color: "#397763",
};
export const initialBudgetForm: BudgetFormState = {
  category: "Jedzenie",
  limit: "",
  currency: "PLN",
  color: "#4f8a6f",
};
export const initialGoalForm: GoalFormState = {
  name: "",
  target: "",
  saved: "",
  currency: "PLN",
  deadline: "",
  visibility: "private",
};
