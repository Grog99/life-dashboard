import {
  Bell,
  CarFront,
  CalendarDays,
  CheckSquare2,
  ChevronLeft,
  Command,
  LayoutDashboard,
  Leaf,
  HeartPulse,
  Menu,
  Moon,
  NotebookPen,
  Plus,
  Plane,
  Repeat2,
  Settings,
  Sun,
  Utensils,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLifeStore } from "../store/useLifeStore";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { lockBodyScroll } from "../lib/scrollLock";
import type { Theme, ViewId } from "../types";

interface LayoutProps {
  view: ViewId;
  onViewChange: (view: ViewId) => void;
  onQuickAdd: () => void;
  onCommand: () => void;
  children: ReactNode;
}

const navigation: Array<{
  id: ViewId;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: "today", label: "Dzisiaj", icon: LayoutDashboard },
  { id: "tasks", label: "Zadania", icon: CheckSquare2 },
  { id: "calendar", label: "Kalendarz", icon: CalendarDays },
  { id: "notes", label: "Notatki", icon: NotebookPen },
  { id: "habits", label: "Rytuały", icon: Leaf },
  { id: "finance", label: "Finanse", icon: WalletCards },
  { id: "trips", label: "Podróże", icon: Plane },
  { id: "subscriptions", label: "Subskrypcje", icon: Repeat2 },
  { id: "meals", label: "Posiłki", icon: Utensils },
  { id: "car", label: "Samochód", icon: CarFront },
  { id: "health", label: "Zdrowie", icon: HeartPulse },
];

const titles: Record<ViewId, string> = {
  today: "Twój dzień",
  tasks: "Zadania",
  calendar: "Kalendarz",
  notes: "Notatki",
  habits: "Rytuały",
  finance: "Finanse",
  trips: "Podróże",
  subscriptions: "Subskrypcje",
  meals: "Posiłki",
  car: "Samochód",
  health: "Zdrowie",
  settings: "Ustawienia",
};

function nextTheme(theme: Theme): Theme {
  if (theme === "system") return "light";
  return theme === "light" ? "dark" : "system";
}

