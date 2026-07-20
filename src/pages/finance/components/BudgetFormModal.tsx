import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Modal } from "../../../components/Modal";
import type { CurrencyCode, FinanceBudget } from "../../../financeTypes";
import { currencyOptions, type BudgetFormState } from "../financeConstants";

interface BudgetFormModalProps {
  open: boolean;
  onClose: () => void;
  form: BudgetFormState;
  setForm: Dispatch<SetStateAction<BudgetFormState>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  editingBudget: FinanceBudget | null;
}

export function BudgetFormModal({
  open,
  onClose,
  form,
  setForm,
  onSubmit,
  editingBudget,
}: BudgetFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingBudget ? "Edytuj budżet" : "Nowy budżet"}
      eyebrow="Plan miesiąca"
      size="small"
    >
      <form className="finance-form" onSubmit={onSubmit}>
        <label className="field field--prominent">
          <span>Kategoria</span>
          <input
            autoFocus
            required
            list="finance-category-options"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
          />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Miesięczny limit</span>
            <div className="finance-money-input">
              <input
                required
                inputMode="decimal"
                value={form.limit}
                onChange={(event) => setForm({ ...form, limit: event.target.value })}
                placeholder="0,00"
              />
              <span>{form.currency}</span>
            </div>
          </label>
          <label className="field">
            <span>Waluta</span>
            <select
              value={form.currency}
              onChange={(event) =>
                setForm({ ...form, currency: event.target.value as CurrencyCode })
              }
            >
              {currencyOptions.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field finance-color-field">
          <span>Kolor</span>
          <div>
            <input
              type="color"
              value={form.color}
              onChange={(event) => setForm({ ...form, color: event.target.value })}
            />
            <span>{form.color.toUpperCase()}</span>
          </div>
        </label>
        <div className="modal-actions">
          <span />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Zapisz budżet
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
