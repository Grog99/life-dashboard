import {
  CalendarDays,
  CheckSquare2,
  Command,
  LayoutDashboard,
  Leaf,
  HeartPulse,
  NotebookPen,
  PawPrint,
  Plus,
  Search,
  Settings,
  WalletCards,
  Plane,
  Repeat2,
  Utensils,
  CarFront,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLifeStore } from "../store/useLifeStore";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useFinanceStore } from "../store/useFinanceStore";
import { useTripsStore } from "../store/useTripsStore";
import { lockBodyScroll } from "../lib/scrollLock";
import type { ViewId } from "../types";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onQuickAdd: () => void;
}

const destinations: Array<{
  view: ViewId;
  label: string;
  icon: typeof LayoutDashboard;
  keywords: string;
}> = [
  {
    view: "today",
    label: "Przejdź do: Dzisiaj",
    icon: LayoutDashboard,
    keywords: "dzisiaj dashboard plan",
  },
  {
    view: "tasks",
    label: "Przejdź do: Zadania",
    icon: CheckSquare2,
    keywords: "zadania lista skrzynka",
  },
  {
    view: "calendar",
    label: "Przejdź do: Kalendarz",
    icon: CalendarDays,
    keywords: "kalendarz wydarzenia tydzień",
  },
  { view: "notes", label: "Przejdź do: Notatki", icon: NotebookPen, keywords: "notatki pomysły" },
  { view: "habits", label: "Przejdź do: Rytuały", icon: Leaf, keywords: "rytuały nawyki" },
  {
    view: "finance",
    label: "Przejdź do: Finanse",
    icon: WalletCards,
    keywords: "finanse budżet transakcje konta",
  },
  {
    view: "trips",
    label: "Przejdź do: Podróże",
    icon: Plane,
    keywords: "podróże wakacje wyjazdy plan",
  },
  {
    view: "subscriptions",
    label: "Przejdź do: Subskrypcje",
    icon: Repeat2,
    keywords: "subskrypcje abonamenty odnowienia",
  },
  {
    view: "meals",
    label: "Przejdź do: Posiłki",
    icon: Utensils,
    keywords: "posiłki przepisy zakupy jadłospis",
  },
  {
    view: "car",
    label: "Przejdź do: Samochód",
    icon: CarFront,
    keywords: "samochód auto serwis paliwo",
  },
  {
    view: "pets",
    label: "Przejdź do: Zwierzęta",
    icon: PawPrint,
    keywords: "zwierzęta pies kot królik akwarium weterynarz",
  },
  {
    view: "health",
    label: "Przejdź do: Zdrowie",
    icon: HeartPulse,
    keywords: "zdrowie lekarz wizyty leki pomiary badania",
  },
  {
    view: "settings",
    label: "Przejdź do: Ustawienia",
    icon: Settings,
    keywords: "ustawienia motyw dane",
  },
];

