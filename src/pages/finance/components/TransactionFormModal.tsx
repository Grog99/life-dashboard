import type { Dispatch, FormEvent, SetStateAction } from "react";
import { ArrowDownLeft, ArrowUpRight, ShieldCheck } from "lucide-react";
import { Modal } from "../../../components/Modal";
import type { FinanceAccount, Visibility } from "../../../financeTypes";
import type { TransactionFormState } from "../financeConstants";

interface TransactionFormModalProps {
  open: boolean;
  onClose: () => void;
  form: TransactionFormState;
  setForm: Dispatch<SetStateAction<TransactionFormState>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  activeAccounts: FinanceAccount[];
  accountById: Map<string, FinanceAccount>;
  categories: string[];
  primaryCurrency: string;
}

export function TransactionFormModal({
  open,
  onClose,
  form,
  setForm,
  onSubmit,
  activeAccounts,
  accountById,
  categories,
  primaryCurrency,
}: TransactionFormModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Nowa transakcja" eyebrow="Finanse" size="medium">
      <form className="finance-form" onSubmit={onSubmit}>
        <div className="finance-direction-switch" role="group" aria-label="Rodzaj transakcji">
          <button
            className={form.direction === "expense" ? "active" : ""}
            type="button"
            onClick={() => setForm((current) => ({ ...current, direction: "expense" }))}
          >
            <ArrowUpRight size={16} /> Wydatek
          </button>
          <button
            className={form.direction === "income" ? "active" : ""}
            type="button"
            onClick={() => setForm((current) => ({ ...current, direction: "income" }))}
          >
            <ArrowDownLeft size={16} /> Wpływ
          </button>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Rachunek</span>
            <select
              required
              value={form.accountId}
              onChange={(event) => {
                const account = accountById.get(event.target.value);
                setForm((current) => ({
                  ...current,
                  accountId: event.target.value,
                  visibility: account?.visibility ?? current.visibility,
                }));
              }}
            >
              <option value="" disabled>
                Wybierz rachunek
              </option>
              {activeAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {account.currency}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Data księgowania</span>
            <input
              required
              type="date"
              value={form.bookedOn}
              onChange={(event) => setForm((current) => ({ ...current, bookedOn: event.target.value }))}
            />
          </label>
        </div>
        <label className="field field--prominent">
          <span>Kwota</span>
          <div className="finance-money-input">
            <input
              autoFocus
              required
              inputMode="decimal"
              placeholder="0,00"
              value={form.amount}
              onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
            />
            <span>{accountById.get(form.accountId)?.currency ?? primaryCurrency}</span>
          </div>
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Nazwa transakcji</span>
            <input
              required
              maxLength={80}
              placeholder="np. Zakupy spożywcze"
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Odbiorca / nadawca</span>
            <input
              maxLength={80}
              placeholder="np. Carrefour"
              value={form.merchant}
              onChange={(event) => setForm((current) => ({ ...current, merchant: event.target.value }))}
            />
          </label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Kategoria</span>
            <input
              list="finance-category-options"
              maxLength={50}
              value={form.category}
              onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
            />
            <datalist id="finance-category-options">
              {categories.map((category) => (
                <option value={category} key={category} />
              ))}
            </datalist>
          </label>
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
        </div>
        <label className="field">
          <span>
            Notatka <small>(opcjonalnie)</small>
          </span>
          <textarea
            maxLength={240}
            placeholder="Dodatkowe informacje…"
            value={form.notes}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
          />
        </label>
        <div className="modal-actions">
          <span className="finance-form-hint">
            <ShieldCheck size={14} /> Dane zostają w Twoim dashboardzie
          </span>
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Dodaj transakcję
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
