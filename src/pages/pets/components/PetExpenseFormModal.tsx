import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Modal } from "../../../components/Modal";
import type { Pet, PetExpense, Visibility } from "../../../advancedTypes";
import { expenseLabels, type ExpenseDraft } from "../petConstants";

interface PetExpenseFormModalProps {
  open: boolean;
  onClose: () => void;
  draft: ExpenseDraft;
  setDraft: Dispatch<SetStateAction<ExpenseDraft>>;
  selectedPet: Pet | undefined;
  onSubmit: (event: FormEvent) => void;
}

export function PetExpenseFormModal({
  open,
  onClose,
  draft,
  setDraft,
  selectedPet,
  onSubmit,
}: PetExpenseFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Dodaj wydatek"
      eyebrow={selectedPet?.name ?? "Zwierzęta"}
    >
      <form className="form-grid" onSubmit={onSubmit}>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Kategoria</span>
            <select
              value={draft.type}
              onChange={(event) => {
                const type = event.target.value as PetExpense["type"];
                setDraft((prev) => {
                  const isGenericTitle =
                    !prev.title.trim() || prev.title === expenseLabels[prev.type];
                  return {
                    ...prev,
                    type,
                    title: isGenericTitle ? expenseLabels[type] : prev.title,
                  };
                });
              }}
            >
              <option value="food">Jedzenie</option>
              <option value="vet">Weterynarz</option>
              <option value="accessories">Akcesoria/zabawki</option>
              <option value="grooming">Pielęgnacja</option>
              <option value="other">Inne</option>
            </select>
          </label>
          <label className="field">
            <span>Data</span>
            <input
              required
              type="date"
              value={draft.date}
              onChange={(event) => setDraft({ ...draft, date: event.target.value })}
            />
          </label>
        </div>
        <label className="field field--prominent">
          <span>Opis</span>
          <input
            autoFocus
            required
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="np. Siano i granulat"
          />
        </label>
        <label className="field">
          <span>Kwota (PLN)</span>
          <input
            inputMode="decimal"
            required
            value={draft.amount}
            onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
            placeholder="42,00"
          />
        </label>
        <label className="field">
          <span>Widoczność</span>
          <select
            value={draft.visibility}
            onChange={(event) =>
              setDraft({ ...draft, visibility: event.target.value as Visibility })
            }
          >
            <option value="household">Domownicy</option>
            <option value="private">Tylko ja</option>
          </select>
        </label>
        <div className="modal-actions">
          <button className="button button--ghost" type="button" onClick={onClose}>
            Anuluj
          </button>
          <button className="button button--primary" type="submit">
            Zapisz wpis
          </button>
        </div>
      </form>
    </Modal>
  );
}
