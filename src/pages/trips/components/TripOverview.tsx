import {
  CheckCircle2,
  Clock3,
  Flag,
  Luggage,
  NotebookPen,
  Plus,
  Route,
  Sparkles,
  TicketCheck,
  WalletCards,
} from "lucide-react";
import type { Trip, TripItineraryItem } from "../../../advancedTypes";
import { formatMoney } from "../../../lib/money";
import { formatShortDate } from "../../../lib/date";
import { itineraryIcons, itineraryLabels, type TripView } from "../tripConstants";

interface TripOverviewProps {
  trip: Trip;
  confirmedBookings: number;
  bookingsCount: number;
  plannedTotal: number;
  hasBudget: boolean;
  hideAmounts: boolean;
  packingProgress: number;
  packedCount: number;
  packingCount: number;
  nextSteps: Array<{ label: string; view: TripView }>;
  itinerary: TripItineraryItem[];
  onNavigate: (view: TripView) => void;
  onAddItinerary: () => void;
  onSaveNotes: (notes: string) => void;
}

export function TripOverview({
  trip,
  confirmedBookings,
  bookingsCount,
  plannedTotal,
  hasBudget,
  hideAmounts,
  packingProgress,
  packedCount,
  packingCount,
  nextSteps,
  itinerary,
  onNavigate,
  onAddItinerary,
  onSaveNotes,
}: TripOverviewProps) {
  return (
    <div className="trips-overview">
      <section className="trips-metrics" aria-label="Podsumowanie podróży">
        <article>
          <span className="trips-metric__icon trips-metric__icon--green">
            <Flag size={18} />
          </span>
          <div>
            <small>Przygotowanie</small>
            <strong>{trip.progress}%</strong>
          </div>
          <span className="trips-mini-progress">
            <i style={{ width: `${trip.progress}%` }} />
          </span>
        </article>
        <article>
          <span className="trips-metric__icon trips-metric__icon--blue">
            <TicketCheck size={18} />
          </span>
          <div>
            <small>Rezerwacje</small>
            <strong>
              {confirmedBookings}/{bookingsCount}
            </strong>
          </div>
          <small>{bookingsCount ? "opłacone" : "brak wpisów"}</small>
        </article>
        <article>
          <span className="trips-metric__icon trips-metric__icon--amber">
            <WalletCards size={18} />
          </span>
          <div>
            <small>Zaplanowano</small>
            <strong>{formatMoney(plannedTotal, trip.currency, hideAmounts)}</strong>
          </div>
          <small>
            {hasBudget
              ? `z ${formatMoney(trip.budgetMinor ?? 0, trip.currency, hideAmounts)}`
              : "bez ustalonego budżetu"}
          </small>
        </article>
        <article>
          <span className="trips-metric__icon trips-metric__icon--violet">
            <Luggage size={18} />
          </span>
          <div>
            <small>Pakowanie</small>
            <strong>{packingProgress}%</strong>
          </div>
          <small>
            {packedCount} z {packingCount} gotowe
          </small>
        </article>
      </section>

      <div className="trips-overview__grid">
        <section className="panel trips-next">
          <header className="panel__header panel__header--compact">
            <div>
              <span className="section-kicker">
                <Sparkles size={14} /> Następny krok
              </span>
              <h2>Co warto domknąć</h2>
            </div>
          </header>
          {nextSteps.length ? (
            <div className="trips-next__list">
              {nextSteps.map((item, index) => (
                <button type="button" key={item.label} onClick={() => onNavigate(item.view)}>
                  <span>{index + 1}</span>
                  <strong>{item.label}</strong>
                  <span>Przejdź</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="trips-all-ready">
              <CheckCircle2 size={22} />
              <div>
                <strong>Plan wygląda świetnie</strong>
                <span>Najważniejsze przygotowania są domknięte.</span>
              </div>
            </div>
          )}
        </section>

        <section className="panel trips-upcoming">
          <header className="panel__header panel__header--compact">
            <div>
              <span className="section-kicker">
                <Clock3 size={14} /> Najbliżej
              </span>
              <h2>Początek podróży</h2>
            </div>
            <button className="text-button" type="button" onClick={() => onNavigate("itinerary")}>
              Cały plan
            </button>
          </header>
          <div className="trips-upcoming__items">
            {itinerary.slice(0, 3).map((item) => {
              const Icon = itineraryIcons[item.type];
              return (
                <article key={item.id}>
                  <time>
                    <strong>{item.time}</strong>
                    <span>{formatShortDate(item.date)}</span>
                  </time>
                  <span className={`trips-item-icon trips-item-icon--${item.type}`}>
                    <Icon size={16} />
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.location || itineraryLabels[item.type]}</span>
                  </div>
                </article>
              );
            })}
            {!itinerary.length && (
              <button className="trips-inline-empty" type="button" onClick={onAddItinerary}>
                <Route size={19} />
                <span>
                  <strong>Zacznij układać plan</strong>
                  <small>Dodaj pierwszy punkt podróży.</small>
                </span>
                <Plus size={16} />
              </button>
            )}
          </div>
        </section>

        <section className="panel trips-notes">
          <header className="panel__header panel__header--compact">
            <div>
              <span className="section-kicker">
                <NotebookPen size={14} /> Pod ręką
              </span>
              <h2>Notatki do wyjazdu</h2>
            </div>
            <span>zapis po opuszczeniu pola</span>
          </header>
          <textarea
            key={trip.id}
            defaultValue={trip.notes}
            placeholder="Pomysły, adresy, ważne informacje…"
            aria-label="Notatki do podróży"
            onBlur={(event) => {
              if (event.target.value !== trip.notes) onSaveNotes(event.target.value);
            }}
          />
        </section>
      </div>
    </div>
  );
}
