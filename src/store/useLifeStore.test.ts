import { beforeEach, describe, expect, it } from "vitest";
import { addDays } from "date-fns";
import { createSampleData } from "../data/sampleData";
import { dateKey } from "../lib/date";
import { SERIES_WINDOW } from "../lib/recurrence";
import { useLifeStore } from "./useLifeStore";

describe("life store", () => {
  beforeEach(() => {
    localStorage.clear();
    useLifeStore.setState(createSampleData());
  });

  it("przełącza status zadania i zapisuje czas ukończenia", () => {
    useLifeStore.getState().toggleTask("task-car");
    const task = useLifeStore.getState().tasks.find((item) => item.id === "task-car");
    expect(task?.status).toBe("done");
    expect(task?.completedAt).toBeTruthy();
  });

  it("pilnuje limitu trzech priorytetów", () => {
    expect(useLifeStore.getState().toggleFocus("task-book")).toBe(false);
    useLifeStore.getState().toggleFocus("task-walk");
    expect(useLifeStore.getState().toggleFocus("task-book")).toBe(true);
    expect(
      useLifeStore.getState().tasks.filter((task) => task.isFocus && task.status === "todo"),
    ).toHaveLength(3);
  });

  it("nie pozwala przywróceniu zadania ominąć limitu priorytetów", () => {
    useLifeStore.getState().toggleTask("task-walk");
    useLifeStore.getState().toggleFocus("task-book");
    useLifeStore.getState().toggleTask("task-walk");
    const activeFocus = useLifeStore
      .getState()
      .tasks.filter((task) => task.isFocus && task.status === "todo");
    expect(activeFocus).toHaveLength(3);
    expect(activeFocus.some((task) => task.id === "task-walk")).toBe(false);
  });

  it("dodaje zadanie z bezpiecznymi danymi domyślnymi", () => {
    const taskId = useLifeStore.getState().addTask({
      title: "Nowa rzecz",
      priority: "medium",
      category: "Prywatne",
      isFocus: false,
      energy: "low",
    });
    expect(useLifeStore.getState().tasks.find((task) => task.id === taskId)).toMatchObject({
      title: "Nowa rzecz",
      status: "todo",
    });
  });

  it("nowy rekord bez podanej widoczności domyślnie jest prywatny z ownerId 'me'", () => {
    const taskId = useLifeStore.getState().addTask({
      title: "Zadanie bez widoczności",
      priority: "medium",
      category: "Prywatne",
      isFocus: false,
      energy: "low",
    });
    const task = useLifeStore.getState().tasks.find((item) => item.id === taskId);
    expect(task?.visibility).toBe("private");
    expect(task?.ownerId).toBe("me");

    const eventId = useLifeStore.getState().addEvent({
      title: "Wydarzenie bez widoczności",
      date: "2026-07-20",
      startTime: "10:00",
      endTime: "11:00",
      kind: "personal",
    });
    const event = useLifeStore.getState().events.find((item) => item.id === eventId);
    expect(event?.visibility).toBe("private");
    expect(event?.ownerId).toBe("me");

    const reminderId = useLifeStore.getState().addReminder({
      title: "Przypomnienie bez widoczności",
      date: "2026-07-20",
      time: "10:00",
    });
    const reminder = useLifeStore.getState().reminders.find((item) => item.id === reminderId);
    expect(reminder?.visibility).toBe("private");
    expect(reminder?.ownerId).toBe("me");

    const noteId = useLifeStore.getState().addNote({
      title: "Notatka bez widoczności",
      content: "",
      color: "cream",
      pinned: false,
    });
    const note = useLifeStore.getState().notes.find((item) => item.id === noteId);
    expect(note?.visibility).toBe("private");
    expect(note?.ownerId).toBe("me");

    useLifeStore.getState().addHabit({
      name: "Rytuał bez widoczności",
      icon: "walk",
      targetLabel: "raz dziennie",
    });
    const habit = useLifeStore
      .getState()
      .habits.find((item) => item.name === "Rytuał bez widoczności");
    expect(habit?.visibility).toBe("private");
    expect(habit?.ownerId).toBe("me");
  });

  it("przekazana widoczność 'household' i ownerId są zachowywane", () => {
    const taskId = useLifeStore.getState().addTask({
      title: "Wspólne zadanie",
      priority: "medium",
      category: "Dom",
      isFocus: false,
      energy: "low",
      visibility: "household",
      ownerId: "user-123",
    });
    const task = useLifeStore.getState().tasks.find((item) => item.id === taskId);
    expect(task?.visibility).toBe("household");
    expect(task?.ownerId).toBe("user-123");
  });

  it("odrzuca tylko uszkodzony rekord przy scalaniu zapisanych danych, zachowując resztę", () => {
    const sample = createSampleData();
    const persistedState = {
      ...sample,
      tasks: [sample.tasks[0], { ...sample.tasks[1], title: "" }],
    };
    const merge = useLifeStore.persist.getOptions().merge!;
    const merged = merge(persistedState, useLifeStore.getState()) as ReturnType<
      typeof useLifeStore.getState
    >;

    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0].id).toBe(sample.tasks[0].id);
    expect(merged.events).toEqual(sample.events);
    expect(merged.notes).toEqual(sample.notes);
  });
});

