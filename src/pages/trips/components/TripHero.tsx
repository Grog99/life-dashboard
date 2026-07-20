import { CalendarDays, MapPin, Pencil, UsersRound } from "lucide-react";
import type { Trip } from "../../../advancedTypes";
import { statusLabels, tripDateRange } from "../tripConstants";

interface TripHeroProps {
  trip: Trip;
  duration: number;
  untilStart: number;
  onStatusChange: (status: Trip["status"]) => void;
  onEdit: () => void;
}

export function TripHero({ trip, duration, untilStart, onStatusChange, onEdit }: TripHeroProps) {
  return (
    <section className={`trips-hero trips-hero--${trip.accent}`}>
      <div className="trips-hero__wash" />
      <div className="trips-hero__main">
        <div className="trips-hero__badges">
          <select
            value={trip.status}
            onChange={(event) => onStatusChange(event.target.value as Trip["status"])}
            aria-label="Status podróży"
          >
            {Object.entries(statusLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
          <span>
            {/* Podróże są zawsze wspólne dla gospodarstwa -- Trip nie ma już pola
                `visibility` (docs/plans/podroze-trips.md "Odróżnianie prywatne/wspólne"). */}
            <UsersRound size={13} /> Wspólna
          </span>
          <button type="button" onClick={onEdit}>
            <Pencil size={12} /> Edytuj
          </button>
        </div>
        <span className="trips-hero__destination">
          <MapPin size={14} /> {trip.destination}
        </span>
        <h2>{trip.name}</h2>
        <p>
          <CalendarDays size={15} /> {tripDateRange(trip)} <span>·</span> {duration}{" "}
          {duration === 1 ? "dzień" : "dni"}
        </p>
        <div className="trips-hero__people">
          {trip.travelers.slice(0, 4).map((traveler, index) => (
            <span key={`${traveler}-${index}`} title={traveler}>
              {traveler.trim().charAt(0).toLocaleUpperCase("pl")}
            </span>
          ))}
          <small>{trip.travelers.join(", ")}</small>
        </div>
      </div>
      <div className="trips-hero__countdown">
        <span>
          {trip.status === "active"
            ? "Podróż trwa"
            : untilStart > 0
              ? "Do wyjazdu"
              : "Plan podróży"}
        </span>
        <strong>
          {trip.status === "active" ? duration : untilStart > 0 ? untilStart : `${trip.progress}%`}
        </strong>
        <small>
          {trip.status === "active"
            ? "dni w planie"
            : untilStart > 0
              ? untilStart === 1
                ? "dzień"
                : "dni"
              : "gotowe"}
        </small>
      </div>
    </section>
  );
}