export function CommandPalette({ open, onClose, onNavigate, onQuickAdd }: CommandPaletteProps) {
  const tasks = useLifeStore((state) => state.tasks);
  const notes = useLifeStore((state) => state.notes);
  const events = useLifeStore((state) => state.events);
  const financeTransactions = useFinanceStore((state) => state.transactions);
  const trips = useTripsStore((state) => state.trips);
  const subscriptions = useAdvancedStore((state) => state.subscriptions);
  const recipes = useAdvancedStore((state) => state.recipes);
  const vehicles = useAdvancedStore((state) => state.vehicles);
  const pets = useAdvancedStore((state) => state.pets);
  const healthAppointments = useAdvancedStore((state) => state.healthAppointments);
  const medications = useAdvancedStore((state) => state.medications);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    setQuery("");
    window.setTimeout(() => inputRef.current?.focus(), 20);
    const unlockScroll = lockBodyScroll();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !paletteRef.current) return;
      const focusable = Array.from(
        paletteRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled])",
        ),
      ).filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
      unlockScroll();
    };
  }, [onClose, open]);

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pl");
    if (!normalized) return [];
    return [
      ...tasks
        .filter((task) =>
          `${task.title} ${task.category}`.toLocaleLowerCase("pl").includes(normalized),
        )
        .slice(0, 3)
        .map((task) => ({
          id: task.id,
          label: task.title,
          meta: `Zadanie · ${task.category}`,
          view: "tasks" as ViewId,
          icon: CheckSquare2,
        })),
      ...events
        .filter((event) => event.title.toLocaleLowerCase("pl").includes(normalized))
        .slice(0, 3)
        .map((event) => ({
          id: event.id,
          label: event.title,
          meta: `Wydarzenie · ${event.date}`,
          view: "calendar" as ViewId,
          icon: CalendarDays,
        })),
      ...notes
        .filter((note) =>
          `${note.title} ${note.content}`.toLocaleLowerCase("pl").includes(normalized),
        )
        .slice(0, 3)
        .map((note) => ({
          id: note.id,
          label: note.title,
          meta: "Notatka",
          view: "notes" as ViewId,
          icon: NotebookPen,
        })),
      ...financeTransactions
        .filter((item) =>
          `${item.title} ${item.merchant} ${item.category}`
            .toLocaleLowerCase("pl")
            .includes(normalized),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id,
          label: item.title,
          meta: `Finanse · ${item.category}`,
          view: "finance" as ViewId,
          icon: WalletCards,
        })),
      ...trips
        .filter((item) =>
          `${item.name} ${item.destination}`.toLocaleLowerCase("pl").includes(normalized),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id,
          label: item.name,
          meta: `Podróż · ${item.destination}`,
          view: "trips" as ViewId,
          icon: Plane,
        })),
      ...subscriptions
        .filter((item) =>
          `${item.name} ${item.category}`.toLocaleLowerCase("pl").includes(normalized),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id,
          label: item.name,
          meta: "Subskrypcja",
          view: "subscriptions" as ViewId,
          icon: Repeat2,
        })),
      ...recipes
        .filter((item) =>
          `${item.name} ${item.tags.join(" ")}`.toLocaleLowerCase("pl").includes(normalized),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id,
          label: item.name,
          meta: "Przepis",
          view: "meals" as ViewId,
          icon: Utensils,
        })),
      ...vehicles
        .filter((item) =>
          `${item.name} ${item.make} ${item.model} ${item.plate}`
            .toLocaleLowerCase("pl")
            .includes(normalized),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id,
          label: item.name,
          meta: "Samochód",
          view: "car" as ViewId,
          icon: CarFront,
        })),
      ...pets
        .filter((item) =>
          `${item.name} ${item.species ?? ""}`.toLocaleLowerCase("pl").includes(normalized),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id,
          label: item.name,
          meta: "Zwierzęta",
          view: "pets" as ViewId,
          icon: PawPrint,
        })),
      ...[...healthAppointments, ...medications]
        .filter((item) =>
          ("title" in item ? item.title : item.name).toLocaleLowerCase("pl").includes(normalized),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id,
          label: "title" in item ? item.title : item.name,
          meta: "Zdrowie",
          view: "health" as ViewId,
          icon: HeartPulse,
        })),
      ...destinations
        .filter((destination) =>
          `${destination.label} ${destination.keywords}`
            .toLocaleLowerCase("pl")
            .includes(normalized),
        )
        .map((destination) => ({
          id: destination.view,
          label: destination.label,
          meta: "Widok",
          view: destination.view,
          icon: destination.icon,
        })),
    ].slice(0, 7);
  }, [
    events,
    financeTransactions,
    healthAppointments,
    medications,
    notes,
    pets,
    query,
    recipes,
    subscriptions,
    tasks,
    trips,
    vehicles,
  ]);

  const go = (view: ViewId) => {
    onNavigate(view);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="command-backdrop" onMouseDown={onClose}>
      <div
        ref={paletteRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Wyszukiwarka i komendy"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-search">
          <Search size={20} />
          <input
            ref={inputRef}
            aria-label="Szukaj w Pulsie"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && results[0]) {
                event.preventDefault();
                go(results[0].view);
              }
            }}
            placeholder="Szukaj zadań, notatek albo przejdź do widoku…"
          />
          <kbd>ESC</kbd>
          <button
            className="icon-button command-close"
            type="button"
            onClick={onClose}
            aria-label="Zamknij wyszukiwarkę"
          >
            <X size={17} />
          </button>
        </div>
        <div className="command-results">
          {query ? (
            <>
              <span className="command-section-label">Wyniki</span>
              {results.map((result) => {
                const Icon = result.icon;
                return (
                  <button
                    key={`${result.view}-${result.id}`}
                    type="button"
                    onClick={() => go(result.view)}
                  >
                    <span className="command-result-icon">
                      <Icon size={17} />
                    </span>
                    <div>
                      <strong>{result.label}</strong>
                      <small>{result.meta}</small>
                    </div>
                    <span className="command-enter">↵</span>
                  </button>
                );
              })}
              {!results.length && (
                <div className="command-empty">
                  <Search size={20} />
                  <span>Nic nie znaleziono dla „{query}”</span>
                </div>
              )}
            </>
          ) : (
            <>
              <span className="command-section-label">Szybkie akcje</span>
              <button
                type="button"
                onClick={() => {
                  onQuickAdd();
                  onClose();
                }}
              >
                <span className="command-result-icon command-result-icon--brand">
                  <Plus size={17} />
                </span>
                <div>
                  <strong>Dodaj nową rzecz</strong>
                  <small>Zadanie, wydarzenie, przypomnienie lub notatka</small>
                </div>
                <kbd>N</kbd>
              </button>
              <span className="command-section-label">Przejdź do</span>
              {destinations.map((destination) => {
                const Icon = destination.icon;
                return (
                  <button key={destination.view} type="button" onClick={() => go(destination.view)}>
                    <span className="command-result-icon">
                      <Icon size={17} />
                    </span>
                    <div>
                      <strong>{destination.label}</strong>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
        <footer className="command-footer">
          <span>
            <Command size={13} /> Puls
          </span>
          <span>Enter wybiera · Esc zamyka</span>
        </footer>
      </div>
    </div>
  );
}
