import type { FormEvent } from "react";
import { Plane, Sparkles } from "lucide-react";
import { format } from "date-fns";
import { Modal } from "../../../components/Modal";
import type { CurrencyCode } from "../../../financeTypes";
import type { Trip } from "../../../advancedTypes";
import { parseMoneyToMinor } from "../../../lib/money";
import { statusLabels } from "../tripConstants";

interface NewTripModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (trip: Omit<Trip, "id" | "updatedAt" | "version" | "progress">) => void;
}

export function NewTripModal({ open, onClose, onCreate }: NewTripModalProps) {
  const today = format(new Date(), "yyyy-MM-dd");

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
    const status = String(form.get("status")) as Trip["status"];
    // `progress` nie jest już wysyłane z formularza -- serwer liczy je autorytatywnie
    // (docs/plans/podroze-trips.md "Projekt progress"); useTripsStore.addTrip liczy je lokalnie
    // (optymistycznie) tą samą formułą.
    onCreate({
      name: String(form.get("name")).trim(),
      destination: String(form.get("destination")).trim(),
      startDate,
      endDate,
      status,
      budgetMinor: String(form.get("budget")).trim()
        ? Math.abs(parseMoneyToMinor(String(form.get("budget"))))
        : undefined,
      currency: String(form.get("currency")) as CurrencyCode,
      travelers: String(form.get("travelers"))
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      accent: String(form.get("accent")) as Trip["accent"],
      notes: String(form.get("notes")).trim(),
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Nowa podróż" eyebrow="Zacznij od kierunku" size="large">
      <form className="trips-modal-form" onSubmit={submit}>
        <div className="form-grid form-grid--2">
          <label className="field field--prominent">
            <span>Nazwa wyjazdu</span>
            <input name="name" placeholder="np. Toskania 2026" required autoFocus />
          </label>
          <label className="field field--prominent">
            <span>Kierunek</span>
            <input name="destination" placeholder="Miasto, region lub trasa" required />
          </label>
        </div>
        <div className="form-grid form-grid--3">
          <label className="field">
            <span>Wyjazd</span>
            <input type="date" name="startDate" min={today} defaultValue={today} required />
          </label>
          <label className="field">
            <span>Powrót</span>
            <input type="date" name="endDate" min={today} defaultValue={today} required />
          </label>
          <label className="field">
            <span>Etap</span>
            <select name="status" defaultValue="planning">
              {Object.entries(statusLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Budżet</span>
            <input name="budget" inputMode="decimal" placeholder="5 000" />
          </label>
          <label className="field">
            <span>Waluta</span>
            <select name="currency" defaultValue="PLN">
              <option>PLN</option>
              <option>EUR</option>
              <option>USD</option>
              <option>GBP</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>
            Podróżujący <small>— oddziel przecinkami</small>
          </span>
          <input name="travelers" defaultValue="Ty" placeholder="Ty, Anna" required />
        </label>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Kolor planu</span>
            <select name="accent" defaultValue="ocean">
              <option value="ocean">Oceaniczny</option>
              <option value="terracotta">Terakota</option>
              <option value="forest">Leśny</option>
              <option value="violet">Fioletowy</option>
            </select>
          </label>
          <label className="field">
            <span>Krótka intencja</span>
            <input name="notes" placeholder="Jak ma wyglądać ten wyjazd?" />
          </label>
        </div>
        <div className="trips-form-hint">
          <Sparkles size={16} />
          <span>Po utworzeniu zaczniesz od planu dnia, rezerwacji i wspólnej listy pakowania.</span>
        </div>
        <div className="modal-actions">
          <span />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              <Plane size={16} /> Utwórz podróż
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