describe("serie powtarzalne w store", () => {
  beforeEach(() => {
    localStorage.clear();
    useLifeStore.setState(createSampleData());
  });

  it("addRecurringTask materializuje okno wystąpień z deterministycznymi id", () => {
    const seriesId = useLifeStore
      .getState()
      .addRecurringTask(
        { title: "Sprzątanie", priority: "medium", category: "Dom", isFocus: false, energy: "low" },
        { freq: "weekly", interval: 1, anchorDate: dateKey() },
      );
    const occ = useLifeStore.getState().tasks.filter((task) => task.seriesId === seriesId);
    expect(occ).toHaveLength(SERIES_WINDOW);
    expect(occ.every((task) => task.status === "todo")).toBe(true);
    expect(new Set(occ.map((task) => task.id)).size).toBe(SERIES_WINDOW); // unikalne
    expect(occ.some((task) => task.id === `${seriesId}#0`)).toBe(true);
  });

  it("addRecurringTask respektuje limit count", () => {
    const seriesId = useLifeStore
      .getState()
      .addRecurringTask(
        { title: "Trzy razy", priority: "low", category: "Dom", isFocus: false, energy: "low" },
        { freq: "daily", interval: 1, count: 3, anchorDate: dateKey() },
      );
    expect(useLifeStore.getState().tasks.filter((task) => task.seriesId === seriesId)).toHaveLength(
      3,
    );
  });

  it("addRecurringEvent zachowuje czas trwania wydarzenia w każdym wystąpieniu", () => {
    const seriesId = useLifeStore.getState().addRecurringEvent(
      {
        title: "Trening",
        date: dateKey(),
        startTime: "18:00",
        endTime: "19:30",
        kind: "personal",
      },
      { freq: "weekly", interval: 1, anchorDate: dateKey() },
    );
    const occ = useLifeStore.getState().events.filter((event) => event.seriesId === seriesId);
    expect(occ).toHaveLength(SERIES_WINDOW);
    expect(occ.every((event) => event.startTime === "18:00" && event.endTime === "19:30")).toBe(
      true,
    );
  });

  it("deleteSeries kasuje wszystkie wystąpienia serii", () => {
    const seriesId = useLifeStore
      .getState()
      .addRecurringTask(
        { title: "Do usunięcia", priority: "low", category: "Dom", isFocus: false, energy: "low" },
        { freq: "daily", interval: 1, anchorDate: dateKey() },
      );
    useLifeStore.getState().deleteSeries(seriesId);
    expect(useLifeStore.getState().tasks.filter((task) => task.seriesId === seriesId)).toHaveLength(
      0,
    );
  });

  it("updateSeries zmienia tylko przyszłe/dzisiejsze wystąpienia, nie rusza przeszłych", () => {
    const past = dateKey(addDays(new Date(), -3));
    const future = dateKey(addDays(new Date(), 3));
    const recurrence = { freq: "daily" as const, interval: 1, anchorDate: past };
    const timestamp = new Date().toISOString();
    const shared = {
      title: "Stary tytuł",
      status: "todo" as const,
      priority: "medium" as const,
      category: "Dom",
      isFocus: false,
      energy: "low" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      seriesId: "s-hist",
      recurrence,
    };
    useLifeStore.setState({
      tasks: [
        { ...shared, id: "s-hist#0", date: past, seriesIndex: 0 },
        { ...shared, id: "s-hist#5", date: future, seriesIndex: 5 },
      ],
    });

    useLifeStore.getState().updateSeries("s-hist", { title: "Nowy tytuł" });
    const tasks = useLifeStore.getState().tasks;
    expect(tasks.find((task) => task.id === "s-hist#0")?.title).toBe("Stary tytuł"); // przeszłe nietknięte
    expect(tasks.find((task) => task.id === "s-hist#5")?.title).toBe("Nowy tytuł"); // przyszłe zmienione
  });

  it("expandRecurringSeries jest no-op, gdy okno jest pełne (bez zbędnego zapisu)", () => {
    useLifeStore
      .getState()
      .addRecurringTask(
        { title: "Pełne okno", priority: "medium", category: "Dom", isFocus: false, energy: "low" },
        { freq: "daily", interval: 1, anchorDate: dateKey() },
      );
    const before = useLifeStore.getState().tasks;
    useLifeStore.getState().expandRecurringSeries();
    expect(useLifeStore.getState().tasks).toBe(before); // ta sama referencja = brak zapisu
  });

  it("updateEventSeries zmienia godzinę serii (anchorTime) na przyszłych wystąpieniach", () => {
    const today = dateKey();
    const seriesId = useLifeStore
      .getState()
      .addRecurringEvent(
        { title: "Trening", date: today, startTime: "18:00", endTime: "19:00", kind: "personal" },
        { freq: "daily", interval: 1, anchorDate: today, anchorTime: "18:00" },
      );
    useLifeStore.getState().updateEventSeries(seriesId, {
      title: "Trening",
      startTime: "20:00",
      endTime: "21:00",
      recurrence: { freq: "daily", interval: 1, anchorDate: today, anchorTime: "20:00" },
    });
    const occ = useLifeStore.getState().events.filter((event) => event.seriesId === seriesId);
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.every((event) => event.startTime === "20:00" && event.endTime === "21:00")).toBe(
      true,
    );
  });

  it("updateSeries zmniejsza limit count i przycina przyszłe wystąpienia ponad limit", () => {
    const today = dateKey();
    const seriesId = useLifeStore
      .getState()
      .addRecurringTask(
        { title: "Limit", priority: "medium", category: "Dom", isFocus: false, energy: "low" },
        { freq: "daily", interval: 1, anchorDate: today },
      );
    expect(useLifeStore.getState().tasks.filter((task) => task.seriesId === seriesId)).toHaveLength(
      SERIES_WINDOW,
    );
    useLifeStore.getState().updateSeries(seriesId, {
      title: "Limit",
      recurrence: { freq: "daily", interval: 1, anchorDate: today, count: 3 },
    });
    expect(useLifeStore.getState().tasks.filter((task) => task.seriesId === seriesId)).toHaveLength(
      3,
    );
  });

  it("updateSeries propaguje zmianę widoczności na całą serię, także przeszłe wystąpienia", () => {
    const past = dateKey(addDays(new Date(), -3));
    const future = dateKey(addDays(new Date(), 3));
    const recurrence = { freq: "daily" as const, interval: 1, anchorDate: past };
    const timestamp = new Date().toISOString();
    const shared = {
      title: "Widoczność",
      status: "todo" as const,
      priority: "medium" as const,
      category: "Dom",
      isFocus: false,
      energy: "low" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      seriesId: "s-vis",
      recurrence,
      visibility: "household" as const,
    };
    useLifeStore.setState({
      tasks: [
        { ...shared, id: "s-vis#0", date: past, seriesIndex: 0 },
        { ...shared, id: "s-vis#5", date: future, seriesIndex: 5 },
      ],
    });
    useLifeStore.getState().updateSeries("s-vis", { visibility: "private" });
    const tasks = useLifeStore.getState().tasks;
    expect(tasks.find((task) => task.id === "s-vis#0")?.visibility).toBe("private"); // przeszłe też
    expect(tasks.find((task) => task.id === "s-vis#5")?.visibility).toBe("private");
  });
});
