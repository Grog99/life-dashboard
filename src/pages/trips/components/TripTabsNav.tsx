import { tripViews, type TripView } from "../tripConstants";

interface TripTabsNavProps {
  view: TripView;
  onChange: (view: TripView) => void;
  bookingsCount: number;
  packedCount: number;
  packingCount: number;
}

export function TripTabsNav({
  view,
  onChange,
  bookingsCount,
  packedCount,
  packingCount,
}: TripTabsNavProps) {
  return (
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
            onClick={() => onChange(item.id)}
          >
            <Icon size={16} /> {item.label}
            {item.id === "bookings" && bookingsCount > 0 && <span>{bookingsCount}</span>}
            {item.id === "packing" && packingCount > 0 && (
              <span>
                {packedCount}/{packingCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
