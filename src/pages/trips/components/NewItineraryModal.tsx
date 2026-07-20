import type { FormEvent } from "react";
import { CheckCircle2, Plus } from "lucide-react";
import { Modal } from "../../../components/Modal";
import type { Trip, TripItineraryItem } from "../../../advancedTypes";
import { parseMoneyToMinor } from "../../../lib/money";
import { itineraryLabels } from "../tripConstants";

interface NewItineraryModalProps {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  initialDate: string;
  onCreate: (item: Omit<TripItineraryItem, "id" | "updatedAt" | "version">) => void;
}

export function NewItineraryModal({ open, onClose, trip, initialDate, onCreate }: NewItineraryModalProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cost = String(form.get("cost")).trim();
    const costInput = event.currentTarget.elements.namedItem("cost") as HTMLInputElement;
    const costMinor = cost ? parseMoneyToMinor(cost) : undefined;
    if (costMinor !== undefined && costMinor < 0) {
      costInput.setCustomValidity("Koszt nie może być ujemny.");
      costInput.reportValidity();
      return;
    }
    costInput.setCustomValidity("");
    onCreate({
      tripId: trip.id,
      date: String(form.get("date")),
      time: String(form.get("time")),
      title: String(form.get("title")).trim(),
      type: String(form.get("type")) as TripItineraryItem["type"],
      location: String(form.get("location")).trim() || undefined,
      costMinor,
      booked: form.get("booked") === "on",
      notes: String(form.get("notes")).trim() || undefined,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Dodaj do planu" eyebrow={trip.name} size="large">
      <form className="trips-modal-form" onSubmit={submit} key={`${trip.id}-${initialDate}`}>
        <label className="field field--prominent">
          <span>Co planujesz?</span>
          <input name="title" placeholder="np. Odbiór samochodu" required autoFocus />
        </label>
        <div className="form-grid form-grid--3">
          <label className="field">
            <span>Dzień</span>
            <input
              type="date"
              name="date"
              min={trip.startDate}
              max={trip.endDate}
              defaultValue={initialDate}
              required
            />
          </label>
          <label className="field">
            <span>Godzina</span>
            <input type="time" name="time" defaultValue="10:00" required />
          </label>
          <label className="field">
            <span>Rodzaj</span>
            <select name="type" defaultValue="activity">
              {Object.entries(itineraryLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Miejsce</span>
            <input name="location" placeholder="Adres lub punkt spotkania" />
          </label>
          <label className="field">
            <span>Koszt ({trip.currency})</span>
            <input name="cost" inputMode="decimal" placeholder="0,00" />
          </label>
        </div>
        <label className="field">
          <span>Notatka</span>
          <textarea name="notes" placeholder="Numer peronu, godzina zameldowania, co zabrać…" />
        </label>
        <label className="trips-check-field">
          <input type="checkbox" name="booked" />
          <span>
            <CheckCircle2 size={17} />
            <strong>Mam potwierdzenie lub rezerwację</strong>
            <small>Oznacz punkt jako zabezpieczony.</small>
          </span>
        </label>
        <div className="modal-actions">
          <span />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              <Plus size={16} /> Dodaj do planu
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
