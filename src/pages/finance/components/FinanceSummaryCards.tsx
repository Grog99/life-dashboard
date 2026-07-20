import { ArrowDownLeft, ArrowUpRight, Target, Wallet } from "lucide-react";
import type { CurrencyCode, FinanceAccount, FinanceTransaction } from "../../../financeTypes";
import { formatMoney } from "../../../lib/money";

interface FinanceSummaryCardsProps {
  primaryCurrency: CurrencyCode;
  hideAmounts: boolean;
  monthLabel: string;
  activeAccounts: FinanceAccount[];
  totalBalance: number;
  monthExpenses: number;
  monthFlow: number;
  monthIncome: number;
  primaryTransactions: FinanceTransaction[];
  primaryBudgetsCount: number;
  overBudgetCount: number;
  budgetOverageTotal: number;
  budgetUnderTotal: number;
}

export function FinanceSummaryCards({
  primaryCurrency,
  hideAmounts,
  monthLabel,
  activeAccounts,
  totalBalance,
  monthExpenses,
  monthFlow,
  monthIncome,
  primaryTransactions,
  primaryBudgetsCount,
  overBudgetCount,
  budgetOverageTotal,
  budgetUnderTotal,
}: FinanceSummaryCardsProps) {
  return (
    <section className="finance-summary-grid" aria-label="Podsumowanie finansów">
      <article className="finance-summary-card finance-summary-card--balance">
        <div className="finance-summary-card__top">
          <span className="finance-summary-icon">
            <Wallet size={18} />
          </span>
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
        <small>
          {primaryTransactions.filter((transaction) => transaction.amountMinor > 0).length}{" "}
          zaksięgowanych wpływów
        </small>
      </article>

      <article className="finance-summary-card">
        <div className="finance-summary-card__top">
          <span className="finance-summary-icon finance-summary-icon--budget">
            <Target size={18} />
          </span>
          <span>{primaryBudgetsCount ? `${overBudgetCount}/${primaryBudgetsCount}` : "—"}</span>
        </div>
        <span className="finance-summary-label">Budżet kategorii</span>
        <strong>
          {formatMoney(
            overBudgetCount ? budgetOverageTotal : budgetUnderTotal,
            primaryCurrency,
            hideAmounts,
          )}
        </strong>
        <small className={overBudgetCount ? "is-negative" : ""}>
          {overBudgetCount
            ? `przekroczono limit w ${overBudgetCount} ${overBudgetCount === 1 ? "kategorii" : "kategoriach"}`
            : "pozostało do wykorzystania"}
        </small>
      </article>
    </section>
  );
}
