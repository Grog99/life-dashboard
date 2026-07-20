import { CalendarDays, MapPin, Plus } from "lucide-react";
import type { Trip } from "../../../advancedTypes";
import { statusLabels, tripDateRange } from "../tripConstants";

interface TripsSidebarProps {
  sortedTrips: Trip[];
  activeTripId: string;
  activeCount: number;
  onSwitch: (tripId: string) => void;
  onAdd: () => void;
}

export function TripsSidebar({ sortedTrips, activeTripId, activeCount, onSwitch, onAdd }: TripsSidebarProps) {
  return (
    <aside className="panel trips-list" aria-label="Twoje podróże">
      <header>
        <div>
          <span>Twoje podróże</span>
          <strong>{activeCount} aktywne plany</strong>
        </div>
        <button className="trips-list__add" type="button" onClick={onAdd} aria-label="Dodaj podróż">
          <Plus size={17} />
        </button>
      </header>
      <div className="trips-list__items">
        {sortedTrips.map((trip) => (
          <button
            className={`trip-card trip-card--${trip.accent} ${trip.id === activeTripId ? "trip-card--active" : ""}`}
            type="button"
            key={trip.id}
            onClick={() => onSwitch(trip.id)}
            aria-pressed={trip.id === activeTripId}
          >
            <span className="trip-card__route">
              <MapPin size={15} />
            </span>
            <span className="trip-card__content">
              <span className="trip-card__topline">
                <small>{statusLabels[trip.status]}</small>
                <small>{trip.progress}%</small>
              </span>
              <strong>{trip.name}</strong>
              <span>{trip.destination}</span>
              <span className="trip-card__date">
                <CalendarDays size={13} /> {tripDateRange(trip)}
              </span>
              <span className="trip-card__progress">
                <i style={{ width: `${trip.progress}%` }} />
              </span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
