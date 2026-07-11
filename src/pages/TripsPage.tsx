import {
  BaggageClaim,
  Banknote,
  BedDouble,
  CalendarDays,
  Car,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Compass,
  Ellipsis,
  Eye,
  EyeOff,
  Flag,
  Globe2,
  Luggage,
  MapPin,
  NotebookPen,
  Plane,
  Pencil,
  Plus,
  Route,
  Sparkles,
  TicketCheck,
  TrainFront,
  Trash2,
  Utensils,
  UsersRound,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import {
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  isValid,
  parseISO,
} from "date-fns";
import { pl } from "date-fns/locale";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type {
  CurrencyCode,
  PackingItem,
  Trip,
  TripBooking,
  TripItineraryItem,
  Visibility,
} from "../advancedTypes";
import { Modal } from "../components/Modal";
import { formatShortDate } from "../lib/date";
import { formatMoney, parseMoneyToMinor } from "../lib/money";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useServerAuth } from "../server/AuthGate";
import "../styles/trips.css";

type TripView = "overview" | "itinerary" | "bookings" | "budget" | "packing";

export interface TripsPageProps {
  onToast?: (message: string) => void;
}

const statusLabels: Record<Trip["status"], string> = {
  idea: "Pomysł",
  planning: "W planowaniu",
  active: "W trakcie",
  archived: "Archiwum",
};

const itineraryLabels: Record<TripItineraryItem["type"], string> = {
  transport: "Transport",
  stay: "Nocleg",
  activity: "Atrakcja",
  food: "Jedzenie",
  other: "Inne",
};

const itineraryIcons: Record<TripItineraryItem["type"], LucideIcon> = {
  transport: TrainFront,
  stay: BedDouble,
  activity: Compass,
  food: Utensils,
  other: Ellipsis,
};

const bookingLabels: Record<TripBooking["type"], string> = {
  flight: "Loty",
  train: "Pociągi",
  stay: "Noclegi",
  car: "Samochód",
  activity: "Atrakcje",
};

const bookingIcons: Record<TripBooking["type"], LucideIcon> = {
  flight: Plane,
  train: TrainFront,
  stay: BedDouble,
  car: Car,
  activity: TicketCheck,
};

const packingLabels: Record<PackingItem["category"], string> = {
  documents: "Dokumenty",
  clothes: "Ubrania",
  electronics: "Elektronika",
  health: "Zdrowie",
  other: "Pozostałe",
};

const tripViews: Array<{ id: TripView; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Przegląd", icon: Compass },
  { id: "itinerary", label: "Plan podróży", icon: Route },
  { id: "bookings", label: "Rezerwacje", icon: TicketCheck },
  { id: "budget", label: "Budżet", icon: WalletCards },
  { id: "packing", label: "Pakowanie", icon: Luggage },
];

const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase("pl") + value.slice(1);

