import { CalendarDays, Pencil, PiggyBank, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { SavingsGoal } from "../../../financeTypes";
import { formatMoney } from "../../../lib/money";
import { formatDate } from "../financeConstants";

interface FinanceGoalsPanelProps {
  savingsGoals: SavingsGoal[];
  hideAmounts: boolean;
  onAdd: () => void;
  onEdit: (goal: SavingsGoal) => void;
  onRemove: (goal: SavingsGoal) => void;
}

export function FinanceGoalsPanel({
  savingsGoals,
  hideAmounts,
  onAdd,
  onEdit,
  onRemove,
}: FinanceGoalsPanelProps) {
  return (
    <section className="panel finance-goals-panel">
      <header className="panel__header panel__header--compact finance-section-heading">
        <div>
          <span className="section-kicker">
            <PiggyBank size={14} /> Odkładanie
          </span>
          <h2>Cele oszczędnościowe</h2>
        </div>
        <button className="button button--soft button--small" type="button" onClick={onAdd}>
          <Plus size={14} /> Dodaj
        </button>
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
                  <div>
                    <strong>{goal.name}</strong>
                    <span>
                      <CalendarDays size={12} />{" "}
                      {goal.deadline ? formatDate(goal.deadline, true) : "Bez terminu"}
                    </span>
                  </div>
                  <strong>{Math.min(100, Math.round(progress))}%</strong>
                </div>
                <div
                  className="finance-progress-track finance-progress-track--goal"
                  role="progressbar"
                  aria-label={`Cel ${goal.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, Math.round(progress))}
                >
                  <span style={{ width: `${Math.min(100, progress)}%` }} />
                </div>
                <div className="finance-goal-row__footer">
                  <span>
                    {formatMoney(goal.savedMinor, goal.currency, hideAmounts)} z{" "}
                    {formatMoney(goal.targetMinor, goal.currency, hideAmounts)}
                  </span>
                  <span>Brakuje {formatMoney(remaining, goal.currency, hideAmounts)}</span>
                  <span className="finance-row-actions">
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => onEdit(goal)}
                      aria-label={`Edytuj cel ${goal.name}`}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="icon-button module-danger-icon"
                      type="button"
                      onClick={() => onRemove(goal)}
                      aria-label={`Usuń cel ${goal.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              </div>
            </article>
          );
        })}
        {!savingsGoals.length && (
          <div className="finance-mini-empty">
            <PiggyBank size={19} />
            <span>Cele oszczędnościowe pojawią się tutaj.</span>
          </div>
        )}
      </div>
    </section>
  );
}
