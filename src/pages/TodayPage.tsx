import {
  AlarmClock,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Coffee,
  Droplets,
  Footprints,
  Gauge,
  HeartPulse,
  Leaf,
  Lightbulb,
  ListTodo,
  Lock,
  MapPin,
  Pause,
  PawPrint,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Star,
  TimerReset,
  WalletCards,
  Plane,
  Utensils,
  CarFront,
  Repeat2,
  Eye,
  EyeOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { addDays, format, isAfter } from "date-fns";
import { pl } from "date-fns/locale";
import { TaskItem } from "../components/TaskItem";
import {
  dateKey,
  formatLongDate,
  greeting,
  relativeDay,
  relativeTime,
  toDateTime,
} from "../lib/date";
import { useLifeStore } from "../store/useLifeStore";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useSubscriptionsStore } from "../store/useSubscriptionsStore";
import { useHealthStore } from "../store/useHealthStore";
import { useFinanceStore } from "../store/useFinanceStore";
import { useTripsStore } from "../store/useTripsStore";
import { useMealsStore } from "../store/useMealsStore";
import { useCarStore } from "../store/useCarStore";
import { usePetsStore } from "../store/usePetsStore";
import { formatMoney } from "../lib/money";
import { polishPlural } from "../lib/pluralize";
import type { QuickAddType, ViewId } from "../types";

interface TodayPageProps {
  onQuickAdd: (type?: QuickAddType) => void;
  onNavigate: (view: ViewId) => void;
  onToast: (message: string) => void;
}

type AgendaItem = {
  id: string;
  title: string;
  time: string;
  endTime?: string;
  kind: "meeting" | "focus" | "personal" | "task";
  meta?: string;
  visibility?: "private" | "household";
};

const habitIcons = {
  water: Droplets,
  walk: Footprints,
  read: Coffee,
  stretch: Gauge,
  meditate: Leaf,
};

