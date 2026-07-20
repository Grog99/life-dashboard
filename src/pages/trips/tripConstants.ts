import {
  BedDouble,
  Car,
  Compass,
  Ellipsis,
  Luggage,
  Plane,
  Route,
  TicketCheck,
  TrainFront,
  Utensils,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { format, isValid, parseISO } from "date-fns";
import { pl } from "date-fns/locale";
import type { PackingItem, Trip, TripBooking, TripItineraryItem } from "../../advancedTypes";

export type TripView = "overview" | "itinerary" | "bookings" | "budget" | "packing";

export const statusLabels: Record<Trip["status"], string> = {
  idea: "Pomysł",
  planning: "W planowaniu",
  active: "W trakcie",
  archived: "Archiwum",
};

export const itineraryLabels: Record<TripItineraryItem["type"], string> = {
  transport: "Transport",
  stay: "Nocleg",
  activity: "Atrakcja",
  food: "Jedzenie",
  other: "Inne",
};

export const itineraryIcons: Record<TripItineraryItem["type"], LucideIcon> = {
  transport: TrainFront,
  stay: BedDouble,
  activity: Compass,
  food: Utensils,
  other: Ellipsis,
};

export const bookingLabels: Record<TripBooking["type"], string> = {
  flight: "Loty",
  train: "Pociągi",
  stay: "Noclegi",
  car: "Samochód",
  activity: "Atrakcje",
};

export const bookingIcons: Record<TripBooking["type"], LucideIcon> = {
  flight: Plane,
  train: TrainFront,
  stay: BedDouble,
  car: Car,
  activity: TicketCheck,
};

export const packingLabels: Record<PackingItem["category"], string> = {
  documents: "Dokumenty",
  clothes: "Ubrania",
  electronics: "Elektronika",
  health: "Zdrowie",
  other: "Pozostałe",
};

export const tripViews: Array<{ id: TripView; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Przegląd", icon: Compass },
  { id: "itinerary", label: "Plan podróży", icon: Route },
  { id: "bookings", label: "Rezerwacje", icon: TicketCheck },
  { id: "budget", label: "Budżet", icon: WalletCards },
  { id: "packing", label: "Pakowanie", icon: Luggage },
];

export const capitalize = (value: string) =>
  value.charAt(0).toLocaleUpperCase("pl") + value.slice(1);

export function safeDate(value: string): Date | null {
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

export function tripDateRange(trip: Trip): string {
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

export function bookingDate(value: string): string {
  const parsed = safeDate(value);
  return parsed ? capitalize(format(parsed, "EEEE, d MMM · HH:mm", { locale: pl })) : value;
}
