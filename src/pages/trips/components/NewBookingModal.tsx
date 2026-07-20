import type { FormEvent } from "react";
import { TicketCheck } from "lucide-react";
import { Modal } from "../../../components/Modal";
import type { Trip, TripBooking, TripItineraryItem } from "../../../advancedTypes";
import { parseMoneyToMinor } from "../../../lib/money";
import { bookingLabels } from "../tripConstants";

interface NewBookingModalProps {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  itinerary: TripItineraryItem[];
  onCreate: (booking: Omit<TripBooking, "id" | "updatedAt" | "version">) => void;
}

export function NewBookingModal({
  open,
  onClose,
  trip,
  itinerary,
  onCreate,
}: NewBookingModalProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onCreate({
      tripId: trip.id,
      itineraryItemId: String(form.get("itineraryItemId") ?? "") || undefined,
      type: String(form.get("type")) as TripBooking["type"],
      provider: String(form.get("provider")).trim(),
      reference: String(form.get("reference")).trim(),
      title: String(form.get("title")).trim(),
      startAt: `${String(form.get("date"))}T${String(form.get("time"))}`,
      amountMinor: Math.abs(parseMoneyToMinor(String(form.get("amount")))),
      paid: form.get("paid") === "on",
    });
  };
  return (
    <Modal open={open} onClose={onClose} title="Nowa rezerwacja" eyebrow={trip.name} size="large">
      <form className="trips-modal-form" onSubmit={submit}>
        <div className="form-grid form-grid--2">
          <label className="field field--prominent">
            <span>Nazwa</span>
            <input autoFocus required name="title" placeholder="np. Lot Warszawa → Rzym" />
          </label>
          <label className="field">
            <span>Rodzaj</span>
            <select name="type" defaultValue="stay">
              {Object.entries(bookingLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field">
            <span>Dostawca</span>
            <input required name="provider" placeholder="Linia, hotel lub operator" />
          </label>
          <label className="field">
            <span>Numer rezerwacji</span>
            <input name="reference" placeholder="Opcjonalnie" />
          </label>
        </div>
        <label className="field">
          <span>Powiązany punkt planu</span>
          <select name="itineraryItemId" defaultValue="">
            <option value="">Brak — osobny koszt</option>
            {itinerary.map((item) => (
              <option value={item.id} key={item.id}>
                {item.date} · {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid form-grid--3">
          <label className="field">
            <span>Data</span>
            <input
              required
              type="date"
              name="date"
              min={trip.startDate}
              max={trip.endDate}
              defaultValue={trip.startDate}
            />
          </label>
          <label className="field">
            <span>Godzina</span>
            <input required type="time" name="time" defaultValue="12:00" />
          </label>
          <label className="field">
            <span>Koszt ({trip.currency})</span>
            <input name="amount" inputMode="decimal" placeholder="0,00" />
          </label>
        </div>
        <label className="field">
          <span>
            <input type="checkbox" name="paid" /> Opłacona
          </span>
        </label>
        <div className="modal-actions">
          <span />
          <div>
            <button className="button button--ghost" type="button" onClick={onClose}>
              Anuluj
            </button>
            <button className="button button--primary" type="submit">
              <TicketCheck size={15} /> Dodaj rezerwację
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
