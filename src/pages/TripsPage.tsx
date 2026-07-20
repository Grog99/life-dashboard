import { Globe2, Plus } from "lucide-react";
import { differenceInCalendarDays, eachDayOfInterval } from "date-fns";
import { useMemo, useState, type FormEvent } from "react";
import type { PackingItem, Trip, TripBooking, TripItineraryItem } from "../advancedTypes";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useTripsStore } from "../store/useTripsStore";
import { bookingLabels, safeDate, type TripView } from "./trips/tripConstants";
import { TripsEmptyState } from "./trips/components/TripsEmptyState";
import { TripsSidebar } from "./trips/components/TripsSidebar";
import { TripHero } from "./trips/components/TripHero";
import { TripTabsNav } from "./trips/components/TripTabsNav";
import { TripOverview } from "./trips/components/TripOverview";
import { TripItineraryView } from "./trips/components/TripItineraryView";
import { TripBookingsView } from "./trips/components/TripBookingsView";
import { TripBudgetView } from "./trips/components/TripBudgetView";
import { TripPackingView } from "./trips/components/TripPackingView";
import { NewTripModal } from "./trips/components/NewTripModal";
import { NewItineraryModal } from "./trips/components/NewItineraryModal";
import { NewBookingModal } from "./trips/components/NewBookingModal";
import { EditTripModal } from "./trips/components/EditTripModal";
import "../styles/trips.css";

export interface TripsPageProps {
  onToast?: (message: string) => void;
}