export function Layout({
  view,
  onViewChange,
  onQuickAdd,
  onCommand,
  children,
}: LayoutProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuWasOpen = useRef(false);
  const theme = useLifeStore((state) => state.preferences.theme);
  const profileName = useLifeStore((state) => state.preferences.name);
  const updatePreferences = useLifeStore((state) => state.updatePreferences);
  const reminders = useLifeStore((state) => state.reminders);
  const householdName = useAdvancedStore((state) => state.householdName);
  const householdMembers = useAdvancedStore((state) => state.householdMembers);
  const pendingReminders = reminders.filter((reminder) => !reminder.done).length;

  useEffect(() => setMobileMenuOpen(false), [view]);
  useEffect(() => {
    document.title = `${titles[view]} — Puls`;
  }, [view]);

  useEffect(() => {
    if (!mobileMenuOpen) {
      if (menuWasOpen.current) menuButtonRef.current?.focus();
      menuWasOpen.current = false;
      return;
    }
    menuWasOpen.current = true;
    closeButtonRef.current?.focus();
    const unlockScroll = lockBodyScroll();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        return;
      }
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = Array.from(
        sidebarRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])"),
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
      unlockScroll();
    };
  }, [mobileMenuOpen]);

  const changeView = (next: ViewId) => {
    onViewChange(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => mainRef.current?.focus(), 0);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Przejdź do treści</a>
      <aside ref={sidebarRef} id="app-sidebar" className={`sidebar ${mobileMenuOpen ? "sidebar--open" : ""}`}>
        <div className="brand-row">
          <button className="brand" type="button" onClick={() => changeView("today")} aria-label="Puls — przejdź do widoku Dzisiaj">
            <span className="brand__mark">P</span>
            <span>
              <strong>Puls</strong>
              <small>Twój spokojny dzień</small>
            </span>
          </button>
          <button
            ref={closeButtonRef}
            className="sidebar__close icon-button"
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Zamknij menu"
          >
            <X size={20} />
          </button>
        </div>

        <div className="household-switch" title={householdName}>
          <span className="household-switch__icon">D</span>
          <div><small>Przestrzeń</small><strong>{householdName}</strong></div>
          <div className="household-avatars">
            {householdMembers.slice(0, 3).map((member) => <span key={member.id} style={{ background: member.color }}>{member.name.charAt(0)}</span>)}
          </div>
        </div>

        <button className="quick-add-button" type="button" onClick={onQuickAdd} aria-label="Dodaj nową rzecz">
          <Plus size={18} />
          <span>Dodaj nową rzecz</span>
          <kbd>N</kbd>
        </button>

        <nav className="side-nav" aria-label="Główna nawigacja">
          <span className="side-nav__label">Planer</span>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? "active" : ""}
                type="button"
                key={item.id}
                onClick={() => changeView(item.id)}
                aria-label={item.label}
                aria-current={view === item.id ? "page" : undefined}
              >
                <Icon size={19} strokeWidth={1.9} />
                <span>{item.label}</span>
                {item.id === "today" && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__bottom">
          <div className="sidebar-insight">
            <span className="sidebar-insight__icon"><Leaf size={17} /></span>
            <div>
              <strong>Mały krok</strong>
              <p>Wybierz 3 priorytety. Reszta może poczekać.</p>
            </div>
          </div>
          <button
            className={view === "settings" ? "sidebar-settings active" : "sidebar-settings"}
            type="button"
            onClick={() => changeView("settings")}
            aria-label="Ustawienia"
            aria-current={view === "settings" ? "page" : undefined}
          >
            <Settings size={19} />
            <span>Ustawienia</span>
            <ChevronLeft className="sidebar-settings__chevron" size={17} />
          </button>
        </div>
      </aside>

      {mobileMenuOpen && (
        <button
          type="button"
          className="sidebar-overlay"
          aria-label="Zamknij menu"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar__left">
            <button
              ref={menuButtonRef}
              type="button"
              className="mobile-menu-button icon-button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Otwórz menu"
              aria-expanded={mobileMenuOpen}
              aria-controls="app-sidebar"
            >
              <Menu size={21} />
            </button>
            <div>
              <span className="topbar__eyebrow">Puls /</span>
              <strong>{titles[view]}</strong>
            </div>
          </div>

          <div className="topbar__actions">
            <button className="command-trigger" type="button" onClick={onCommand}>
              <Command size={17} />
              <span>Szukaj lub przejdź do…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              className="icon-button topbar-icon"
              type="button"
              onClick={() => updatePreferences({ theme: nextTheme(theme) })}
              aria-label={`Motyw: ${theme}`}
              title={`Motyw: ${theme}`}
            >
              {theme === "dark" ? <Moon size={19} /> : <Sun size={19} />}
            </button>
            <button
              className="icon-button topbar-icon notification-button"
              type="button"
              onClick={() => changeView("today")}
              aria-label={`${pendingReminders} aktywne przypomnienia`}
            >
              <Bell size={19} />
              {pendingReminders > 0 && <span>{pendingReminders}</span>}
            </button>
            <button className="avatar" type="button" onClick={() => changeView("settings")} aria-label="Otwórz ustawienia profilu">
              {profileName.trim().charAt(0).toUpperCase() || "T"}
            </button>
          </div>
        </header>

        <main ref={mainRef} id="main-content" className="workspace" tabIndex={-1}>{children}</main>
      </div>

      <nav className="mobile-nav" aria-label="Nawigacja mobilna">
        {navigation.filter((item) => ["today", "calendar", "finance", "trips"].includes(item.id)).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "active" : ""}
              onClick={() => changeView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon size={21} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <button className="mobile-fab" type="button" onClick={onQuickAdd} aria-label="Dodaj">
        <Plus size={23} />
      </button>
    </div>
  );
}