function safeDate(value: string): Date | null {
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

function tripDateRange(trip: Trip): string {
  const start = safeDate(trip.startDate);
  const end = safeDate(trip.endDate);
  if (!start || !end) return "Termin do ustalenia";
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${format(start, "d", { locale: pl })}–${format(end, "d MMMM yyyy", { locale: pl })}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${format(start, "d MMM", { locale: pl })} – ${format(end, "d MMM yyyy", { locale: pl })}`;
  }
  return `${format(start, "d MMM yyyy", { locale: pl })} – ${format(end, "d MMM yyyy", { locale: pl })}`;
}

function bookingDate(value: string): string {
  const parsed = safeDate(value);
  return parsed
    ? capitalize(format(parsed, "EEEE, d MMM · HH:mm", { locale: pl }))
    : value;
}

export function TripsPage({ onToast = () => undefined }: TripsPageProps) {
  const { snapshot } = useServerAuth();
  const currentOwnerId = snapshot?.user.id ?? "me";
  const trips = useAdvancedStore((state) => state.trips);
  const tripItinerary = useAdvancedStore((state) => state.tripItinerary);
  const tripBookings = useAdvancedStore((state) => state.tripBookings);
  const packingItems = useAdvancedStore((state) => state.packingItems);
  const hideAmounts = useAdvancedStore((state) => state.hideAmounts);
  const toggleHideAmounts = useAdvancedStore((state) => state.toggleHideAmounts);
  const addTrip = useAdvancedStore((state) => state.addTrip);
  const updateTrip = useAdvancedStore((state) => state.updateTrip);
  const addTripItineraryItem = useAdvancedStore((state) => state.addTripItineraryItem);
  const deleteTripItineraryItem = useAdvancedStore((state) => state.deleteTripItineraryItem);
  const addTripBooking = useAdvancedStore((state) => state.addTripBooking);
  const updateTripBooking = useAdvancedStore((state) => state.updateTripBooking);
  const deleteTripBooking = useAdvancedStore((state) => state.deleteTripBooking);
  const togglePackingItem = useAdvancedStore((state) => state.togglePackingItem);
  const addPackingItem = useAdvancedStore((state) => state.addPackingItem);

  const sortedTrips = useMemo(
    () => [...trips].sort((a, b) => {
      const order: Record<Trip["status"], number> = { active: 0, planning: 1, idea: 2, archived: 3 };
      return order[a.status] - order[b.status] || a.startDate.localeCompare(b.startDate);
    }),
    [trips],
  );
  const [selectedTripId, setSelectedTripId] = useState(() => sortedTrips[0]?.id ?? "");
  const [view, setView] = useState<TripView>("overview");
  const [tripModalOpen, setTripModalOpen] = useState(false);
  const [editTripModalOpen, setEditTripModalOpen] = useState(false);
  const [itineraryModalOpen, setItineraryModalOpen] = useState(false);
  const [bookingModalOpen, setBookingModalOpen] = useState(false);
  const [itineraryDate, setItineraryDate] = useState("");
  const [packingName, setPackingName] = useState("");
  const [packingCategory, setPackingCategory] = useState<PackingItem["category"]>("other");
  const [packingAssignee, setPackingAssignee] = useState("");

  const selectedTrip = trips.find((trip) => trip.id === selectedTripId) ?? sortedTrips[0];
  const itinerary = useMemo(
    () => tripItinerary
      .filter((item) => item.tripId === selectedTrip?.id)
      .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)),
    [selectedTrip?.id, tripItinerary],
  );
  const bookings = useMemo(
    () => tripBookings
      .filter((item) => item.tripId === selectedTrip?.id)
      .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [selectedTrip?.id, tripBookings],
  );
  const packing = useMemo(
    () => packingItems.filter((item) => item.tripId === selectedTrip?.id),
    [packingItems, selectedTrip?.id],
  );

  const tripDays = useMemo(() => {
    if (!selectedTrip) return [];
    const start = safeDate(selectedTrip.startDate);
    const end = safeDate(selectedTrip.endDate);
    if (!start || !end || end < start) return [];
    return eachDayOfInterval({ start, end });
  }, [selectedTrip]);

  if (!selectedTrip) {
    return (
      <div className="trips-page page-enter">
        <header className="page-header">
          <div>
            <span className="page-eyebrow"><Globe2 size={14} /> Podróże</span>
            <h1>Zaplanuj następny wyjazd</h1>
            <p>Zbierz plan, rezerwacje, budżet i listę rzeczy w jednym spokojnym miejscu.</p>
          </div>
          <button className="button button--primary" type="button" onClick={() => setTripModalOpen(true)}>
            <Plus size={17} /> Nowa podróż
          </button>
        </header>
        <section className="panel trips-empty">
          <span><Plane size={26} /></span>
          <h2>Dokąd jedziemy?</h2>
          <p>Dodaj pierwszy pomysł. Daty i budżet możesz później dopracować.</p>
          <button className="button button--primary" type="button" onClick={() => setTripModalOpen(true)}>
            <Plus size={16} /> Utwórz podróż
          </button>
        </section>
        <NewTripModal
          open={tripModalOpen}
          onClose={() => setTripModalOpen(false)}
          ownerId={currentOwnerId}
          onCreate={(trip) => {
            const id = addTrip(trip);
            setSelectedTripId(id);
            setTripModalOpen(false);
            onToast("Podróż została utworzona");
          }}
        />
      </div>
    );
  }

  const start = safeDate(selectedTrip.startDate);
  const end = safeDate(selectedTrip.endDate);
  const today = new Date();
  const duration = start && end ? Math.max(1, differenceInCalendarDays(end, start) + 1) : 0;
  const untilStart = start ? differenceInCalendarDays(start, today) : 0;
  const packedCount = packing.filter((item) => item.packed).length;
  const packingProgress = packing.length ? Math.round((packedCount / packing.length) * 100) : 0;
  const paidBookings = bookings.filter((booking) => booking.paid);
  const bookingTotal = bookings.reduce((sum, booking) => sum + booking.amountMinor, 0);
  const paidTotal = paidBookings.reduce((sum, booking) => sum + booking.amountMinor, 0);
  const additionalPlanCost = itinerary.reduce((sum, item) => {
    if (!item.costMinor) return sum;
    const representedByBooking = bookings.some((booking) => booking.itineraryItemId === item.id);
    return representedByBooking ? sum : sum + item.costMinor;
  }, 0);
  const plannedTotal = bookingTotal + additionalPlanCost;
  const hasBudget = selectedTrip.budgetMinor !== undefined;
  const remainingBudget = (selectedTrip.budgetMinor ?? 0) - plannedTotal;
  const isOverBudget = hasBudget && remainingBudget < 0;
  const budgetProgress = hasBudget && selectedTrip.budgetMinor
    ? Math.min(100, Math.round((plannedTotal / selectedTrip.budgetMinor) * 100))
    : hasBudget && plannedTotal > 0
      ? 100
      : 0;
  const confirmedBookings = paidBookings.length;

  const switchTrip = (tripId: string) => {
    setSelectedTripId(tripId);
    setView("overview");
  };

  const openItineraryModal = (date = selectedTrip.startDate) => {
    setItineraryDate(date);
    setItineraryModalOpen(true);
  };

  const addPacking = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = packingName.trim();
    if (!name) return;
    addPackingItem({
      tripId: selectedTrip.id,
      name,
      category: packingCategory,
      packed: false,
      assignedTo: packingAssignee || undefined,
    });
    setPackingName("");
    onToast("Dodano do listy pakowania");
  };

  const plannedDays = new Set(itinerary.map((item) => item.date)).size;

  const nextSteps = [
    bookings.length === 0
      ? { label: "Dodaj transport lub nocleg do planu", view: "itinerary" as TripView }
      : null,
    plannedDays < duration
      ? { label: "Uzupełnij plan dzień po dniu", view: "itinerary" as TripView }
      : null,
    packingProgress < 100
      ? { label: `Spakuj pozostałe rzeczy (${packing.length - packedCount})`, view: "packing" as TripView }
      : null,
    isOverBudget
      ? { label: "Sprawdź przekroczony budżet", view: "budget" as TripView }
      : null,
  ].filter((item): item is { label: string; view: TripView } => Boolean(item)).slice(0, 3);

  const budgetBreakdown = Object.entries(
    bookings.reduce<Record<string, number>>((result, booking) => {
      const label = bookingLabels[booking.type];
      result[label] = (result[label] ?? 0) + booking.amountMinor;
      return result;
    }, {}),
  );
  if (additionalPlanCost > 0) budgetBreakdown.push(["Poza rezerwacjami", additionalPlanCost]);

  return (
    <div className="trips-page page-enter">
      <header className="page-header trips-page__header">
        <div>
          <span className="page-eyebrow"><Globe2 size={14} /> Podróże</span>
          <h1>Planer podróży</h1>
          <p>Trasa, rezerwacje, wydatki i pakowanie — wszystko gotowe przed wyjazdem.</p>
        </div>
        <button className="button button--primary" type="button" onClick={() => setTripModalOpen(true)}>
          <Plus size={17} /> Nowa podróż
        </button>
      </header>

      <div className="trips-workspace">
        <aside className="panel trips-list" aria-label="Twoje podróże">
          <header>
            <div>
              <span>Twoje podróże</span>
              <strong>{trips.filter((trip) => trip.status !== "archived").length} aktywne plany</strong>
            </div>
            <button className="trips-list__add" type="button" onClick={() => setTripModalOpen(true)} aria-label="Dodaj podróż">
              <Plus size={17} />
            </button>
          </header>
          <div className="trips-list__items">
            {sortedTrips.map((trip) => (
              <button
                className={`trip-card trip-card--${trip.accent} ${trip.id === selectedTrip.id ? "trip-card--active" : ""}`}
                type="button"
                key={trip.id}
                onClick={() => switchTrip(trip.id)}
                aria-pressed={trip.id === selectedTrip.id}
              >
                <span className="trip-card__route"><MapPin size={15} /></span>
                <span className="trip-card__content">
                  <span className="trip-card__topline">
                    <small>{statusLabels[trip.status]}</small>
                    <small>{trip.progress}%</small>
                  </span>
                  <strong>{trip.name}</strong>
                  <span>{trip.destination}</span>
                  <span className="trip-card__date"><CalendarDays size={13} /> {tripDateRange(trip)}</span>
                  <span className="trip-card__progress"><i style={{ width: `${trip.progress}%` }} /></span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="trips-detail">
          <section className={`trips-hero trips-hero--${selectedTrip.accent}`}>
            <div className="trips-hero__wash" />
            <div className="trips-hero__main">
              <div className="trips-hero__badges">
                <select
                  value={selectedTrip.status}
                  onChange={(event) => updateTrip(selectedTrip.id, { status: event.target.value as Trip["status"] })}
                  aria-label="Status podróży"
                >
                  {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
                <span><UsersRound size={13} /> {selectedTrip.visibility === "household" ? "Wspólna" : "Prywatna"}</span>
                <button type="button" onClick={() => setEditTripModalOpen(true)}><Pencil size={12} /> Edytuj</button>
              </div>
              <span className="trips-hero__destination"><MapPin size={14} /> {selectedTrip.destination}</span>
              <h2>{selectedTrip.name}</h2>
              <p><CalendarDays size={15} /> {tripDateRange(selectedTrip)} <span>·</span> {duration} {duration === 1 ? "dzień" : "dni"}</p>
              <div className="trips-hero__people">
                {selectedTrip.travelers.slice(0, 4).map((traveler, index) => (
                  <span key={`${traveler}-${index}`} title={traveler}>{traveler.trim().charAt(0).toLocaleUpperCase("pl")}</span>
                ))}
                <small>{selectedTrip.travelers.join(", ")}</small>
              </div>
            </div>
            <div className="trips-hero__countdown">
              <span>{selectedTrip.status === "active" ? "Podróż trwa" : untilStart > 0 ? "Do wyjazdu" : "Plan podróży"}</span>
              <strong>{selectedTrip.status === "active" ? duration : untilStart > 0 ? untilStart : `${selectedTrip.progress}%`}</strong>
              <small>{selectedTrip.status === "active" ? "dni w planie" : untilStart > 0 ? (untilStart === 1 ? "dzień" : "dni") : "gotowe"}</small>
            </div>
          </section>

          <nav className="trips-tabs" aria-label="Sekcje podróży" role="tablist">
            {tripViews.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={view === item.id ? "active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={view === item.id}
                  key={item.id}
                  onClick={() => setView(item.id)}
                >
                  <Icon size={16} /> {item.label}
                  {item.id === "bookings" && bookings.length > 0 && <span>{bookings.length}</span>}
                  {item.id === "packing" && packing.length > 0 && <span>{packedCount}/{packing.length}</span>}
                </button>
              );
            })}
          </nav>

          {view === "overview" && (
            <div className="trips-overview">
              <section className="trips-metrics" aria-label="Podsumowanie podróży">
                <article>
                  <span className="trips-metric__icon trips-metric__icon--green"><Flag size={18} /></span>
                  <div><small>Przygotowanie</small><strong>{selectedTrip.progress}%</strong></div>
                  <span className="trips-mini-progress"><i style={{ width: `${selectedTrip.progress}%` }} /></span>
                </article>
                <article>
                  <span className="trips-metric__icon trips-metric__icon--blue"><TicketCheck size={18} /></span>
                  <div><small>Rezerwacje</small><strong>{confirmedBookings}/{bookings.length}</strong></div>
                  <small>{bookings.length ? "opłacone" : "brak wpisów"}</small>
                </article>
                <article>
                  <span className="trips-metric__icon trips-metric__icon--amber"><WalletCards size={18} /></span>
                  <div><small>Zaplanowano</small><strong>{formatMoney(plannedTotal, selectedTrip.currency, hideAmounts)}</strong></div>
                  <small>{hasBudget ? `z ${formatMoney(selectedTrip.budgetMinor ?? 0, selectedTrip.currency, hideAmounts)}` : "bez ustalonego budżetu"}</small>
                </article>
                <article>
                  <span className="trips-metric__icon trips-metric__icon--violet"><Luggage size={18} /></span>
                  <div><small>Pakowanie</small><strong>{packingProgress}%</strong></div>
                  <small>{packedCount} z {packing.length} gotowe</small>
                </article>
              </section>

              <div className="trips-overview__grid">
                <section className="panel trips-next">
                  <header className="panel__header panel__header--compact">
                    <div><span className="section-kicker"><Sparkles size={14} /> Następny krok</span><h2>Co warto domknąć</h2></div>
                  </header>
                  {nextSteps.length ? (
                    <div className="trips-next__list">
                      {nextSteps.map((item, index) => (
                        <button type="button" key={item.label} onClick={() => setView(item.view)}>
                          <span>{index + 1}</span>
                          <strong>{item.label}</strong>
                          <span>Przejdź</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="trips-all-ready"><CheckCircle2 size={22} /><div><strong>Plan wygląda świetnie</strong><span>Najważniejsze przygotowania są domknięte.</span></div></div>
                  )}
                </section>

                <section className="panel trips-upcoming">
                  <header className="panel__header panel__header--compact">
                    <div><span className="section-kicker"><Clock3 size={14} /> Najbliżej</span><h2>Początek podróży</h2></div>
                    <button className="text-button" type="button" onClick={() => setView("itinerary")}>Cały plan</button>
                  </header>
                  <div className="trips-upcoming__items">
                    {itinerary.slice(0, 3).map((item) => {
                      const Icon = itineraryIcons[item.type];
                      return (
                        <article key={item.id}>
                          <time><strong>{item.time}</strong><span>{formatShortDate(item.date)}</span></time>
                          <span className={`trips-item-icon trips-item-icon--${item.type}`}><Icon size={16} /></span>
                          <div><strong>{item.title}</strong><span>{item.location || itineraryLabels[item.type]}</span></div>
                        </article>
                      );
                    })}
                    {!itinerary.length && (
                      <button className="trips-inline-empty" type="button" onClick={() => openItineraryModal()}>
                        <Route size={19} /><span><strong>Zacznij układać plan</strong><small>Dodaj pierwszy punkt podróży.</small></span><Plus size={16} />
                      </button>
                    )}
                  </div>
                </section>

                <section className="panel trips-notes">
                  <header className="panel__header panel__header--compact">
                    <div><span className="section-kicker"><NotebookPen size={14} /> Pod ręką</span><h2>Notatki do wyjazdu</h2></div>
                    <span>zapis po opuszczeniu pola</span>
                  </header>
                  <textarea
                    key={selectedTrip.id}
                    defaultValue={selectedTrip.notes}
                    placeholder="Pomysły, adresy, ważne informacje…"
                    aria-label="Notatki do podróży"
                    onBlur={(event) => {
                      if (event.target.value !== selectedTrip.notes) {
                        updateTrip(selectedTrip.id, { notes: event.target.value });
                        onToast("Notatki zapisane");
                      }
                    }}
                  />
                </section>
              </div>
            </div>
          )}

          {view === "itinerary" && (
            <section className="panel trips-section trips-itinerary">
              <header className="trips-section__header">
                <div><span className="section-kicker"><Route size={14} /> Dzień po dniu</span><h2>Plan podróży</h2><p>Układaj transport, miejsca i chwile odpoczynku w jednym widoku.</p></div>
                <button className="button button--primary button--small" type="button" onClick={() => openItineraryModal()}><Plus size={15} /> Dodaj punkt</button>
              </header>
              <div className="trips-days">
                {tripDays.map((day, dayIndex) => {
                  const date = format(day, "yyyy-MM-dd");
                  const dayItems = itinerary.filter((item) => item.date === date);
                  return (
                    <article className="trips-day" key={date}>
                      <header>
                        <span>Dzień {dayIndex + 1}</span>
                        <div><strong>{capitalize(format(day, "EEEE", { locale: pl }))}</strong><small>{format(day, "d MMMM", { locale: pl })}</small></div>
                        <button type="button" onClick={() => openItineraryModal(date)} aria-label={`Dodaj punkt: ${format(day, "d MMMM", { locale: pl })}`}><Plus size={16} /></button>
                      </header>
                      <div className="trips-day__items">
                        {dayItems.map((item) => {
                          const Icon = itineraryIcons[item.type];
                          return (
                            <div className="trips-schedule-item" key={item.id}>
                              <time>{item.time}</time>
                              <span className={`trips-item-icon trips-item-icon--${item.type}`}><Icon size={17} /></span>
                              <div>
                                <span><strong>{item.title}</strong>{item.booked && <small><Check size={12} /> Potwierdzone</small>}</span>
                                <p>{item.location && <><MapPin size={13} /> {item.location}</>}{item.notes && <span>{item.notes}</span>}</p>
                              </div>
                              <div className="trips-schedule-item__cost"><small>{itineraryLabels[item.type]}</small>{item.costMinor ? <strong>{formatMoney(item.costMinor, selectedTrip.currency, hideAmounts)}</strong> : null}</div>
                              <button className="icon-button module-danger-icon" type="button" onClick={() => { if (window.confirm(`Usunąć „${item.title}” z planu?`)) { deleteTripItineraryItem(item.id); onToast("Punkt został usunięty z planu"); } }} aria-label={`Usuń ${item.title}`}><Trash2 size={14} /></button>
                            </div>
                          );
                        })}
                        {!dayItems.length && (
                          <button className="trips-day__empty" type="button" onClick={() => openItineraryModal(date)}><Plus size={15} /> Dodaj plan na ten dzień</button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {view === "bookings" && (
            <section className="panel trips-section trips-bookings">
              <header className="trips-section__header">
                <div><span className="section-kicker"><TicketCheck size={14} /> Potwierdzenia</span><h2>Rezerwacje</h2><p>Najważniejsze numery, daty i płatności bez szukania w wiadomościach.</p></div>
                <div className="trips-booking-header-actions"><div className="trips-bookings__summary"><strong>{confirmedBookings}/{bookings.length}</strong><span>opłacone</span></div><button className="button button--primary button--small" type="button" onClick={() => setBookingModalOpen(true)}><Plus size={15} /> Dodaj</button></div>
              </header>
              {bookings.length ? (
                <div className="trips-booking-grid">
                  {bookings.map((booking) => {
                    const Icon = bookingIcons[booking.type];
                    return (
                      <article className="trips-booking" key={booking.id}>
                        <header><span className={`trips-booking__icon trips-booking__icon--${booking.type}`}><Icon size={20} /></span><button type="button" className={booking.paid ? "trips-paid" : "trips-unpaid"} onClick={() => updateTripBooking(booking.id, { paid: !booking.paid })}>{booking.paid ? <Check size={12} /> : <Clock3 size={12} />}{booking.paid ? "Opłacona" : "Do opłacenia"}</button></header>
                        <span>{bookingLabels[booking.type]} · {booking.provider}</span>
                        <h3>{booking.title}</h3>
                        <p><CalendarDays size={14} /> {bookingDate(booking.startAt)}</p>
                        <footer><div><small>Numer rezerwacji</small><code>{booking.reference || "—"}</code></div><strong>{formatMoney(booking.amountMinor, selectedTrip.currency, hideAmounts)}</strong><button className="icon-button module-danger-icon" type="button" onClick={() => { if (window.confirm(`Usunąć rezerwację „${booking.title}”?`)) { deleteTripBooking(booking.id); onToast("Rezerwacja została usunięta"); } }} aria-label={`Usuń rezerwację ${booking.title}`}><Trash2 size={14} /></button></footer>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="trips-section-empty"><TicketCheck size={25} /><h3>Nie ma jeszcze rezerwacji</h3><p>Dodaj transport, nocleg lub atrakcję wraz z numerem potwierdzenia.</p><button className="button button--soft" type="button" onClick={() => setBookingModalOpen(true)}><Plus size={15} /> Dodaj rezerwację</button></div>
              )}
            </section>
          )}

          {view === "budget" && (
            <div className="trips-budget-grid">
              <section className="panel trips-budget-card">
                <header>
                  <div><span className="section-kicker"><WalletCards size={14} /> Kontrola kosztów</span><h2>Budżet wyjazdu</h2></div>
                  <button className="icon-button" type="button" onClick={toggleHideAmounts} aria-label={hideAmounts ? "Pokaż kwoty" : "Ukryj kwoty"}>{hideAmounts ? <Eye size={18} /> : <EyeOff size={18} />}</button>
                </header>
                <div className="trips-budget-card__total"><span>Zaplanowano</span><strong>{formatMoney(plannedTotal, selectedTrip.currency, hideAmounts)}</strong><small>{hasBudget ? `z ${formatMoney(selectedTrip.budgetMinor ?? 0, selectedTrip.currency, hideAmounts)}` : "bez ustalonego budżetu"}</small></div>
                <div className="trips-budget-meter"><span style={{ width: `${budgetProgress}%` }} /><i style={{ left: `${Math.min(100, budgetProgress)}%` }} /></div>
                <div className="trips-budget-card__stats">
                  <div><span>Opłacono</span><strong>{formatMoney(paidTotal, selectedTrip.currency, hideAmounts)}</strong></div>
                  {hasBudget && <div className={isOverBudget ? "is-over" : ""}><span>{isOverBudget ? "Ponad budżet" : "Zostało"}</span><strong>{formatMoney(Math.abs(remainingBudget), selectedTrip.currency, hideAmounts)}</strong></div>}
                </div>
              </section>

              <section className="panel trips-budget-breakdown">
                <header className="panel__header panel__header--compact"><div><span className="section-kicker"><Banknote size={14} /> Kategorie</span><h2>Struktura kosztów</h2></div></header>
                <div>
                  {budgetBreakdown.map(([label, value], index) => (
                    <article key={label}>
                      <span className={`trips-budget-dot trips-budget-dot--${index % 5}`} />
                      <div><strong>{label}</strong><span><i style={{ width: `${plannedTotal ? Math.max(4, (value / plannedTotal) * 100) : 0}%` }} /></span></div>
                      <strong>{formatMoney(value, selectedTrip.currency, hideAmounts)}</strong>
                    </article>
                  ))}
                  {!budgetBreakdown.length && <div className="trips-budget-empty">Koszty pojawią się tutaj po dodaniu ich do planu.</div>}
                </div>
              </section>
            </div>
          )}

          {view === "packing" && (
            <section className="panel trips-section trips-packing">
              <header className="trips-section__header">
                <div><span className="section-kicker"><BaggageClaim size={14} /> Lista rzeczy</span><h2>Pakowanie</h2><p>Wspólna lista z jasnym podziałem, kto zabiera co.</p></div>
                <div className="trips-packing__progress"><span><i style={{ width: `${packingProgress}%` }} /></span><strong>{packingProgress}%</strong></div>
              </header>
              <form className="trips-packing-add" onSubmit={addPacking}>
                <label><span className="sr-only">Nazwa rzeczy</span><input value={packingName} onChange={(event) => setPackingName(event.target.value)} placeholder="Co trzeba spakować?" /></label>
                <label><span className="sr-only">Kategoria</span><select value={packingCategory} onChange={(event) => setPackingCategory(event.target.value as PackingItem["category"])}>{Object.entries(packingLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label><span className="sr-only">Osoba</span><select value={packingAssignee} onChange={(event) => setPackingAssignee(event.target.value)}><option value="">Bez przypisania</option>{selectedTrip.travelers.map((traveler) => <option value={traveler} key={traveler}>{traveler}</option>)}</select></label>
                <button className="button button--primary button--small" type="submit" disabled={!packingName.trim()}><Plus size={15} /> Dodaj</button>
              </form>
              <div className="trips-packing-groups">
                {(Object.keys(packingLabels) as PackingItem["category"][]).map((category) => {
                  const items = packing.filter((item) => item.category === category);
                  if (!items.length) return null;
                  return (
                    <section key={category}>
                      <header><strong>{packingLabels[category]}</strong><span>{items.filter((item) => item.packed).length}/{items.length}</span></header>
                      <div>
                        {items.map((item) => (
                          <button className={item.packed ? "trips-pack-item trips-pack-item--done" : "trips-pack-item"} type="button" key={item.id} onClick={() => togglePackingItem(item.id)} aria-pressed={item.packed}>
                            <span>{item.packed ? <Check size={15} /> : <Circle size={15} />}</span>
                            <strong>{item.name}</strong>
                            {item.assignedTo && <small><span>{item.assignedTo.charAt(0)}</span>{item.assignedTo}</small>}
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
                {!packing.length && <div className="trips-section-empty"><Luggage size={25} /><h3>Lista jest jeszcze pusta</h3><p>Dodaj pierwszą rzecz powyżej. Współtowarzysze zobaczą ją od razu.</p></div>}
              </div>
            </section>
          )}
        </main>
      </div>

      <NewTripModal
        open={tripModalOpen}
        onClose={() => setTripModalOpen(false)}
        ownerId={currentOwnerId}
        onCreate={(trip) => {
          const id = addTrip(trip);
          setSelectedTripId(id);
          setView("overview");
          setTripModalOpen(false);
          onToast("Podróż została utworzona");
        }}
      />

      <NewItineraryModal
        open={itineraryModalOpen}
        onClose={() => setItineraryModalOpen(false)}
        trip={selectedTrip}
        initialDate={itineraryDate || selectedTrip.startDate}
        onCreate={(item) => {
          addTripItineraryItem(item);
          updateTrip(selectedTrip.id, { progress: Math.min(95, selectedTrip.progress + 3) });
          setItineraryModalOpen(false);
          onToast("Punkt został dodany do planu");
        }}
      />
      <NewBookingModal
        open={bookingModalOpen}
        onClose={() => setBookingModalOpen(false)}
        trip={selectedTrip}
        itinerary={itinerary}
        onCreate={(booking) => {
          addTripBooking(booking);
          updateTrip(selectedTrip.id, { progress: Math.min(98, selectedTrip.progress + 5) });
          setBookingModalOpen(false);
          onToast("Rezerwacja została dodana");
        }}
      />
      <EditTripModal
        open={editTripModalOpen}
        onClose={() => setEditTripModalOpen(false)}
        trip={selectedTrip}
        onSave={(changes) => {
          if (changes.travelers) {
            const renameMap = new Map<string, string>();
            selectedTrip.travelers.forEach((oldName, index) => {
              const newName = changes.travelers?.[index];
              if (newName && newName !== oldName) renameMap.set(oldName, newName);
            });
            if (renameMap.size) {
              useAdvancedStore.setState((state) => ({
                packingItems: state.packingItems.map((item) =>
                  item.tripId === selectedTrip.id && item.assignedTo && renameMap.has(item.assignedTo)
                    ? { ...item, assignedTo: renameMap.get(item.assignedTo), updatedAt: new Date().toISOString() }
                    : item,
                ),
              }));
            }
          }
          updateTrip(selectedTrip.id, changes);
          setEditTripModalOpen(false);
          onToast("Plan podróży został zaktualizowany");
        }}
      />
    </div>
  );
}

interface NewTripModalProps {
  open: boolean;
  onClose: () => void;
  ownerId: string;
  onCreate: (trip: Omit<Trip, "id" | "updatedAt">) => void;
}

function NewTripModal({ open, onClose, ownerId, onCreate }: NewTripModalProps) {
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
    onCreate({
      name: String(form.get("name")).trim(),
      destination: String(form.get("destination")).trim(),
      startDate,
      endDate,
      status,
      budgetMinor: String(form.get("budget")).trim() ? Math.abs(parseMoneyToMinor(String(form.get("budget")))) : undefined,
      currency: String(form.get("currency")) as CurrencyCode,
      travelers: String(form.get("travelers")).split(",").map((name) => name.trim()).filter(Boolean),
      progress: status === "idea" ? 5 : 12,
      accent: String(form.get("accent")) as Trip["accent"],
      notes: String(form.get("notes")).trim(),
      ownerId,
      visibility: String(form.get("visibility")) as Visibility,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Nowa podróż" eyebrow="Zacznij od kierunku" size="large">
      <form className="trips-modal-form" onSubmit={submit}>
        <div className="form-grid form-grid--2">
          <label className="field field--prominent"><span>Nazwa wyjazdu</span><input name="name" placeholder="np. Toskania 2026" required autoFocus /></label>
          <label className="field field--prominent"><span>Kierunek</span><input name="destination" placeholder="Miasto, region lub trasa" required /></label>
        </div>
        <div className="form-grid form-grid--3">
          <label className="field"><span>Wyjazd</span><input type="date" name="startDate" min={today} defaultValue={today} required /></label>
          <label className="field"><span>Powrót</span><input type="date" name="endDate" min={today} defaultValue={today} required /></label>
          <label className="field"><span>Etap</span><select name="status" defaultValue="planning">{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </div>
        <div className="form-grid form-grid--3">
          <label className="field"><span>Budżet</span><input name="budget" inputMode="decimal" placeholder="5 000" /></label>
          <label className="field"><span>Waluta</span><select name="currency" defaultValue="PLN"><option>PLN</option><option>EUR</option><option>USD</option><option>GBP</option></select></label>
          <label className="field"><span>Widoczność</span><select name="visibility" defaultValue="household"><option value="household">Cały dom</option><option value="private">Tylko ja</option></select></label>
        </div>
        <label className="field"><span>Podróżujący <small>— oddziel przecinkami</small></span><input name="travelers" defaultValue="Ty" placeholder="Ty, Anna" required /></label>
        <div className="form-grid form-grid--2">
          <label className="field"><span>Kolor planu</span><select name="accent" defaultValue="ocean"><option value="ocean">Oceaniczny</option><option value="terracotta">Terakota</option><option value="forest">Leśny</option><option value="violet">Fioletowy</option></select></label>
          <label className="field"><span>Krótka intencja</span><input name="notes" placeholder="Jak ma wyglądać ten wyjazd?" /></label>
        </div>
        <div className="trips-form-hint"><Sparkles size={16} /><span>Po utworzeniu zaczniesz od planu dnia, rezerwacji i wspólnej listy pakowania.</span></div>
        <div className="modal-actions"><span /><div><button className="button button--ghost" type="button" onClick={onClose}>Anuluj</button><button className="button button--primary" type="submit"><Plane size={16} /> Utwórz podróż</button></div></div>
      </form>
    </Modal>
  );
}

interface NewItineraryModalProps {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  initialDate: string;
  onCreate: (item: Omit<TripItineraryItem, "id" | "updatedAt">) => void;
}

function NewItineraryModal({ open, onClose, trip, initialDate, onCreate }: NewItineraryModalProps) {
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
        <label className="field field--prominent"><span>Co planujesz?</span><input name="title" placeholder="np. Odbiór samochodu" required autoFocus /></label>
        <div className="form-grid form-grid--3">
          <label className="field"><span>Dzień</span><input type="date" name="date" min={trip.startDate} max={trip.endDate} defaultValue={initialDate} required /></label>
          <label className="field"><span>Godzina</span><input type="time" name="time" defaultValue="10:00" required /></label>
          <label className="field"><span>Rodzaj</span><select name="type" defaultValue="activity">{Object.entries(itineraryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </div>
        <div className="form-grid form-grid--2">
          <label className="field"><span>Miejsce</span><input name="location" placeholder="Adres lub punkt spotkania" /></label>
          <label className="field"><span>Koszt ({trip.currency})</span><input name="cost" inputMode="decimal" placeholder="0,00" /></label>
        </div>
        <label className="field"><span>Notatka</span><textarea name="notes" placeholder="Numer peronu, godzina zameldowania, co zabrać…" /></label>
        <label className="trips-check-field"><input type="checkbox" name="booked" /><span><CheckCircle2 size={17} /><strong>Mam potwierdzenie lub rezerwację</strong><small>Oznacz punkt jako zabezpieczony.</small></span></label>
        <div className="modal-actions"><span /><div><button className="button button--ghost" type="button" onClick={onClose}>Anuluj</button><button className="button button--primary" type="submit"><Plus size={16} /> Dodaj do planu</button></div></div>
      </form>
    </Modal>
  );
}

interface NewBookingModalProps {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  itinerary: TripItineraryItem[];
  onCreate: (booking: Omit<TripBooking, "id" | "updatedAt">) => void;
}

function NewBookingModal({ open, onClose, trip, itinerary, onCreate }: NewBookingModalProps) {
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
        <div className="form-grid form-grid--2"><label className="field field--prominent"><span>Nazwa</span><input autoFocus required name="title" placeholder="np. Lot Warszawa → Rzym" /></label><label className="field"><span>Rodzaj</span><select name="type" defaultValue="stay">{Object.entries(bookingLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
        <div className="form-grid form-grid--2"><label className="field"><span>Dostawca</span><input required name="provider" placeholder="Linia, hotel lub operator" /></label><label className="field"><span>Numer rezerwacji</span><input name="reference" placeholder="Opcjonalnie" /></label></div>
        <label className="field"><span>Powiązany punkt planu</span><select name="itineraryItemId" defaultValue=""><option value="">Brak — osobny koszt</option>{itinerary.map((item) => <option value={item.id} key={item.id}>{item.date} · {item.title}</option>)}</select></label>
        <div className="form-grid form-grid--3"><label className="field"><span>Data</span><input required type="date" name="date" min={trip.startDate} max={trip.endDate} defaultValue={trip.startDate} /></label><label className="field"><span>Godzina</span><input required type="time" name="time" defaultValue="12:00" /></label><label className="field"><span>Koszt ({trip.currency})</span><input name="amount" inputMode="decimal" placeholder="0,00" /></label></div>
        <label className="field"><span><input type="checkbox" name="paid" /> Opłacona</span></label>
        <div className="modal-actions"><span /><div><button className="button button--ghost" type="button" onClick={onClose}>Anuluj</button><button className="button button--primary" type="submit"><TicketCheck size={15} /> Dodaj rezerwację</button></div></div>
      </form>
    </Modal>
  );
}

function EditTripModal({ open, onClose, trip, onSave }: { open: boolean; onClose: () => void; trip: Trip; onSave: (changes: Partial<Trip>) => void }) {
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
      name: String(form.get("name")).trim(), destination: String(form.get("destination")).trim(),
      startDate, endDate,
      budgetMinor: String(form.get("budget")).trim() ? Math.abs(parseMoneyToMinor(String(form.get("budget")))) : undefined,
      currency: String(form.get("currency")) as CurrencyCode,
      travelers: String(form.get("travelers")).split(",").map((value) => value.trim()).filter(Boolean),
      visibility: String(form.get("visibility")) as Visibility,
      accent: String(form.get("accent")) as Trip["accent"], notes: String(form.get("notes")).trim(),
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
      String(data.get("travelers")).split(",").map((value) => value.trim()).filter(Boolean).join(", ") !== trip.travelers.join(", ") ||
      String(data.get("visibility")) !== trip.visibility ||
      String(data.get("accent")) !== trip.accent ||
      String(data.get("notes")).trim() !== trip.notes
    );
  };
  const confirmDiscardChanges = () =>
    !hasUnsavedChanges() || window.confirm("Masz niezapisane zmiany w podróży. Czy na pewno chcesz je odrzucić?");
  return (
    <Modal open={open} onClose={onClose} confirmClose={confirmDiscardChanges} title="Edytuj podróż" eyebrow={trip.name} size="large">
      <form ref={formRef} className="trips-modal-form" onSubmit={submit} key={trip.id}>
        <div className="form-grid form-grid--2"><label className="field"><span>Nazwa</span><input autoFocus required name="name" defaultValue={trip.name} /></label><label className="field"><span>Kierunek</span><input required name="destination" defaultValue={trip.destination} /></label></div>
        <div className="form-grid form-grid--2"><label className="field"><span>Wyjazd</span><input required type="date" name="startDate" defaultValue={trip.startDate} /></label><label className="field"><span>Powrót</span><input required type="date" name="endDate" defaultValue={trip.endDate} /></label></div>
        <div className="form-grid form-grid--3"><label className="field"><span>Budżet</span><input name="budget" inputMode="decimal" placeholder="Bez ustalonego budżetu" defaultValue={trip.budgetMinor !== undefined ? trip.budgetMinor / 100 : ""} /></label><label className="field"><span>Waluta</span><select name="currency" defaultValue={trip.currency}><option>PLN</option><option>EUR</option><option>USD</option><option>GBP</option></select></label><label className="field"><span>Widoczność</span><select name="visibility" defaultValue={trip.visibility}><option value="household">Domownicy</option><option value="private">Tylko ja</option></select></label></div>
        <label className="field"><span>Podróżujący</span><input required name="travelers" defaultValue={trip.travelers.join(", ")} /></label>
        <div className="form-grid form-grid--2"><label className="field"><span>Kolor</span><select name="accent" defaultValue={trip.accent}><option value="ocean">Oceaniczny</option><option value="terracotta">Terakota</option><option value="forest">Leśny</option><option value="violet">Fioletowy</option></select></label><label className="field"><span>Notatka</span><input name="notes" defaultValue={trip.notes} /></label></div>
        <div className="modal-actions"><span /><div><button className="button button--ghost" type="button" onClick={() => { if (confirmDiscardChanges()) onClose(); }}>Anuluj</button><button className="button button--primary" type="submit">Zapisz zmiany</button></div></div>
      </form>
    </Modal>
  );
}