export function TripsPage({ onToast = () => undefined }: TripsPageProps) {
  const trips = useTripsStore((state) => state.trips);
  const tripItinerary = useTripsStore((state) => state.itinerary);
  const tripBookings = useTripsStore((state) => state.bookings);
  const packingItems = useTripsStore((state) => state.packing);
  const hideAmounts = useAdvancedStore((state) => state.hideAmounts);
  const toggleHideAmounts = useAdvancedStore((state) => state.toggleHideAmounts);
  const addTrip = useTripsStore((state) => state.addTrip);
  const updateTrip = useTripsStore((state) => state.updateTrip);
  const deleteTrip = useTripsStore((state) => state.deleteTrip);
  const addTripItineraryItem = useTripsStore((state) => state.addTripItineraryItem);
  const deleteTripItineraryItem = useTripsStore((state) => state.deleteTripItineraryItem);
  const addTripBooking = useTripsStore((state) => state.addTripBooking);
  const updateTripBooking = useTripsStore((state) => state.updateTripBooking);
  const deleteTripBooking = useTripsStore((state) => state.deleteTripBooking);
  const togglePackingItem = useTripsStore((state) => state.togglePackingItem);
  const addPackingItem = useTripsStore((state) => state.addPackingItem);
  const updatePackingItem = useTripsStore((state) => state.updatePackingItem);

  const sortedTrips = useMemo(
    () =>
      [...trips].sort((a, b) => {
        const order: Record<Trip["status"], number> = {
          active: 0,
          planning: 1,
          idea: 2,
          archived: 3,
        };
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
    () =>
      tripItinerary
        .filter((item) => item.tripId === selectedTrip?.id)
        .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)),
    [selectedTrip?.id, tripItinerary],
  );
  const bookings = useMemo(
    () =>
      tripBookings
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
      <TripsEmptyState
        open={tripModalOpen}
        onOpenModal={() => setTripModalOpen(true)}
        onClose={() => setTripModalOpen(false)}
        onCreate={(trip) => {
          const id = addTrip(trip);
          setSelectedTripId(id);
          setTripModalOpen(false);
          onToast("Podróż została utworzona");
        }}
      />
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
  const budgetProgress =
    hasBudget && selectedTrip.budgetMinor
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

  const deleteItineraryItem = (item: TripItineraryItem) => {
    if (window.confirm(`Usunąć „${item.title}” z planu?`)) {
      deleteTripItineraryItem(item.id);
      onToast("Punkt został usunięty z planu");
    }
  };

  const toggleBookingPaid = (booking: TripBooking) => {
    updateTripBooking(booking.id, { paid: !booking.paid });
  };

  const removeBooking = (booking: TripBooking) => {
    if (window.confirm(`Usunąć rezerwację „${booking.title}”?`)) {
      deleteTripBooking(booking.id);
      onToast("Rezerwacja została usunięta");
    }
  };

  const saveTripNotes = (notes: string) => {
    updateTrip(selectedTrip.id, { notes });
    onToast("Notatki zapisane");
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
      ? {
          label: `Spakuj pozostałe rzeczy (${packing.length - packedCount})`,
          view: "packing" as TripView,
        }
      : null,
    isOverBudget ? { label: "Sprawdź przekroczony budżet", view: "budget" as TripView } : null,
  ]
    .filter((item): item is { label: string; view: TripView } => Boolean(item))
    .slice(0, 3);

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
          <span className="page-eyebrow">
            <Globe2 size={14} /> Podróże
          </span>
          <h1>Planer podróży</h1>
          <p>Trasa, rezerwacje, wydatki i pakowanie — wszystko gotowe przed wyjazdem.</p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() => setTripModalOpen(true)}
        >
          <Plus size={17} /> Nowa podróż
        </button>
      </header>

      <div className="trips-workspace">
        <TripsSidebar
          sortedTrips={sortedTrips}
          activeTripId={selectedTrip.id}
          activeCount={trips.filter((trip) => trip.status !== "archived").length}
          onSwitch={switchTrip}
          onAdd={() => setTripModalOpen(true)}
        />

        <main className="trips-detail">
          <TripHero
            trip={selectedTrip}
            duration={duration}
            untilStart={untilStart}
            onStatusChange={(status) => updateTrip(selectedTrip.id, { status })}
            onEdit={() => setEditTripModalOpen(true)}
          />

          <TripTabsNav
            view={view}
            onChange={setView}
            bookingsCount={bookings.length}
            packedCount={packedCount}
            packingCount={packing.length}
          />

          {view === "overview" && (
            <TripOverview
              trip={selectedTrip}
              confirmedBookings={confirmedBookings}
              bookingsCount={bookings.length}
              plannedTotal={plannedTotal}
              hasBudget={hasBudget}
              hideAmounts={hideAmounts}
              packingProgress={packingProgress}
              packedCount={packedCount}
              packingCount={packing.length}
              nextSteps={nextSteps}
              itinerary={itinerary}
              onNavigate={setView}
              onAddItinerary={() => openItineraryModal()}
              onSaveNotes={saveTripNotes}
            />
          )}

          {view === "itinerary" && (
            <TripItineraryView
              tripDays={tripDays}
              itinerary={itinerary}
              currency={selectedTrip.currency}
              hideAmounts={hideAmounts}
              onAddItinerary={(date) => openItineraryModal(date)}
              onDeleteItem={deleteItineraryItem}
            />
          )}

          {view === "bookings" && (
            <TripBookingsView
              bookings={bookings}
              currency={selectedTrip.currency}
              hideAmounts={hideAmounts}
              confirmedCount={confirmedBookings}
              onTogglePaid={toggleBookingPaid}
              onDelete={removeBooking}
              onAdd={() => setBookingModalOpen(true)}
            />
          )}

          {view === "budget" && (
            <TripBudgetView
              plannedTotal={plannedTotal}
              hasBudget={hasBudget}
              budgetMinor={selectedTrip.budgetMinor}
              currency={selectedTrip.currency}
              hideAmounts={hideAmounts}
              budgetProgress={budgetProgress}
              paidTotal={paidTotal}
              isOverBudget={isOverBudget}
              remainingBudget={remainingBudget}
              budgetBreakdown={budgetBreakdown}
              onToggleHideAmounts={toggleHideAmounts}
            />
          )}

          {view === "packing" && (
            <TripPackingView
              packing={packing}
              packingProgress={packingProgress}
              travelers={selectedTrip.travelers}
              packingName={packingName}
              setPackingName={setPackingName}
              packingCategory={packingCategory}
              setPackingCategory={setPackingCategory}
              packingAssignee={packingAssignee}
              setPackingAssignee={setPackingAssignee}
              onAdd={addPacking}
              onToggle={togglePackingItem}
            />
          )}
        </main>
      </div>

      <NewTripModal
        open={tripModalOpen}
        onClose={() => setTripModalOpen(false)}
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
          // Serwer liczy `progress` autorytatywnie z liczby dzieci (docs/plans/podroze-trips.md
          // "Projekt progress") -- klient go już nie nadpisuje ręcznie po dodaniu punktu planu.
          addTripItineraryItem(item);
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
              // Masowa zmiana nazwy podróżnika przepisuje `assignedTo` na dotkniętych pozycjach
              // pakowania -- seria `packing.update` na nowym store zamiast bezpośredniej mutacji
              // dokumentu (docs/plans/podroze-trips.md "Ops mutacji").
              packing
                .filter((item) => item.assignedTo && renameMap.has(item.assignedTo))
                .forEach((item) => {
                  updatePackingItem(item.id, { assignedTo: renameMap.get(item.assignedTo!) });
                });
            }
          }
          updateTrip(selectedTrip.id, changes);
          setEditTripModalOpen(false);
          onToast("Plan podróży został zaktualizowany");
        }}
        onDelete={() => {
          if (window.confirm(`Usunąć podróż „${selectedTrip.name}” wraz z całym planem?`)) {
            deleteTrip(selectedTrip.id);
            setEditTripModalOpen(false);
            onToast("Podróż została usunięta");
          }
        }}
      />
    </div>
  );
}