export function TodayPage({ onQuickAdd, onNavigate, onToast }: TodayPageProps) {
  const tasks = useLifeStore((state) => state.tasks);
  const events = useLifeStore((state) => state.events);
  const reminders = useLifeStore((state) => state.reminders);
  const habits = useLifeStore((state) => state.habits);
  const scratchpad = useLifeStore((state) => state.scratchpad);
  const intention = useLifeStore((state) => state.intention);
  const energy = useLifeStore((state) => state.energy);
  const name = useLifeStore((state) => state.preferences.name);
  const toggleReminder = useLifeStore((state) => state.toggleReminder);
  const snoozeReminder = useLifeStore((state) => state.snoozeReminder);
  const toggleHabit = useLifeStore((state) => state.toggleHabit);
  const setScratchpad = useLifeStore((state) => state.setScratchpad);
  const setIntention = useLifeStore((state) => state.setIntention);
  const setEnergy = useLifeStore((state) => state.setEnergy);
  const addTask = useLifeStore((state) => state.addTask);
  const financeTransactions = useFinanceStore((state) => state.transactions);
  const financeBudgets = useFinanceStore((state) => state.budgets);
  const trips = useTripsStore((state) => state.trips);
  const mealSlots = useMealsStore((state) => state.mealSlots);
  const subscriptions = useSubscriptionsStore((state) => state.subscriptions);
  const vehicles = useCarStore((state) => state.vehicles);
  const vehicleDeadlines = useCarStore((state) => state.vehicleDeadlines);
  const petVisits = usePetsStore((state) => state.petVisits);
  const healthAppointments = useHealthStore((state) => state.healthAppointments);
  const medications = useHealthStore((state) => state.medications);
  const hideAmounts = useAdvancedStore((state) => state.hideAmounts);
  const toggleHideAmounts = useAdvancedStore((state) => state.toggleHideAmounts);

  const [now, setNow] = useState(new Date());
  const [focusSeconds, setFocusSeconds] = useState(25 * 60);
  const [focusRunning, setFocusRunning] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!focusRunning) return;
    const timer = window.setInterval(() => {
      setFocusSeconds((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [focusRunning]);

  useEffect(() => {
    if (!focusRunning || focusSeconds > 0) return;
    setFocusRunning(false);
    onToast("Blok skupienia zakończony — czas na chwilę oddechu");
  }, [focusRunning, focusSeconds, onToast]);

  const today = dateKey(now);
  const tomorrow = dateKey(addDays(now, 1));
  const tomorrowEventsCount = events.filter((event) => event.date === tomorrow).length;
  const tomorrowTasksCount = tasks.filter(
    (task) => task.date === tomorrow && task.status === "todo",
  ).length;
  const focusTasks = tasks.filter(
    (task) => task.isFocus && task.status === "todo" && (!task.date || task.date === today),
  );
  const todayTasks = tasks.filter((task) => task.date === today);
  const todayOpenTasks = todayTasks.filter((task) => task.status === "todo");
  const todayDoneTasks = todayTasks.filter((task) => task.status === "done");
  const todayEvents = events
    .filter((event) => event.date === today)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const activeReminders = reminders
    .filter((reminder) => !reminder.done)
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const agenda = useMemo<AgendaItem[]>(() => {
    const eventItems: AgendaItem[] = todayEvents.map((event) => ({
      id: event.id,
      title: event.title,
      time: event.startTime,
      endTime: event.endTime,
      kind: event.kind,
      meta: event.location,
      visibility: event.visibility,
    }));
    const taskItems: AgendaItem[] = todayOpenTasks
      .filter((task) => task.time)
      .map((task) => ({
        id: task.id,
        title: task.title,
        time: task.time!,
        kind: "task",
        meta: task.category,
        visibility: task.visibility,
      }));
    return [...eventItems, ...taskItems].sort((a, b) => a.time.localeCompare(b.time));
  }, [todayEvents, todayOpenTasks]);

  const nextItem = agenda.find((item) => toDateTime(today, item.endTime ?? item.time) >= now);
  const totalToday = todayTasks.length;
  const progress = totalToday ? Math.round((todayDoneTasks.length / totalToday) * 100) : 0;
  const displayName = name.trim() ? `, ${name.trim()}` : "";
  const monthPrefix = today.slice(0, 7);
  const budgetCurrency = financeBudgets[0]?.currency ?? "PLN";
  const monthlySpent = Math.abs(
    financeTransactions
      .filter(
        (item) =>
          item.currency === budgetCurrency &&
          item.bookedOn.startsWith(monthPrefix) &&
          item.amountMinor < 0,
      )
      .reduce((sum, item) => sum + item.amountMinor, 0),
  );
  const totalBudget = financeBudgets
    .filter((item) => item.currency === budgetCurrency)
    .reduce((sum, item) => sum + item.limitMinor, 0);
  const nextTrip = trips
    .filter((trip) => trip.status !== "archived" && trip.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  const todayMeal = mealSlots.find((slot) => slot.date === today && slot.type === "dinner");
  const nextSubscription = subscriptions
    .filter((item) => item.status === "active" || item.status === "trial")
    .sort((a, b) => a.nextPayment.localeCompare(b.nextPayment))[0];
  const mainVehicle = vehicles[0];
  const nextCarDeadline = vehicleDeadlines
    .filter((item) => item.vehicleId === mainVehicle?.id && !item.completed && item.dueDate)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))[0];
  const nextPetVisit = petVisits
    .filter((item) => item.status === "scheduled" && item.date >= today)
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0];
  const nextHealthAppointment = healthAppointments
    .filter((item) => item.status === "scheduled" && item.date >= today)
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0];
  const activeMedications = medications.filter((item) => item.active);
  const medicationsTakenToday = activeMedications.filter(
    (item) => item.lastTakenOn === today,
  ).length;

  const scratchToTask = () => {
    const lines = scratchpad.split("\n");
    const index = lines.findIndex((line) => line.trim());
    if (index === -1) {
      onToast("Najpierw wpisz coś w szybkiej notatce");
      return;
    }
    const title = lines[index].replace(/^[-•]\s*/, "").trim();
    if (!title) {
      onToast("Najpierw wpisz coś w szybkiej notatce");
      return;
    }
    addTask({
      title,
      priority: "medium",
      date: today,
      category: "Prywatne",
      isFocus: false,
      energy: "medium",
    });
    lines.splice(index, 1);
    setScratchpad(lines.join("\n").trim());
    onToast("Pierwszy wiersz zamieniony w zadanie");
  };

  const focusLabel = `${String(Math.floor(focusSeconds / 60)).padStart(2, "0")}:${String(focusSeconds % 60).padStart(2, "0")}`;

  return (
    <div className="today-page page-enter">
      <section className="today-hero">
        <div className="today-hero__glow today-hero__glow--one" />
        <div className="today-hero__glow today-hero__glow--two" />
        <div className="today-hero__main">
          <span className="today-hero__date">{formatLongDate(now)}</span>
          <h1>
            {greeting(now)}
            {displayName} <span aria-hidden="true">👋</span>
          </h1>
          <p>
            {todayOpenTasks.length === 0
              ? "Plan na dziś domknięty. Dobra robota — reszta dnia należy do Ciebie."
              : `Masz dziś ${todayOpenTasks.length} ${todayOpenTasks.length === 1 ? "rzecz" : todayOpenTasks.length < 5 ? "rzeczy" : "rzeczy"} do zrobienia${todayEvents.length ? ` i ${todayEvents.length} ${polishPlural(todayEvents.length, "wydarzenie", "wydarzenia", "wydarzeń")}` : ""}. Zacznij od tego, co naprawdę ważne.`}
          </p>
          <label className="intention-field">
            <Lightbulb size={15} />
            <span className="sr-only">Intencja na dziś</span>
            <input
              value={intention}
              onChange={(event) => setIntention(event.target.value)}
              placeholder="Jaka jest Twoja intencja na dziś?"
            />
          </label>
        </div>

        <div className="today-hero__aside">
          <div
            className="progress-ring"
            role="progressbar"
            aria-label="Dzisiejszy postęp"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}
          >
            <div>
              <strong>{progress}%</strong>
              <span>dnia</span>
            </div>
          </div>
          <div>
            <span>Dzisiejszy postęp</span>
            <strong>
              {todayDoneTasks.length} z {totalToday || 0} zadań
            </strong>
          </div>
        </div>

        <div className="energy-check">
          <span>Jak z energią?</span>
          <div>
            <button
              className={energy === "low" ? "active" : ""}
              type="button"
              onClick={() => setEnergy("low")}
              aria-label="Mało energii"
              aria-pressed={energy === "low"}
            >
              🌙
            </button>
            <button
              className={energy === "medium" ? "active" : ""}
              type="button"
              onClick={() => setEnergy("medium")}
              aria-label="Energia w sam raz"
              aria-pressed={energy === "medium"}
            >
              🌤️
            </button>
            <button
              className={energy === "high" ? "active" : ""}
              type="button"
              onClick={() => setEnergy("high")}
              aria-label="Dużo energii"
              aria-pressed={energy === "high"}
            >
              ⚡
            </button>
          </div>
        </div>
      </section>

      <div className="dashboard-grid">
        <div className="dashboard-column dashboard-column--main">
          {focusTasks.length > 0 && (
            <section className="panel priorities-panel">
              <header className="panel__header">
                <div>
                  <span className="section-kicker">
                    <Star size={14} fill="currentColor" /> Kierunek dnia
                  </span>
                  <h2>Najważniejsze dzisiaj</h2>
                </div>
                <button className="text-button" type="button" onClick={() => onNavigate("tasks")}>
                  Wszystkie zadania <ChevronRight size={16} />
                </button>
              </header>
              <div className="priority-list">
                {focusTasks.map((task, index) => (
                  <div className="priority-row" key={task.id}>
                    <span className="priority-number">0{index + 1}</span>
                    <TaskItem task={task} compact />
                  </div>
                ))}
              </div>
              {focusTasks.length < 3 && (
                <button className="add-inline" type="button" onClick={() => onNavigate("tasks")}>
                  <Plus size={15} /> Dodaj priorytet ({focusTasks.length}/3)
                </button>
              )}
            </section>
          )}

          <section className="panel agenda-panel">
            <header className="panel__header">
              <div>
                <span className="section-kicker">
                  <CalendarDays size={14} /> Rytm dnia
                </span>
                <h2>Plan na dziś</h2>
              </div>
              <button
                className="button button--soft button--small"
                type="button"
                onClick={() => onQuickAdd("event")}
              >
                <Plus size={15} /> Wydarzenie
              </button>
            </header>
            {agenda.length ? (
              <div className="timeline">
                {agenda.map((item) => {
                  const past = isAfter(now, toDateTime(today, item.endTime ?? item.time));
                  const current = !past && item === nextItem;
                  return (
                    <div
                      className={`timeline-item timeline-item--${item.kind} ${past ? "timeline-item--past" : ""} ${current ? "timeline-item--current" : ""}`}
                      key={`${item.kind}-${item.id}`}
                    >
                      <time>{item.time}</time>
                      <div className="timeline-track">
                        <span />
                      </div>
                      <div className="timeline-card">
                        <div>
                          <strong>{item.title}</strong>
                          {item.visibility === "private" && (
                            <span className="private-badge">
                              <Lock size={11} /> Prywatne
                            </span>
                          )}
                          <span>
                            {item.endTime && (
                              <>
                                <Clock3 size={13} /> {item.time}–{item.endTime}
                              </>
                            )}
                            {item.meta && (
                              <>
                                <MapPin size={13} /> {item.meta}
                              </>
                            )}
                          </span>
                        </div>
                        <span className="event-kind">
                          {item.kind === "meeting"
                            ? "Spotkanie"
                            : item.kind === "focus"
                              ? "Skupienie"
                              : item.kind === "task"
                                ? "Zadanie"
                                : "Prywatne"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="soft-empty soft-empty--center">
                <CalendarDays size={21} />
                <div>
                  <strong>Masz przestrzeń w kalendarzu</strong>
                  <span>Zaplanuj blok skupienia albo zostaw ten czas wolny.</span>
                </div>
                <button
                  className="button button--soft"
                  type="button"
                  onClick={() => onQuickAdd("event")}
                >
                  Zaplanuj czas
                </button>
              </div>
            )}
          </section>

          <section className="panel habits-strip-panel">
            <header className="panel__header panel__header--compact">
              <div>
                <span className="section-kicker">
                  <Leaf size={14} /> Małe rzeczy
                </span>
                <h2>Codzienny rytm</h2>
              </div>
              <button className="text-button" type="button" onClick={() => onNavigate("habits")}>
                Zobacz tydzień <ChevronRight size={16} />
              </button>
            </header>
            <div className="habit-strip">
              {habits.slice(0, 3).map((habit) => {
                const Icon = habitIcons[habit.icon];
                const done = habit.completedDates.includes(today);
                return (
                  <button
                    className={done ? "habit-chip habit-chip--done" : "habit-chip"}
                    type="button"
                    key={habit.id}
                    onClick={() => toggleHabit(habit.id, today)}
                    aria-pressed={done}
                  >
                    <span>
                      <Icon size={18} />
                    </span>
                    <div>
                      <strong>{habit.name}</strong>
                      <small>{done ? "Gotowe na dziś" : habit.targetLabel}</small>
                    </div>
                    <span className="habit-chip__check">
                      {done ? <Check size={14} /> : <Circle size={14} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel life-overview-panel">
            <header className="panel__header panel__header--compact">
              <div>
                <span className="section-kicker">
                  <Sparkles size={14} /> Całe życie
                </span>
                <h2>W skrócie</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={toggleHideAmounts}
                aria-label={hideAmounts ? "Pokaż kwoty" : "Ukryj kwoty"}
              >
                {hideAmounts ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
            </header>
            <div className="life-overview-grid">
              <button type="button" onClick={() => onNavigate("finance")}>
                <span className="life-module-icon life-module-icon--finance">
                  <WalletCards size={18} />
                </span>
                <div>
                  <small>Budżet miesiąca · {budgetCurrency}</small>
                  <strong>
                    {formatMoney(monthlySpent, budgetCurrency, hideAmounts)} /{" "}
                    {formatMoney(totalBudget, budgetCurrency, hideAmounts)}
                  </strong>
                  <span>
                    {totalBudget
                      ? Math.min(100, Math.round((monthlySpent / totalBudget) * 100))
                      : 0}
                    % wykorzystane
                  </span>
                </div>
                <ChevronRight size={15} />
              </button>
              <button type="button" onClick={() => onNavigate("trips")}>
                <span className="life-module-icon life-module-icon--trip">
                  <Plane size={18} />
                </span>
                <div>
                  <small>Następna podróż</small>
                  <strong>{nextTrip?.name ?? "Brak planów"}</strong>
                  <span>
                    {nextTrip
                      ? `${relativeDay(nextTrip.startDate)} · gotowe ${nextTrip.progress}%`
                      : "Zaplanuj wyjazd"}
                  </span>
                </div>
                <ChevronRight size={15} />
              </button>
              <button type="button" onClick={() => onNavigate("meals")}>
                <span className="life-module-icon life-module-icon--meal">
                  <Utensils size={18} />
                </span>
                <div>
                  <small>Dzisiejsza kolacja</small>
                  <strong>{todayMeal?.title ?? "Jeszcze bez planu"}</strong>
                  <span>{todayMeal ? `${todayMeal.servings} porcje` : "Dodaj posiłek"}</span>
                </div>
                <ChevronRight size={15} />
              </button>
              <button type="button" onClick={() => onNavigate("subscriptions")}>
                <span className="life-module-icon life-module-icon--sub">
                  <Repeat2 size={18} />
                </span>
                <div>
                  <small>Najbliższe odnowienie</small>
                  <strong>{nextSubscription?.name ?? "Brak odnowień"}</strong>
                  <span>
                    {nextSubscription
                      ? `${formatMoney(nextSubscription.amountMinor, nextSubscription.currency, hideAmounts)} · ${relativeDay(nextSubscription.nextPayment)}`
                      : "Wszystko spokojnie"}
                  </span>
                </div>
                <ChevronRight size={15} />
              </button>
              <button type="button" onClick={() => onNavigate("car")}>
                <span className="life-module-icon life-module-icon--car">
                  <CarFront size={18} />
                </span>
                <div>
                  <small>{mainVehicle?.name ?? "Samochód"}</small>
                  <strong>{nextCarDeadline?.title ?? "Brak pilnych terminów"}</strong>
                  <span>
                    {nextCarDeadline?.dueDate
                      ? relativeDay(nextCarDeadline.dueDate)
                      : mainVehicle
                        ? `${mainVehicle.mileage.toLocaleString("pl-PL")} km`
                        : "Dodaj pojazd"}
                  </span>
                </div>
                <ChevronRight size={15} />
              </button>
              <button type="button" onClick={() => onNavigate("pets")}>
                <span className="life-module-icon life-module-icon--pets">
                  <PawPrint size={18} />
                </span>
                <div>
                  <small>Zwierzęta</small>
                  <strong>{nextPetVisit?.title ?? "Brak wizyt w planie"}</strong>
                  <span>
                    {nextPetVisit
                      ? `${relativeDay(nextPetVisit.date)} · ${nextPetVisit.time}`
                      : "Wszystko spokojnie"}
                  </span>
                </div>
                <ChevronRight size={15} />
              </button>
              <button type="button" onClick={() => onNavigate("health")}>
                <span className="life-module-icon life-module-icon--health">
                  <HeartPulse size={18} />
                </span>
                <div>
                  <small>Zdrowie</small>
                  <strong>{nextHealthAppointment?.title ?? "Bez wizyt w planie"}</strong>
                  <span>
                    {nextHealthAppointment
                      ? `${relativeDay(nextHealthAppointment.date)} · ${nextHealthAppointment.time}`
                      : activeMedications.length
                        ? `Leki: ${medicationsTakenToday} z ${activeMedications.length} przyjęte`
                        : "Wszystko spokojnie"}
                  </span>
                </div>
                <ChevronRight size={15} />
              </button>
            </div>
          </section>
        </div>

        <aside className="dashboard-column dashboard-column--side">
          <section className="next-card">
            <div className="next-card__top">
              <span>
                <AlarmClock size={15} /> {nextItem ? "Następne" : "Spokojny moment"}
              </span>
              <strong>{format(now, "HH:mm")}</strong>
            </div>
            {nextItem ? (
              <>
                <div className="next-card__time">{nextItem.time}</div>
                <h2>{nextItem.title}</h2>
                <p>
                  {nextItem.endTime
                    ? `${nextItem.time}–${nextItem.endTime}`
                    : nextItem.meta || "Zaplanowane na dziś"}{" "}
                  · {relativeTime(today, nextItem.time)}
                </p>
                <button
                  className="button button--light"
                  type="button"
                  onClick={() => {
                    setFocusSeconds(25 * 60);
                    setFocusRunning(true);
                    onToast("Timer skupienia wystartował");
                  }}
                >
                  <Play size={16} fill="currentColor" /> Zacznij 25 min skupienia
                </button>
              </>
            ) : (
              <>
                <Coffee className="next-card__empty-icon" size={30} />
                <h2>Nic pilnego przed Tobą</h2>
                <p>To dobry moment na przerwę albo domknięcie drobnej sprawy.</p>
              </>
            )}
          </section>

          {(focusRunning || focusSeconds !== 25 * 60) && (
            <section className="focus-timer-card">
              <div className="focus-timer-card__icon">
                <TimerReset size={20} />
              </div>
              <div>
                <span>Tryb skupienia</span>
                <strong>{focusLabel}</strong>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setFocusRunning((value) => !value)}
                aria-label={focusRunning ? "Pauza" : "Wznów"}
              >
                {focusRunning ? (
                  <Pause size={18} fill="currentColor" />
                ) : (
                  <Play size={18} fill="currentColor" />
                )}
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setFocusRunning(false);
                  setFocusSeconds(25 * 60);
                }}
                aria-label="Wyzeruj timer"
              >
                <RotateCcw size={17} />
              </button>
            </section>
          )}

          <section className="panel scratchpad-card">
            <header className="panel__header panel__header--compact">
              <div>
                <span className="section-kicker">
                  <Lightbulb size={14} /> Pod ręką
                </span>
                <h2>Szybka notatka</h2>
              </div>
              <span className="autosave">
                <span /> zapisuje się
              </span>
            </header>
            <textarea
              value={scratchpad}
              onChange={(event) => setScratchpad(event.target.value)}
              placeholder="Zapisz myśl, numer, pomysł…"
              aria-label="Szybka notatka"
            />
            <footer>
              <span>{scratchpad.length} znaków</span>
              <button type="button" onClick={scratchToTask}>
                <ListTodo size={14} /> Pierwszy wiersz → zadanie
              </button>
            </footer>
          </section>

          <section className="panel reminders-card">
            <header className="panel__header panel__header--compact">
              <div>
                <span className="section-kicker">
                  <Bell size={14} /> Nie zapomnij
                </span>
                <h2>Przypomnienia</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => onQuickAdd("reminder")}
                aria-label="Dodaj przypomnienie"
              >
                <Plus size={18} />
              </button>
            </header>
            <div className="reminder-list">
              {activeReminders.slice(0, 4).map((reminder) => (
                <div className="reminder-row" key={reminder.id}>
                  <button
                    className="reminder-check"
                    type="button"
                    onClick={() => toggleReminder(reminder.id)}
                    aria-label={`Ukończ: ${reminder.title}`}
                  >
                    <Check size={13} />
                  </button>
                  <div>
                    <strong>
                      {reminder.title}
                      {reminder.visibility === "private" && (
                        <span className="private-badge">
                          <Lock size={10} /> Prywatne
                        </span>
                      )}
                    </strong>
                    <span>
                      {relativeDay(reminder.date)} · {reminder.time}
                    </span>
                  </div>
                  <button
                    className="snooze-button"
                    type="button"
                    onClick={() => {
                      snoozeReminder(reminder.id, 30);
                      onToast("Przypomnę ponownie za 30 minut");
                    }}
                    title="Odłóż o 30 minut"
                  >
                    <AlarmClock size={15} />
                  </button>
                </div>
              ))}
              {!activeReminders.length && (
                <div className="mini-empty">
                  <Check size={17} />
                  <span>Wszystko zapamiętane.</span>
                </div>
              )}
            </div>
            <button className="panel-link" type="button" onClick={() => onQuickAdd("reminder")}>
              <Plus size={14} /> Dodaj przypomnienie
            </button>
          </section>

          <section className="tomorrow-preview">
            <div>
              <span>{format(addDays(now, 1), "EEEE", { locale: pl })}</span>
              <strong>{format(addDays(now, 1), "d MMMM", { locale: pl })}</strong>
            </div>
            <p>
              {tomorrowEventsCount}{" "}
              {polishPlural(tomorrowEventsCount, "wydarzenie", "wydarzenia", "wydarzeń")} ·{" "}
              {tomorrowTasksCount} {polishPlural(tomorrowTasksCount, "zadanie", "zadania", "zadań")}
            </p>
            <button
              type="button"
              onClick={() => onNavigate("calendar")}
              aria-label="Otwórz kalendarz"
            >
              <ArrowRight size={17} />
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}
