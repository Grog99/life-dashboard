import { Banknote, Eye, EyeOff, WalletCards } from "lucide-react";
import type { CurrencyCode } from "../../../advancedTypes";
import { formatMoney } from "../../../lib/money";

interface TripBudgetViewProps {
  plannedTotal: number;
  hasBudget: boolean;
  budgetMinor?: number;
  currency: CurrencyCode;
  hideAmounts: boolean;
  budgetProgress: number;
  paidTotal: number;
  isOverBudget: boolean;
  remainingBudget: number;
  budgetBreakdown: Array<[string, number]>;
  onToggleHideAmounts: () => void;
}

export function TripBudgetView({
  plannedTotal,
  hasBudget,
  budgetMinor,
  currency,
  hideAmounts,
  budgetProgress,
  paidTotal,
  isOverBudget,
  remainingBudget,
  budgetBreakdown,
  onToggleHideAmounts,
}: TripBudgetViewProps) {
  return (
    <div className="trips-budget-grid">
      <section className="panel trips-budget-card">
        <header>
          <div>
            <span className="section-kicker">
              <WalletCards size={14} /> Kontrola kosztów
            </span>
            <h2>Budżet wyjazdu</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onToggleHideAmounts}
            aria-label={hideAmounts ? "Pokaż kwoty" : "Ukryj kwoty"}
          >
            {hideAmounts ? <Eye size={18} /> : <EyeOff size={18} />}
          </button>
        </header>
        <div className="trips-budget-card__total">
          <span>Zaplanowano</span>
          <strong>{formatMoney(plannedTotal, currency, hideAmounts)}</strong>
          <small>
            {hasBudget
              ? `z ${formatMoney(budgetMinor ?? 0, currency, hideAmounts)}`
              : "bez ustalonego budżetu"}
          </small>
        </div>
        <div className="trips-budget-meter">
          <span style={{ width: `${budgetProgress}%` }} />
          <i style={{ left: `${Math.min(100, budgetProgress)}%` }} />
        </div>
        <div className="trips-budget-card__stats">
          <div>
            <span>Opłacono</span>
            <strong>{formatMoney(paidTotal, currency, hideAmounts)}</strong>
          </div>
          {hasBudget && (
            <div className={isOverBudget ? "is-over" : ""}>
              <span>{isOverBudget ? "Ponad budżet" : "Zostało"}</span>
              <strong>{formatMoney(Math.abs(remainingBudget), currency, hideAmounts)}</strong>
            </div>
          )}
        </div>
      </section>

      <section className="panel trips-budget-breakdown">
        <header className="panel__header panel__header--compact">
          <div>
            <span className="section-kicker">
              <Banknote size={14} /> Kategorie
            </span>
            <h2>Struktura kosztów</h2>
          </div>
        </header>
        <div>
          {budgetBreakdown.map(([label, value], index) => (
            <article key={label}>
              <span className={`trips-budget-dot trips-budget-dot--${index % 5}`} />
              <div>
                <strong>{label}</strong>
                <span>
                  <i
                    style={{
                      width: `${plannedTotal ? Math.max(4, (value / plannedTotal) * 100) : 0}%`,
                    }}
                  />
                </span>
              </div>
              <strong>{formatMoney(value, currency, hideAmounts)}</strong>
            </article>
          ))}
          {!budgetBreakdown.length && (
            <div className="trips-budget-empty">Koszty pojawią się tutaj po dodaniu ich do planu.</div>
          )}
        </div>
      </section>
    </div>
  );
}
