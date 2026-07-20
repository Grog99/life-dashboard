import { format } from "date-fns";
import { pl } from "date-fns/locale";
import { Check, MapPin, Plus, Route, Trash2 } from "lucide-react";
import type { CurrencyCode, TripItineraryItem } from "../../../advancedTypes";
import { formatMoney } from "../../../lib/money";
import { capitalize, itineraryIcons, itineraryLabels } from "../tripConstants";

interface TripItineraryViewProps {
  tripDays: Date[];
  itinerary: TripItineraryItem[];
  currency: CurrencyCode;
  hideAmounts: boolean;
  onAddItinerary: (date?: string) => void;
  onDeleteItem: (item: TripItineraryItem) => void;
}

export function TripItineraryView({
  tripDays,
  itinerary,
  currency,
  hideAmounts,
  onAddItinerary,
  onDeleteItem,
}: TripItineraryViewProps) {
  return (
    <section className="panel trips-section trips-itinerary">
      <header className="trips-section__header">
        <div>
          <span className="section-kicker">
            <Route size={14} /> Dzień po dniu
          </span>
          <h2>Plan podróży</h2>
          <p>Układaj transport, miejsca i chwile odpoczynku w jednym widoku.</p>
        </div>
        <button
          className="button button--primary button--small"
          type="button"
          onClick={() => onAddItinerary()}
        >
          <Plus size={15} /> Dodaj punkt
        </button>
      </header>
      <div className="trips-days">
        {tripDays.map((day, dayIndex) => {
          const date = format(day, "yyyy-MM-dd");
          const dayItems = itinerary.filter((item) => item.date === date);
          return (
            <article className="trips-day" key={date}>
              <header>
                <span>Dzień {dayIndex + 1}</span>
                <div>
                  <strong>{capitalize(format(day, "EEEE", { locale: pl }))}</strong>
                  <small>{format(day, "d MMMM", { locale: pl })}</small>
                </div>
                <button
                  type="button"
                  onClick={() => onAddItinerary(date)}
                  aria-label={`Dodaj punkt: ${format(day, "d MMMM", { locale: pl })}`}
                >
                  <Plus size={16} />
                </button>
              </header>
              <div className="trips-day__items">
                {dayItems.map((item) => {
                  const Icon = itineraryIcons[item.type];
                  return (
                    <div className="trips-schedule-item" key={item.id}>
                      <time>{item.time}</time>
                      <span className={`trips-item-icon trips-item-icon--${item.type}`}>
                        <Icon size={17} />
                      </span>
                      <div>
                        <span>
                          <strong>{item.title}</strong>
                          {item.booked && (
                            <small>
                              <Check size={12} /> Potwierdzone
                            </small>
                          )}
                        </span>
                        <p>
                          {item.location && (
                            <>
                              <MapPin size={13} /> {item.location}
                            </>
                          )}
                          {item.notes && <span>{item.notes}</span>}
                        </p>
                      </div>
                      <div className="trips-schedule-item__cost">
                        <small>{itineraryLabels[item.type]}</small>
                        {item.costMinor ? (
                          <strong>{formatMoney(item.costMinor, currency, hideAmounts)}</strong>
                        ) : null}
                      </div>
                      <button
                        className="icon-button module-danger-icon"
                        type="button"
                        onClick={() => onDeleteItem(item)}
                        aria-label={`Usuń ${item.title}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
                {!dayItems.length && (
                  <button
                    className="trips-day__empty"
                    type="button"
                    onClick={() => onAddItinerary(date)}
                  >
                    <Plus size={15} /> Dodaj plan na ten dzień
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
