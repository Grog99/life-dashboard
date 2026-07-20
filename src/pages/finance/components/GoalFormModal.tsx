import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Modal } from "../../../components/Modal";
import type { CurrencyCode, SavingsGoal, Visibility } from "../../../financeTypes";
import { currencyOptions, type GoalFormState } from "../financeConstants";

interface GoalFormModalProps {
  open: boolean;
  onClose: () => void;
  form: GoalFormState;
  setForm: Dispatch<SetStateAction<GoalFormState>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  editingGoal: SavingsGoal | null;
}

export function GoalFormModal({
  open,
  onClose,
  form,
  setForm,
  onSubmit,
  editingGoal,
}: GoalFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingGoal ? "Edytuj cel" : "Nowy cel oszczędnościowy"}
      eyebrow="Odkładanie"
      size="small"
    >
      <form className="finance-form" onSubmit={onSubmit}>
        <label className="field field--prominent">
          <span>Nazwa celu</span>
          <input
            autoFocus
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="np. Poduszka bezpieczeństwa"
          />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Wartość celu</span>
            <input
              required
              inputMode="decimal"
              value={form.target}
              onChange={(event) => setForm({ ...form, target: event.target.value })}
              placeholder="0,00"
            />
          </label>
          <label className="field">
            <span>Już odłożono</span>
            <input
              inputMode="decimal"
              value={form.saved}
              onChange={(event) => setForm({ ...form, saved: event.target.value })}
              placeholder="0,00"
            />
          </label>
        </div>
        <div className="form-grid form-grid--2">
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
          <label className="field">
            <span>Termin</span>
            <input
              type="date"
              value={form.deadline}
              onChange={(event) => setForm({ ...form, deadline: event.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>Widoczność</span>
          <select
            value={form.visibility}
            onChange={(event) => setForm({ ...form, visibility: event.target.value as Visibility })}
          >
            <option value="private">Tylko ja</option>
            <option value="household">Domownicy</option>
          </select>
        </label>
        <div className="modal-actions">
          <span />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Zapisz cel
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
