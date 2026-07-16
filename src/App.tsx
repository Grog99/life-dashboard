import { CheckCircle2, LoaderCircle, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Layout } from "./components/Layout";
import { QuickAddModal } from "./components/QuickAddModal";
import { ModuleErrorBoundary } from "./components/ModuleErrorBoundary";
import { useReminderEngine } from "./hooks/useReminderEngine";
import { CalendarPage } from "./pages/CalendarPage";
import { HabitsPage } from "./pages/HabitsPage";
import { NotesPage } from "./pages/NotesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { TodayPage } from "./pages/TodayPage";
import { useLifeStore } from "./store/useLifeStore";
import { useAdvancedStore } from "./store/useAdvancedStore";
import type { QuickAddType, ViewId } from "./types";

const FinancePage = lazy(() =>
  import("./pages/FinancePage").then((module) => ({ default: module.FinancePage })),
);
const TripsPage = lazy(() =>
  import("./pages/TripsPage").then((module) => ({ default: module.TripsPage })),
);
const SubscriptionsPage = lazy(() =>
  import("./pages/SubscriptionsPage").then((module) => ({ default: module.SubscriptionsPage })),
);
const MealsPage = lazy(() =>
  import("./pages/MealsPage").then((module) => ({ default: module.MealsPage })),
);
const CarPage = lazy(() =>
  import("./pages/CarPage").then((module) => ({ default: module.CarPage })),
);
const PetsPage = lazy(() =>
  import("./pages/PetsPage").then((module) => ({ default: module.PetsPage })),
);
const HealthPage = lazy(() =>
  import("./pages/HealthPage").then((module) => ({ default: module.HealthPage })),
);

const viewIds: ViewId[] = [
  "today",
  "tasks",
  "calendar",
  "notes",
  "habits",
  "finance",
  "trips",
  "subscriptions",
  "meals",
  "car",
  "pets",
  "health",
  "settings",
];

function viewFromUrl(): ViewId {
  const value = new URL(window.location.href).searchParams.get("view") as ViewId | null;
  return value && viewIds.includes(value) ? value : "today";
}

export default function App() {
  const [view, setView] = useState<ViewId>(viewFromUrl);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddType, setQuickAddType] = useState<QuickAddType>("task");
  const [commandOpen, setCommandOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const theme = useLifeStore((state) => state.preferences.theme);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(Number(document.documentElement.dataset.toastTimer ?? 0));
    const timer = window.setTimeout(() => setToast(null), 4200);
    document.documentElement.dataset.toastTimer = String(timer);
  }, []);

  const openQuickAdd = useCallback((type: QuickAddType = "task") => {
    setQuickAddType(type);
    setQuickAddOpen(true);
  }, []);

  const navigate = useCallback((nextView: ViewId) => {
    setView(nextView);
    const url = new URL(window.location.href);
    if (nextView === "today") url.searchParams.delete("view");
    else url.searchParams.set("view", nextView);
    window.history.pushState({ view: nextView }, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const handleDueReminder = useCallback(
    (reminder: { title: string }) => showToast(`Przypomnienie: ${reminder.title}`),
    [showToast],
  );

  useReminderEngine(handleDueReminder);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("quickAdd") === "1") {
      openQuickAdd();
      url.searchParams.delete("quickAdd");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    const handlePopState = () => setView(viewFromUrl());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [openQuickAdd]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      root.dataset.theme = resolved;
      root.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((value) => !value);
      } else if (!typing && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openQuickAdd();
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [openQuickAdd]);

  useEffect(() => {
    const showStorageWarning = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (message) showToast(message);
    };
    window.addEventListener("puls:storage-warning", showStorageWarning);
    try {
      const pendingInvite = sessionStorage.getItem("puls-invite-warning");
      if (pendingInvite) sessionStorage.removeItem("puls-invite-warning");
      const pending = sessionStorage.getItem("puls-storage-warning");
      if (pending) {
        sessionStorage.removeItem("puls-storage-warning");
      }
      if (pendingInvite) showToast(pendingInvite);
      if (pending) {
        if (pendingInvite) window.setTimeout(() => showToast(pending), 4300);
        else showToast(pending);
      }
    } catch {
      // A locked session storage must not prevent the in-memory application from opening.
    }
    return () => window.removeEventListener("puls:storage-warning", showStorageWarning);
  }, [showToast]);

  useEffect(() => {
    const syncOtherTabs = (event: StorageEvent) => {
      if (event.key === "puls-life-dashboard") void useLifeStore.persist.rehydrate();
      if (event.key === "puls-advanced-dashboard") void useAdvancedStore.persist.rehydrate();
    };
    window.addEventListener("storage", syncOtherTabs);
    return () => window.removeEventListener("storage", syncOtherTabs);
  }, []);

  // Dosuwa okno przyszłych wystąpień serii powtarzalnych zadań/wydarzeń — przy montażu
  // i przy powrocie do aplikacji (zmiana dnia w tle). Sama akcja jest no-op, gdy okno
  // jest już pełne (patrz src/store/useLifeStore.ts, docs/plans/zadania-wydarzenia-powtarzalne.md).
  useEffect(() => {
    useLifeStore.getState().expandRecurringSeries();
    const handleVisible = () => {
      if (document.visibilityState === "visible") useLifeStore.getState().expandRecurringSeries();
    };
    window.addEventListener("focus", handleVisible);
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      window.removeEventListener("focus", handleVisible);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, []);

  return (
    <>
      <Layout
        view={view}
        onViewChange={navigate}
        onQuickAdd={() => openQuickAdd()}
        onCommand={() => setCommandOpen(true)}
      >
        <ModuleErrorBoundary key={view}>
          <Suspense
            fallback={
              <div className="module-loading">
                <LoaderCircle size={22} className="spin" />
                <span>Otwieram moduł…</span>
              </div>
            }
          >
            {view === "today" && (
              <TodayPage onQuickAdd={openQuickAdd} onNavigate={navigate} onToast={showToast} />
            )}
            {view === "tasks" && (
              <TasksPage onQuickAdd={() => openQuickAdd("task")} onToast={showToast} />
            )}
            {view === "calendar" && (
              <CalendarPage onQuickAdd={() => openQuickAdd("event")} onToast={showToast} />
            )}
            {view === "notes" && (
              <NotesPage onQuickAdd={() => openQuickAdd("note")} onToast={showToast} />
            )}
            {view === "habits" && <HabitsPage onToast={showToast} />}
            {view === "finance" && <FinancePage onToast={showToast} />}
            {view === "trips" && <TripsPage onToast={showToast} />}
            {view === "subscriptions" && <SubscriptionsPage onToast={showToast} />}
            {view === "meals" && <MealsPage onToast={showToast} />}
            {view === "car" && <CarPage onToast={showToast} />}
            {view === "pets" && <PetsPage onToast={showToast} />}
            {view === "health" && <HealthPage onToast={showToast} />}
            {view === "settings" && <SettingsPage onToast={showToast} />}
          </Suspense>
        </ModuleErrorBoundary>
      </Layout>

      <QuickAddModal
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        initialType={quickAddType}
        onAdded={showToast}
      />
      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onNavigate={navigate}
        onQuickAdd={() => openQuickAdd()}
      />

      {toast && (
        <div className="toast" role="status">
          <span>
            <CheckCircle2 size={18} />
          </span>
          <strong>{toast}</strong>
          <button
            className="icon-button"
            type="button"
            onClick={() => setToast(null)}
            aria-label="Zamknij komunikat"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
