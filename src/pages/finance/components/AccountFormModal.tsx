import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Modal } from "../../../components/Modal";
import type { FinanceAccount, Visibility, CurrencyCode } from "../../../financeTypes";
import { accountTypeMeta, currencyOptions, type AccountFormState } from "../financeConstants";

interface AccountFormModalProps {
  open: boolean;
  onClose: () => void;
  form: AccountFormState;
  setForm: Dispatch<SetStateAction<AccountFormState>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function AccountFormModal({
  open,
  onClose,
  form,
  setForm,
  onSubmit,
}: AccountFormModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Nowy rachunek" eyebrow="Finanse" size="small">
      <form className="finance-form" onSubmit={onSubmit}>
        <label className="field field--prominent">
          <span>Nazwa rachunku</span>
          <input
            autoFocus
            required
            maxLength={50}
            placeholder="np. Konto codzienne"
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Rodzaj</span>
            <select
              value={form.type}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  type: event.target.value as FinanceAccount["type"],
                }))
              }
            >
              {Object.entries(accountTypeMeta).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Waluta</span>
            <select
              value={form.currency}
              onChange={(event) =>
                setForm((current) => ({ ...current, currency: event.target.value as CurrencyCode }))
              }
            >
              {currencyOptions.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Aktualne saldo</span>
          <div className="finance-money-input">
            <input
              inputMode="decimal"
              placeholder="0,00"
              value={form.balance}
              onChange={(event) =>
                setForm((current) => ({ ...current, balance: event.target.value }))
              }
            />
            <span>{form.currency}</span>
          </div>
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Widoczność</span>
            <select
              value={form.visibility}
              onChange={(event) =>
                setForm((current) => ({ ...current, visibility: event.target.value as Visibility }))
              }
            >
              <option value="private">Tylko ja</option>
              <option value="household">Wszyscy domownicy</option>
            </select>
          </label>
          <label className="field finance-color-field">
            <span>Kolor rachunku</span>
            <div>
              <input
                type="color"
                value={form.color}
                onChange={(event) =>
                  setForm((current) => ({ ...current, color: event.target.value }))
                }
              />
              <span>{form.color.toUpperCase()}</span>
            </div>
          </label>
        </div>
        <div className="modal-actions">
          <span />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Dodaj rachunek
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
