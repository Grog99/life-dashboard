import { Plus, ReceiptText, Trash2 } from "lucide-react";
import type { PetExpense } from "../../../advancedTypes";
import { formatMoney } from "../../../lib/money";
import { formatShortDate } from "../../../lib/date";
import { expenseIcons, expenseLabels, type ExpenseFilter } from "../petConstants";

interface PetExpensesPanelProps {
  visibleExpenses: PetExpense[];
  expenseFilter: ExpenseFilter;
  onFilterChange: (filter: ExpenseFilter) => void;
  hideAmounts: boolean;
  onAddExpense: () => void;
  onRemoveExpense: (expense: PetExpense) => void;
}

export function PetExpensesPanel({
  visibleExpenses,
  expenseFilter,
  onFilterChange,
  hideAmounts,
  onAddExpense,
  onRemoveExpense,
}: PetExpensesPanelProps) {
  return (
    <section className="panel module-panel">
      <header className="module-panel__header">
        <div>
          <span className="section-kicker">
            <ReceiptText size={14} /> Historia
          </span>
          <h2>Wydatki</h2>
        </div>
        <div className="module-toolbar-actions">
          <div className="module-segmented">
            <button
              className={expenseFilter === "all" ? "active" : ""}
              type="button"
              onClick={() => onFilterChange("all")}
            >
              Wszystkie
            </button>
            <button
              className={expenseFilter === "food" ? "active" : ""}
              type="button"
              onClick={() => onFilterChange("food")}
            >
              Jedzenie
            </button>
            <button
              className={expenseFilter === "vet" ? "active" : ""}
              type="button"
              onClick={() => onFilterChange("vet")}
            >
              Weterynarz
            </button>
            <button
              className={expenseFilter === "accessories" ? "active" : ""}
              type="button"
              onClick={() => onFilterChange("accessories")}
            >
              Akcesoria
            </button>
            <button
              className={expenseFilter === "grooming" ? "active" : ""}
              type="button"
              onClick={() => onFilterChange("grooming")}
            >
              Pielęgnacja
            </button>
          </div>
          <button className="button button--soft button--small" type="button" onClick={onAddExpense}>
            <Plus size={15} /> Dodaj koszt
          </button>
        </div>
      </header>
      {visibleExpenses.length ? (
        <div className="car-expense-list">
          {visibleExpenses.map((expense) => {
            const ExpenseIcon = expenseIcons[expense.type];
            return (
              <article className="car-expense-row" key={expense.id}>
                <span className={`car-expense-icon car-expense-icon--${expense.type}`}>
                  <ExpenseIcon size={18} />
                </span>
                <div className="car-expense-row__main">
                  <strong>{expense.title}</strong>
                  <span>
                    {expenseLabels[expense.type]} · {formatShortDate(expense.date)}
                  </span>
                </div>
                <div className="car-expense-row__details" />
                <strong className="car-expense-row__amount">
                  {formatMoney(expense.amountMinor, "PLN", hideAmounts)}
                </strong>
                <button
                  className="icon-button module-danger-icon"
                  type="button"
                  onClick={() => onRemoveExpense(expense)}
                  aria-label={`Usuń wpis ${expense.title}`}
                >
                  <Trash2 size={15} />
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="module-empty">
          <ReceiptText size={24} />
          <strong>Brak wydatków w tym widoku</strong>
          <span>Dodaj jedzenie, wizytę u weterynarza albo inny koszt.</span>
        </div>
      )}
    </section>
  );
}
