import { useRef, type FormEvent } from "react";
import { Modal } from "../../../components/Modal";
import type { CurrencyCode } from "../../../financeTypes";
import type { Trip } from "../../../advancedTypes";
import { parseMoneyToMinor } from "../../../lib/money";

interface EditTripModalProps {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  onSave: (changes: Partial<Trip>) => void;
  onDelete: () => void;
}

export function EditTripModal({ open, onClose, trip, onSave, onDelete }: EditTripModalProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const startDate = String(form.get("startDate"));
    const endDate = String(form.get("endDate"));
    const endInput = event.currentTarget.elements.namedItem("endDate") as HTMLInputElement;
    if (endDate < startDate) {
      endInput.setCustomValidity("Data powrotu nie może być wcześniejsza niż data wyjazdu.");
      endInput.reportValidity();
      return;
    }
    endInput.setCustomValidity("");
    onSave({
      name: String(form.get("name")).trim(),
      destination: String(form.get("destination")).trim(),
      startDate,
      endDate,
      budgetMinor: String(form.get("budget")).trim()
        ? Math.abs(parseMoneyToMinor(String(form.get("budget"))))
        : undefined,
      currency: String(form.get("currency")) as CurrencyCode,
      travelers: String(form.get("travelers"))
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      accent: String(form.get("accent")) as Trip["accent"],
      notes: String(form.get("notes")).trim(),
    });
  };
  const hasUnsavedChanges = () => {
    const form = formRef.current;
    if (!form) return false;
    const data = new FormData(form);
    const originalBudget = trip.budgetMinor !== undefined ? String(trip.budgetMinor / 100) : "";
    return (
      String(data.get("name")).trim() !== trip.name ||
      String(data.get("destination")).trim() !== trip.destination ||
      String(data.get("startDate")) !== trip.startDate ||
      String(data.get("endDate")) !== trip.endDate ||
      String(data.get("budget")).trim() !== originalBudget ||
      String(data.get("currency")) !== trip.currency ||
      String(data.get("travelers"))
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .join(", ") !== trip.travelers.join(", ") ||
      String(data.get("accent")) !== trip.accent ||
      String(data.get("notes")).trim() !== trip.notes
    );
  };
  const confirmDiscardChanges = () =>
    !hasUnsavedChanges() ||
    window.confirm("Masz niezapisane zmiany w podróży. Czy na pewno chcesz je odrzucić?");
  return (
    <Modal
      open={open}
      onClose={onClose}
      confirmClose={confirmDiscardChanges}
      title="Edytuj podróż"
      eyebrow={trip.name}
      size="large"
    >
      <form ref={formRef} className="trips-modal-form" onSubmit={submit} key={trip.id}>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Nazwa</span>
            <input autoFocus required name="name" defaultValue={trip.name} />
          </label>
          <label className="field">
            <span>Kierunek</span>
            <input required name="destination" defaultValue={trip.destination} />
          </label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Wyjazd</span>
            <input required type="date" name="startDate" defaultValue={trip.startDate} />
          </label>
          <label className="field">
            <span>Powrót</span>
            <input required type="date" name="endDate" defaultValue={trip.endDate} />
          </label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Budżet</span>
            <input
              name="budget"
              inputMode="decimal"
              placeholder="Bez ustalonego budżetu"
              defaultValue={trip.budgetMinor !== undefined ? trip.budgetMinor / 100 : ""}
            />
          </label>
          <label className="field">
            <span>Waluta</span>
            <select name="currency" defaultValue={trip.currency}>
              <option>PLN</option>
              <option>EUR</option>
              <option>USD</option>
              <option>GBP</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Podróżujący</span>
          <input required name="travelers" defaultValue={trip.travelers.join(", ")} />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Kolor</span>
            <select name="accent" defaultValue={trip.accent}>
              <option value="ocean">Oceaniczny</option>
              <option value="terracotta">Terakota</option>
              <option value="forest">Leśny</option>
              <option value="violet">Fioletowy</option>
            </select>
          </label>
          <label className="field">
            <span>Notatka</span>
            <input name="notes" defaultValue={trip.notes} />
          </label>
        </div>
        <div className="modal-actions">
          <button
            className="button button--danger-ghost"
            type="button"
            aria-label={`Usuń podróż ${trip.name}`}
            onClick={onDelete}
          >
            Usuń podróż
          </button>
          <div>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                if (confirmDiscardChanges()) onClose();
              }}
            >
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              Zapisz zmiany
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
