import { CalendarDays, Check, Clock3, Plus, TicketCheck, Trash2 } from "lucide-react";
import type { CurrencyCode, TripBooking } from "../../../advancedTypes";
import { formatMoney } from "../../../lib/money";
import { bookingDate, bookingIcons, bookingLabels } from "../tripConstants";

interface TripBookingsViewProps {
  bookings: TripBooking[];
  currency: CurrencyCode;
  hideAmounts: boolean;
  confirmedCount: number;
  onTogglePaid: (booking: TripBooking) => void;
  onDelete: (booking: TripBooking) => void;
  onAdd: () => void;
}

export function TripBookingsView({
  bookings,
  currency,
  hideAmounts,
  confirmedCount,
  onTogglePaid,
  onDelete,
  onAdd,
}: TripBookingsViewProps) {
  return (
    <section className="panel trips-section trips-bookings">
      <header className="trips-section__header">
        <div>
          <span className="section-kicker">
            <TicketCheck size={14} /> Potwierdzenia
          </span>
          <h2>Rezerwacje</h2>
          <p>Najważniejsze numery, daty i płatności bez szukania w wiadomościach.</p>
        </div>
        <div className="trips-booking-header-actions">
          <div className="trips-bookings__summary">
            <strong>
              {confirmedCount}/{bookings.length}
            </strong>
            <span>opłacone</span>
          </div>
          <button className="button button--primary button--small" type="button" onClick={onAdd}>
            <Plus size={15} /> Dodaj
          </button>
        </div>
      </header>
      {bookings.length ? (
        <div className="trips-booking-grid">
          {bookings.map((booking) => {
            const Icon = bookingIcons[booking.type];
            return (
              <article className="trips-booking" key={booking.id}>
                <header>
                  <span className={`trips-booking__icon trips-booking__icon--${booking.type}`}>
                    <Icon size={20} />
                  </span>
                  <button
                    type="button"
                    className={booking.paid ? "trips-paid" : "trips-unpaid"}
                    onClick={() => onTogglePaid(booking)}
                  >
                    {booking.paid ? <Check size={12} /> : <Clock3 size={12} />}
                    {booking.paid ? "Opłacona" : "Do opłacenia"}
                  </button>
                </header>
                <span>
                  {bookingLabels[booking.type]} · {booking.provider}
                </span>
                <h3>{booking.title}</h3>
                <p>
                  <CalendarDays size={14} /> {bookingDate(booking.startAt)}
                </p>
                <footer>
                  <div>
                    <small>Numer rezerwacji</small>
                    <code>{booking.reference || "—"}</code>
                  </div>
                  <strong>{formatMoney(booking.amountMinor, currency, hideAmounts)}</strong>
                  <button
                    className="icon-button module-danger-icon"
                    type="button"
                    onClick={() => onDelete(booking)}
                    aria-label={`Usuń rezerwację ${booking.title}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="trips-section-empty">
          <TicketCheck size={25} />
          <h3>Nie ma jeszcze rezerwacji</h3>
          <p>Dodaj transport, nocleg lub atrakcję wraz z numerem potwierdzenia.</p>
          <button className="button button--soft" type="button" onClick={onAdd}>
            <Plus size={15} /> Dodaj rezerwację
          </button>
        </div>
      )}
    </section>
  );
}
