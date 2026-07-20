import { type CSSProperties } from "react";
import { Pencil, Plus, Target, Trash2 } from "lucide-react";
import type { FinanceBudget, FinanceTransaction } from "../../../financeTypes";
import { formatMoney } from "../../../lib/money";
import { normalizeCategoryName } from "../financeConstants";

interface FinanceBudgetsPanelProps {
  financeBudgets: FinanceBudget[];
  financeTransactions: FinanceTransaction[];
  currentMonth: string;
  hideAmounts: boolean;
  onAdd: () => void;
  onEdit: (budget: FinanceBudget) => void;
  onRemove: (budget: FinanceBudget) => void;
}

export function FinanceBudgetsPanel({
  financeBudgets,
  financeTransactions,
  currentMonth,
  hideAmounts,
  onAdd,
  onEdit,
  onRemove,
}: FinanceBudgetsPanelProps) {
  return (
    <section className="panel finance-budget-panel">
      <header className="panel__header panel__header--compact finance-section-heading">
        <div>
          <span className="section-kicker">
            <Target size={14} /> Plan miesiąca
          </span>
          <h2>Budżety</h2>
        </div>
        <button className="button button--soft button--small" type="button" onClick={onAdd}>
          <Plus size={14} /> Dodaj
        </button>
      </header>
      <div className="finance-budget-list">
        {financeBudgets.map((budget) => {
          const spent = Math.abs(
            financeTransactions
              .filter(
                (transaction) =>
                  transaction.bookedOn.startsWith(currentMonth) &&
                  transaction.currency === budget.currency &&
                  normalizeCategoryName(transaction.category) ===
                    normalizeCategoryName(budget.category) &&
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
                <div>
                  <span className="finance-budget-dot" />
                  <strong>{budget.category}</strong>
                </div>
                <span>
                  {formatMoney(spent, budget.currency, hideAmounts)}{" "}
                  <small>/ {formatMoney(budget.limitMinor, budget.currency, hideAmounts)}</small>
                </span>
              </div>
              <div
                className="finance-progress-track"
                role="progressbar"
                aria-label={`Budżet ${budget.category}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.round(progress))}
              >
                <span style={{ width: `${Math.min(100, progress)}%` }} />
              </div>
              <div className="finance-budget-row__footer">
                <span>{Math.round(progress)}% wykorzystane</span>
                <span className={remaining < 0 ? "is-negative" : ""}>
                  {remaining < 0 ? "Przekroczono o " : "Zostało "}
                  {formatMoney(Math.abs(remaining), budget.currency, hideAmounts)}
                </span>
                <span className="finance-row-actions">
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => onEdit(budget)}
                    aria-label={`Edytuj budżet ${budget.category}`}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button module-danger-icon"
                    type="button"
                    onClick={() => onRemove(budget)}
                    aria-label={`Usuń budżet ${budget.category}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            </article>
          );
        })}
        {!financeBudgets.length && (
          <div className="finance-mini-empty">
            <Target size={19} />
            <span>Budżety pojawią się tutaj.</span>
          </div>
        )}
      </div>
    </section>
  );
}
