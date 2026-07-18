import { beforeEach, describe, expect, it } from "vitest";
import { addDays } from "date-fns";
import { dateKey } from "../lib/date";
import { SERIES_WINDOW } from "../lib/recurrence";
import { useLifeRecordsStore, type LifeMutationResult } from "./useLifeRecordsStore";
import type { CalendarEvent, Habit, Note, Reminder, Task } from "../types";

const now = new Date().toISOString();

function sampleTasks(): Task[] {
  return [
    {
      id: "task-offer",
      title: "Dokończyć prezentację projektu",
      description: "Sprawdzić ostatnie slajdy i wysłać wersję do komentarzy.",
      status: "todo",
      priority: "high",
      tags: ["Praca"],
      isFocus: true,
      energy: "high",
      createdAt: now,
      version: 1,
      updatedAt: now,
    },
    {
      id: "task-car",
      title: "Umówić przegląd auta",
      status: "todo",
      priority: "medium",
      tags: ["Dom"],
      isFocus: true,
      energy: "low",
      createdAt: now,
      version: 1,
      updatedAt: now,
    },
    {
      id: "task-walk",
      title: "30 minut spaceru bez telefonu",
      status: "todo",
      priority: "low",
      tags: ["Zdrowie"],
      isFocus: true,
      energy: "medium",
      createdAt: now,
      version: 1,
      updatedAt: now,
    },
    {
      id: "task-invoice",
      title: "Opłacić rachunek za internet",
      status: "todo",
      priority: "medium",
      tags: ["Finanse"],
      isFocus: false,
      energy: "low",
      createdAt: now,
      version: 1,
      updatedAt: now,
    },
    {
      id: "task-shopping",
      title: "Zrobić listę zakupów na weekend",
      status: "done",
      priority: "low",
      tags: ["Dom"],
      isFocus: false,
      energy: "low",
      createdAt: now,
      version: 1,
      updatedAt: now,
      completedAt: now,
    },
    {
      id: "task-book",
      title: "Zamówić książkę dla mamy",
      status: "todo",
      priority: "low",
      tags: [],
      isFocus: false,
      energy: "low",
      createdAt: now,
      version: 1,
      updatedAt: now,
    },
  ];
}

function seedTasks(tasks: Task[] = sampleTasks()) {
  useLifeRecordsStore.setState({
    tasks,
    events: [],
    reminders: [],
    notes: [],
    habits: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: true,
  });
}

describe("life records store", () => {
  beforeEach(() => {
    localStorage.clear();
    seedTasks();
  });

  it("przełącza status zadania i zapisuje czas ukończenia", () => {
    useLifeRecordsStore.getState().toggleTask("task-car");
    const task = useLifeRecordsStore.getState().tasks.find((item) => item.id === "task-car");
    expect(task?.status).toBe("done");
    expect(task?.completedAt).toBeTruthy();
  });

  it("pilnuje limitu trzech priorytetów", () => {
    expect(useLifeRecordsStore.getState().toggleFocus("task-book")).toBe(false);
    useLifeRecordsStore.getState().toggleFocus("task-walk");
    expect(useLifeRecordsStore.getState().toggleFocus("task-book")).toBe(true);
    expect(
      useLifeRecordsStore.getState().tasks.filter((task) => task.isFocus && task.status === "todo"),
    ).toHaveLength(3);
  });

  it("nie pozwala przywróceniu zadania ominąć limitu priorytetów", () => {
    useLifeRecordsStore.getState().toggleTask("task-walk");
    useLifeRecordsStore.getState().toggleFocus("task-book");
    useLifeRecordsStore.getState().toggleTask("task-walk");
    const activeFocus = useLifeRecordsStore
      .getState()
      .tasks.filter((task) => task.isFocus && task.status === "todo");
    expect(activeFocus).toHaveLength(3);
    expect(activeFocus.some((task) => task.id === "task-walk")).toBe(false);
  });

  it("dodaje zadanie z bezpiecznymi danymi domyślnymi", () => {
    const taskId = useLifeRecordsStore.getState().addTask({
      title: "Nowa rzecz",
      priority: "medium",
      tags: [],
      isFocus: false,
      energy: "low",
    });
    expect(useLifeRecordsStore.getState().tasks.find((task) => task.id === taskId)).toMatchObject({
      title: "Nowa rzecz",
      status: "todo",
    });
  });

  it("addTask kolejkuje task.create z widocznością/właścicielem w ładunku", () => {
    const taskId = useLifeRecordsStore.getState().addTask({
      title: "Nowa rzecz",
      priority: "medium",
      tags: [],
      isFocus: false,
      energy: "low",
      visibility: "household",
      ownerId: "user-123",
    });
    const mutation = useLifeRecordsStore
      .getState()
      .pendingMutations.find((item) => item.op === "task.create" && item.payload.id === taskId);
    expect(mutation).toBeDefined();
    expect(mutation?.payload).toMatchObject({
      id: taskId,
      title: "Nowa rzecz",
      visibility: "household",
    });
  });

  it("nowy rekord bez podanej widoczności domyślnie jest prywatny z ownerId 'me'", () => {
    const taskId = useLifeRecordsStore.getState().addTask({
      title: "Zadanie bez widoczności",
      priority: "medium",
      tags: [],
      isFocus: false,
      energy: "low",
    });
    const task = useLifeRecordsStore.getState().tasks.find((item) => item.id === taskId);
    expect(task?.visibility).toBe("private");
    expect(task?.ownerId).toBe("me");

    const eventId = useLifeRecordsStore.getState().addEvent({
      title: "Wydarzenie bez widoczności",
      date: "2026-07-20",
      startTime: "10:00",
      endTime: "11:00",
      kind: "personal",
    });
    const event = useLifeRecordsStore.getState().events.find((item) => item.id === eventId);
    expect(event?.visibility).toBe("private");
    expect(event?.ownerId).toBe("me");

    const reminderId = useLifeRecordsStore.getState().addReminder({
      title: "Przypomnienie bez widoczności",
      date: "2026-07-20",
      time: "10:00",
    });
    const reminder = useLifeRecordsStore
      .getState()
      .reminders.find((item) => item.id === reminderId);
    expect(reminder?.visibility).toBe("private");
    expect(reminder?.ownerId).toBe("me");

    const noteId = useLifeRecordsStore.getState().addNote({
      title: "Notatka bez widoczności",
      content: "",
      color: "cream",
      pinned: false,
    });
    const note = useLifeRecordsStore.getState().notes.find((item) => item.id === noteId);
    expect(note?.visibility).toBe("private");
    expect(note?.ownerId).toBe("me");

    useLifeRecordsStore.getState().addHabit({
      name: "Rytuał bez widoczności",
      icon: "walk",
      targetLabel: "raz dziennie",
    });
    const habit = useLifeRecordsStore
      .getState()
      .habits.find((item) => item.name === "Rytuał bez widoczności");
    expect(habit?.visibility).toBe("private");
    expect(habit?.ownerId).toBe("me");
  });

  it("przekazana widoczność 'household' i ownerId są zachowywane", () => {
    const taskId = useLifeRecordsStore.getState().addTask({
      title: "Wspólne zadanie",
      priority: "medium",
      tags: ["Dom"],
      isFocus: false,
      energy: "low",
      visibility: "household",
      ownerId: "user-123",
    });
    const task = useLifeRecordsStore.getState().tasks.find((item) => item.id === taskId);
    expect(task?.visibility).toBe("household");
    expect(task?.ownerId).toBe("user-123");
  });

  it("odrzuca tylko uszkodzony rekord przy scalaniu zapisanych danych, zachowując resztę", () => {
    const tasks = sampleTasks();
    const persistedState = {
      tasks: [tasks[0], { ...tasks[1], title: "" }],
      events: [],
      reminders: [],
      notes: [],
      habits: [],
      pendingMutations: [],
      serverAt: null,
    };
    const merge = useLifeRecordsStore.persist.getOptions().merge!;
    const merged = merge(persistedState, useLifeRecordsStore.getState()) as ReturnType<
      typeof useLifeRecordsStore.getState
    >;

    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0].id).toBe(tasks[0].id);
    expect(merged.events).toEqual([]);
    expect(merged.notes).toEqual([]);
  });
});

describe("serie powtarzalne w store", () => {
  beforeEach(() => {
    localStorage.clear();
    seedTasks();
  });

  it("addRecurringEvent zachowuje czas trwania wydarzenia w każdym wystąpieniu", () => {
    const seriesId = useLifeRecordsStore.getState().addRecurringEvent(
      {
        title: "Trening",
        date: dateKey(),
        startTime: "18:00",
        endTime: "19:30",
        kind: "personal",
      },
      { freq: "weekly", interval: 1, anchorDate: dateKey() },
    );
    const occ = useLifeRecordsStore
      .getState()
      .events.filter((event) => event.seriesId === seriesId);
    expect(occ).toHaveLength(SERIES_WINDOW);
    expect(occ.every((event) => event.startTime === "18:00" && event.endTime === "19:30")).toBe(
      true,
    );
  });

  it("deleteEventSeries kasuje wszystkie wystąpienia serii", () => {
    const seriesId = useLifeRecordsStore.getState().addRecurringEvent(
      {
        title: "Do usunięcia",
        date: dateKey(),
        startTime: "09:00",
        endTime: "09:30",
        kind: "personal",
      },
      { freq: "daily", interval: 1, anchorDate: dateKey() },
    );
    useLifeRecordsStore.getState().deleteEventSeries(seriesId);
    expect(
      useLifeRecordsStore.getState().events.filter((event) => event.seriesId === seriesId),
    ).toHaveLength(0);
  });

  it("expandRecurringSeries jest no-op, gdy okno jest pełne (bez zbędnego zapisu)", () => {
    useLifeRecordsStore.getState().addRecurringEvent(
      {
        title: "Pełne okno",
        date: dateKey(),
        startTime: "09:00",
        endTime: "09:30",
        kind: "personal",
      },
      { freq: "daily", interval: 1, anchorDate: dateKey() },
    );
    const before = useLifeRecordsStore.getState().events;
    useLifeRecordsStore.getState().expandRecurringSeries();
    expect(useLifeRecordsStore.getState().events).toBe(before); // ta sama referencja = brak zapisu
  });

  it("updateEventSeries zmienia godzinę serii (anchorTime) na przyszłych wystąpieniach", () => {
    const today = dateKey();
    const seriesId = useLifeRecordsStore
      .getState()
      .addRecurringEvent(
        { title: "Trening", date: today, startTime: "18:00", endTime: "19:00", kind: "personal" },
        { freq: "daily", interval: 1, anchorDate: today, anchorTime: "18:00" },
      );
    useLifeRecordsStore.getState().updateEventSeries(seriesId, {
      title: "Trening",
      startTime: "20:00",
      endTime: "21:00",
      recurrence: { freq: "daily", interval: 1, anchorDate: today, anchorTime: "20:00" },
    });
    const occ = useLifeRecordsStore
      .getState()
      .events.filter((event) => event.seriesId === seriesId);
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.every((event) => event.startTime === "20:00" && event.endTime === "21:00")).toBe(
      true,
    );
  });

  it("updateEventSeries zmniejsza limit count i przycina przyszłe wystąpienia ponad limit", () => {
    const today = dateKey();
    const seriesId = useLifeRecordsStore
      .getState()
      .addRecurringEvent(
        { title: "Limit", date: today, startTime: "09:00", endTime: "09:30", kind: "personal" },
        { freq: "daily", interval: 1, anchorDate: today },
      );
    expect(
      useLifeRecordsStore.getState().events.filter((event) => event.seriesId === seriesId),
    ).toHaveLength(SERIES_WINDOW);
    useLifeRecordsStore.getState().updateEventSeries(seriesId, {
      title: "Limit",
      startTime: "09:00",
      endTime: "09:30",
      recurrence: { freq: "daily", interval: 1, anchorDate: today, count: 3 },
    });
    expect(
      useLifeRecordsStore.getState().events.filter((event) => event.seriesId === seriesId),
    ).toHaveLength(3);
  });

  it("updateEventSeries propaguje zmianę widoczności na całą serię, także przeszłe wystąpienia", () => {
    const past = dateKey(addDays(new Date(), -3));
    const future = dateKey(addDays(new Date(), 3));
    const recurrence = { freq: "daily" as const, interval: 1, anchorDate: past };
    const timestamp = new Date().toISOString();
    const shared = {
      title: "Widoczność",
      startTime: "09:00",
      endTime: "09:30",
      kind: "personal" as const,
      version: 1,
      updatedAt: timestamp,
      seriesId: "s-vis",
      recurrence,
      visibility: "household" as const,
    };
    seedTasks([]);
    useLifeRecordsStore.setState({
      events: [
        { ...shared, id: "s-vis#0", date: past, seriesIndex: 0 },
        { ...shared, id: "s-vis#5", date: future, seriesIndex: 5 },
      ],
    });
    useLifeRecordsStore.getState().updateEventSeries("s-vis", { visibility: "private" });
    const events = useLifeRecordsStore.getState().events;
    expect(events.find((event) => event.id === "s-vis#0")?.visibility).toBe("private"); // przeszłe też
    expect(events.find((event) => event.id === "s-vis#5")?.visibility).toBe("private");
  });
});

// ---------------------------------------------------------------------------
// Gap 2 coverage (docs/plans/zadania-kalendarz-notatki-nawyki-sql.md "Testy — Nowe"): the
// offline-first mutation queue itself (idempotency keys, silent rebase on *.update conflict,
// adoption of conflict/ID_TAKEN on *.create), toggleHabit's absolute-set semantics,
// snoozeReminder/markReminderNotified, and basic CRUD for events/reminders/notes/habits -- the
// describe block above only ever exercised `tasks` + the recurrence engine.
// ---------------------------------------------------------------------------

const isoNow = "2026-01-01T00:00:00.000Z";

function sampleEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "event-1",
    title: "Stand-up",
    date: "2026-07-20",
    startTime: "09:00",
    endTime: "09:30",
    kind: "meeting",
    version: 1,
    updatedAt: isoNow,
    ownerId: "me",
    visibility: "household",
    ...overrides,
  };
}

function sampleReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "reminder-1",
    title: "Zadzwonić do lekarza",
    date: "2026-07-20",
    time: "10:00",
    done: false,
    version: 1,
    updatedAt: isoNow,
    ownerId: "me",
    visibility: "household",
    ...overrides,
  };
}

function sampleNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    title: "Pomysł",
    content: "Kupić kwiaty",
    color: "mint",
    pinned: false,
    createdAt: isoNow,
    version: 1,
    updatedAt: isoNow,
    ownerId: "me",
    visibility: "household",
    ...overrides,
  };
}

function sampleHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: "habit-1",
    name: "Pić wodę",
    icon: "water",
    targetLabel: "8 szklanek dziennie",
    completedDates: [],
    version: 1,
    updatedAt: isoNow,
    ownerId: "me",
    visibility: "household",
    ...overrides,
  };
}

function seedAll(overrides: Partial<ReturnType<typeof useLifeRecordsStore.getState>> = {}) {
  useLifeRecordsStore.setState({
    tasks: [],
    events: [],
    reminders: [],
    notes: [],
    habits: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: true,
    ...overrides,
  });
}

describe("kolejka mutacji: idempotencja i kształt pendingMutations", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAll();
  });

  it("każda zakolejkowana mutacja dostaje WŁASNY, unikalny idempotencyKey", () => {
    useLifeRecordsStore.getState().addTask({
      title: "Zadanie 1",
      priority: "medium",
      tags: ["Dom"],
      isFocus: false,
      energy: "low",
    });
    useLifeRecordsStore.getState().addNote({
      title: "Notatka",
      content: "",
      color: "cream",
      pinned: false,
    });
    const mutations = useLifeRecordsStore.getState().pendingMutations;
    expect(mutations).toHaveLength(2);
    expect(mutations[0].idempotencyKey).not.toBe(mutations[1].idempotencyKey);
    expect(mutations[0].idempotencyKey.length).toBeGreaterThan(0);
  });

  it("kształt PendingLifeMutation: idempotencyKey, op, payload i opcjonalny baseVersion (obecny tylko na *.update/*.delete z baseVersion)", () => {
    seedAll({ tasks: [{ ...sampleTaskShape(), id: "task-1" }] });
    useLifeRecordsStore.getState().deleteTask("task-1");
    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    expect(mutation).toHaveProperty("idempotencyKey");
    expect(mutation.op).toBe("task.delete");
    expect(mutation.payload).toEqual({ id: "task-1" });
    // task.delete nie niesie baseVersion (usuwanie jest idempotentne z definicji, bez OCC).
    expect(mutation.baseVersion).toBeUndefined();
  });

  it("dwie niezależne mutacje na RÓŻNYCH rekordach obie trafiają do kolejki niezależnie (brak wzajemnej kolizji)", () => {
    seedAll({
      tasks: [
        { ...sampleTaskShape(), id: "task-a", version: 1 },
        { ...sampleTaskShape(), id: "task-b", version: 1 },
      ],
    });
    useLifeRecordsStore.getState().updateTask("task-a", { title: "A zmienione" });
    useLifeRecordsStore.getState().updateTask("task-b", { title: "B zmienione" });
    const mutations = useLifeRecordsStore.getState().pendingMutations;
    expect(mutations).toHaveLength(2);
    expect(mutations.map((m) => (m.payload as { id: string }).id).sort()).toEqual([
      "task-a",
      "task-b",
    ]);
  });
});

function sampleTaskShape(): Task {
  return {
    id: "task-shape",
    title: "Zadanie",
    status: "todo",
    priority: "medium",
    tags: ["Dom"],
    isFocus: false,
    energy: "low",
    createdAt: isoNow,
    version: 1,
    updatedAt: isoNow,
  };
}

describe("podstawowe CRUD: events/reminders/notes/habits", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAll();
  });

  it("addEvent/updateEvent/deleteEvent: dodaje optymistycznie, aktualizuje dozwolone pola z baseVersion, usuwa i kolejkuje", () => {
    const eventId = useLifeRecordsStore.getState().addEvent({
      title: "Stand-up",
      date: "2026-07-20",
      startTime: "09:00",
      endTime: "09:30",
      kind: "meeting",
    });
    expect(useLifeRecordsStore.getState().events).toHaveLength(1);
    let mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation.op).toBe("event.create");
    expect(mutation.payload).toMatchObject({ id: eventId, title: "Stand-up" });

    useLifeRecordsStore
      .getState()
      .updateEvent(eventId, { location: "Sala A", visibility: "private" });
    const event = useLifeRecordsStore.getState().events.find((item) => item.id === eventId);
    expect(event?.location).toBe("Sala A");
    expect(event?.visibility).toBe("private");
    mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation).toMatchObject({ op: "event.update", baseVersion: 1 });
    expect(mutation.payload).toEqual({
      id: eventId,
      changes: { location: "Sala A", visibility: "private" },
    });

    useLifeRecordsStore.getState().deleteEvent(eventId);
    expect(useLifeRecordsStore.getState().events).toHaveLength(0);
    mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation).toMatchObject({ op: "event.delete", payload: { id: eventId } });
  });

  it("addReminder/deleteReminder: domyślnie done=false, kolejkuje reminder.create/reminder.delete", () => {
    const reminderId = useLifeRecordsStore.getState().addReminder({
      title: "Zadzwonić do lekarza",
      date: "2026-07-20",
      time: "10:00",
    });
    const reminder = useLifeRecordsStore
      .getState()
      .reminders.find((item) => item.id === reminderId);
    expect(reminder?.done).toBe(false);
    let mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation.op).toBe("reminder.create");
    expect(mutation.payload).toMatchObject({ id: reminderId, done: false });

    useLifeRecordsStore.getState().deleteReminder(reminderId);
    expect(useLifeRecordsStore.getState().reminders).toHaveLength(0);
    mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation).toMatchObject({ op: "reminder.delete", payload: { id: reminderId } });
  });

  it("toggleReminder liczy done lokalnie (real flip) i wysyła reminder.update{changes:{done}}", () => {
    seedAll({ reminders: [sampleReminder({ done: false })] });
    useLifeRecordsStore.getState().toggleReminder("reminder-1");
    expect(
      useLifeRecordsStore.getState().reminders.find((item) => item.id === "reminder-1")?.done,
    ).toBe(true);
    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "reminder.update",
      baseVersion: 1,
      payload: { id: "reminder-1", changes: { done: true } },
    });

    useLifeRecordsStore.getState().toggleReminder("reminder-1");
    expect(
      useLifeRecordsStore.getState().reminders.find((item) => item.id === "reminder-1")?.done,
    ).toBe(false);
  });

  it("addNote/updateNote/deleteNote: content pusty string dozwolony, update wysyła tylko dozwolone pola", () => {
    const noteId = useLifeRecordsStore.getState().addNote({
      title: "Pomysł",
      content: "",
      color: "cream",
      pinned: false,
    });
    expect(useLifeRecordsStore.getState().notes.find((item) => item.id === noteId)?.content).toBe(
      "",
    );

    useLifeRecordsStore.getState().updateNote(noteId, { pinned: true, visibility: "private" });
    const note = useLifeRecordsStore.getState().notes.find((item) => item.id === noteId);
    expect(note?.pinned).toBe(true);
    expect(note?.visibility).toBe("private");
    const mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation.payload).toEqual({
      id: noteId,
      changes: { pinned: true, visibility: "private" },
    });

    useLifeRecordsStore.getState().deleteNote(noteId);
    expect(useLifeRecordsStore.getState().notes).toHaveLength(0);
  });

  it("addHabit/deleteHabit: nowy nawyk zaczyna z pustym completedDates, kolejkuje habit.create/habit.delete", () => {
    useLifeRecordsStore.getState().addHabit({
      name: "Pić wodę",
      icon: "water",
      targetLabel: "8 szklanek dziennie",
    });
    const habit = useLifeRecordsStore.getState().habits.find((item) => item.name === "Pić wodę")!;
    expect(habit.completedDates).toEqual([]);
    let mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation.op).toBe("habit.create");
    expect(mutation.payload).toMatchObject({ completedDates: [] });

    useLifeRecordsStore.getState().deleteHabit(habit.id);
    expect(useLifeRecordsStore.getState().habits).toHaveLength(0);
    mutation = useLifeRecordsStore.getState().pendingMutations.at(-1)!;
    expect(mutation).toMatchObject({ op: "habit.delete", payload: { id: habit.id } });
  });
});

describe("toggleHabit: absolutny set, nie prawdziwy flip", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAll();
  });

  it("dodaje datę do completedDates i wysyła CAŁĄ przeliczoną tablicę jako habit.update{changes:{completedDates}}", () => {
    seedAll({ habits: [sampleHabit({ completedDates: ["2026-07-17"] })] });
    useLifeRecordsStore.getState().toggleHabit("habit-1", "2026-07-18");
    const habit = useLifeRecordsStore.getState().habits.find((item) => item.id === "habit-1");
    expect(habit?.completedDates).toEqual(["2026-07-17", "2026-07-18"]);
    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({
      op: "habit.update",
      baseVersion: 1,
      payload: { id: "habit-1", changes: { completedDates: ["2026-07-17", "2026-07-18"] } },
    });
  });

  it("przełączenie JUŻ zaznaczonej daty USUWA ją z tablicy (a nie ustawia ponownie) -- to odróżnia absolutny set od zwykłego 'set true'", () => {
    seedAll({ habits: [sampleHabit({ completedDates: ["2026-07-17", "2026-07-18"] })] });
    useLifeRecordsStore.getState().toggleHabit("habit-1", "2026-07-18");
    const habit = useLifeRecordsStore.getState().habits.find((item) => item.id === "habit-1");
    expect(habit?.completedDates).toEqual(["2026-07-17"]);
    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    expect(mutation.payload).toEqual({
      id: "habit-1",
      changes: { completedDates: ["2026-07-17"] },
    });
  });

  it("dwa kolejne toggle'e offline nettują się z bieżącego (już zmienionego) stanu lokalnego, każdy z własnym idempotencyKey", () => {
    seedAll({ habits: [sampleHabit({ completedDates: [] })] });
    useLifeRecordsStore.getState().toggleHabit("habit-1", "2026-07-18");
    useLifeRecordsStore.getState().toggleHabit("habit-1", "2026-07-19");
    const habit = useLifeRecordsStore.getState().habits.find((item) => item.id === "habit-1");
    expect(habit?.completedDates).toEqual(["2026-07-18", "2026-07-19"]);
    const mutations = useLifeRecordsStore.getState().pendingMutations;
    expect(mutations).toHaveLength(2);
    expect(mutations[0].idempotencyKey).not.toBe(mutations[1].idempotencyKey);
    expect(mutations[1].payload).toEqual({
      id: "habit-1",
      changes: { completedDates: ["2026-07-18", "2026-07-19"] },
    });
  });
});

describe("snoozeReminder / markReminderNotified", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAll();
  });

  it("snoozeReminder przelicza date/time na teraz+minuty i CZYŚCI notifiedAt (wysyła changes:{date,time,notifiedAt:null})", () => {
    seedAll({ reminders: [sampleReminder({ notifiedAt: "2026-07-18T09:00:00.000Z" })] });
    useLifeRecordsStore.getState().snoozeReminder("reminder-1", 30);
    const reminder = useLifeRecordsStore
      .getState()
      .reminders.find((item) => item.id === "reminder-1");
    expect(reminder?.notifiedAt).toBeUndefined();
    expect(reminder?.date).toBeTruthy();
    expect(reminder?.time).toMatch(/^\d{2}:\d{2}$/);

    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "reminder.update", baseVersion: 1 });
    const payload = mutation.payload as { id: string; changes: Record<string, unknown> };
    expect(payload.id).toBe("reminder-1");
    expect(payload.changes.notifiedAt).toBeNull();
    expect(payload.changes.date).toBe(reminder?.date);
    expect(payload.changes.time).toBe(reminder?.time);
  });

  it("markReminderNotified USTAWIA notifiedAt lokalnie i wysyła changes:{notifiedAt}", () => {
    seedAll({ reminders: [sampleReminder({ notifiedAt: undefined })] });
    useLifeRecordsStore.getState().markReminderNotified("reminder-1");
    const reminder = useLifeRecordsStore
      .getState()
      .reminders.find((item) => item.id === "reminder-1");
    expect(reminder?.notifiedAt).toBeTruthy();

    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    expect(mutation).toMatchObject({ op: "reminder.update", baseVersion: 1 });
    const payload = mutation.payload as { id: string; changes: Record<string, unknown> };
    expect(payload.changes.notifiedAt).toBe(reminder?.notifiedAt);
  });
});

describe("applyMutationResults: cichy rebase na *.update, adopcja conflict/ID_TAKEN na *.create", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAll();
  });

  it("applied/duplicate/error zdejmują mutację z kolejki bez ponawiania", () => {
    seedAll({ notes: [sampleNote()] });
    useLifeRecordsStore.getState().deleteNote("note-1");
    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    useLifeRecordsStore
      .getState()
      .applyMutationResults([{ idempotencyKey: mutation.idempotencyKey, status: "duplicate" }]);
    expect(useLifeRecordsStore.getState().pendingMutations).toHaveLength(0);

    seedAll({ notes: [sampleNote()] });
    useLifeRecordsStore.getState().deleteNote("note-1");
    const mutation2 = useLifeRecordsStore.getState().pendingMutations[0];
    useLifeRecordsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation2.idempotencyKey,
        status: "error",
        error: "Rekord nie istnieje",
        code: "NOT_FOUND",
      },
    ]);
    expect(useLifeRecordsStore.getState().pendingMutations).toHaveLength(0);
  });

  it("conflict na *.update (task) robi cichy rebase: przyjmuje świeży rekord jako bazę, reaplikuje TYLKO deltę z nowym idempotencyKey i świeżym baseVersion", () => {
    seedAll({ tasks: [{ ...sampleTaskShape(), id: "task-1", version: 3, title: "Stary" }] });
    useLifeRecordsStore.getState().updateTask("task-1", { title: "Mój nowy tytuł" });
    const original = useLifeRecordsStore.getState().pendingMutations[0];
    expect(original.baseVersion).toBe(3);

    useLifeRecordsStore.getState().applyMutationResults([
      {
        idempotencyKey: original.idempotencyKey,
        status: "conflict",
        currentVersion: 4,
        record: {
          ...sampleTaskShape(),
          id: "task-1",
          title: "Ktoś inny zmienił",
          tags: ["Zmienione gdzie indziej"],
          version: 4,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    ]);

    const task = useLifeRecordsStore.getState().tasks.find((item) => item.id === "task-1");
    // Delta ("Mój nowy tytuł") wygrywa, ale pola zmienione gdzie indziej ("Zmienione gdzie
    // indziej") są zachowane -- to jest silent rebase, nie zwykłe last-write-wins.
    expect(task?.title).toBe("Mój nowy tytuł");
    expect(task?.tags).toEqual(["Zmienione gdzie indziej"]);
    expect(task?.version).toBe(4);

    const rebased = useLifeRecordsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].idempotencyKey).not.toBe(original.idempotencyKey);
    expect(rebased[0].baseVersion).toBe(4);
    expect(rebased[0].payload).toEqual({ id: "task-1", changes: { title: "Mój nowy tytuł" } });
  });

  it("conflict na *.update (habit, toggleHabit) robi cichy rebase zachowując zamierzony toggle completedDates", () => {
    seedAll({ habits: [sampleHabit({ version: 2, completedDates: ["2026-07-17"] })] });
    useLifeRecordsStore.getState().toggleHabit("habit-1", "2026-07-18");
    const original = useLifeRecordsStore.getState().pendingMutations[0];
    expect(original.baseVersion).toBe(2);

    // Another device bumped the record (renamed it) in the meantime.
    useLifeRecordsStore.getState().applyMutationResults([
      {
        idempotencyKey: original.idempotencyKey,
        status: "conflict",
        currentVersion: 3,
        record: {
          ...sampleHabit({ completedDates: ["2026-07-17"] }),
          name: "Nazwa zmieniona gdzie indziej",
          version: 3,
        },
      },
    ]);

    const habit = useLifeRecordsStore.getState().habits.find((item) => item.id === "habit-1");
    expect(habit?.name).toBe("Nazwa zmieniona gdzie indziej");
    expect(habit?.completedDates).toEqual(["2026-07-17", "2026-07-18"]);
    expect(habit?.version).toBe(3);
    const rebased = useLifeRecordsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].baseVersion).toBe(3);
    expect(rebased[0].payload).toEqual({
      id: "habit-1",
      changes: { completedDates: ["2026-07-17", "2026-07-18"] },
    });
  });

  it("conflict na *.update (reminder, snoozeReminder) robi cichy rebase zachowując snooze", () => {
    seedAll({
      reminders: [sampleReminder({ version: 1, notifiedAt: "2026-07-18T09:00:00.000Z" })],
    });
    useLifeRecordsStore.getState().snoozeReminder("reminder-1", 15);
    const original = useLifeRecordsStore.getState().pendingMutations[0];
    const intendedChanges = (original.payload as { changes: Record<string, unknown> }).changes;

    useLifeRecordsStore.getState().applyMutationResults([
      {
        idempotencyKey: original.idempotencyKey,
        status: "conflict",
        currentVersion: 2,
        record: { ...sampleReminder(), title: "Tytuł zmieniony gdzie indziej", version: 2 },
      },
    ]);

    const reminder = useLifeRecordsStore
      .getState()
      .reminders.find((item) => item.id === "reminder-1");
    expect(reminder?.title).toBe("Tytuł zmieniony gdzie indziej");
    // snooze's intended delta ({notifiedAt: null}) still wins over the fresh server record it's
    // rebased onto -- the rebase re-applies the literal payload, so this is `null`, not
    // `undefined` (undefined would mean the field was never touched by the rebase at all).
    expect(reminder?.notifiedAt).toBeNull();
    expect(reminder?.version).toBe(2);
    const rebased = useLifeRecordsStore.getState().pendingMutations;
    expect(rebased).toHaveLength(1);
    expect(rebased[0].baseVersion).toBe(2);
    expect(rebased[0].payload).toEqual({ id: "reminder-1", changes: intendedChanges });
  });

  it("applyMutationResults adoptuje serwerowy rekord na *.create applied (event/note)", () => {
    const eventId = useLifeRecordsStore.getState().addEvent({
      title: "Stand-up",
      date: "2026-07-20",
      startTime: "09:00",
      endTime: "09:30",
      kind: "meeting",
    });
    const mutation = useLifeRecordsStore.getState().pendingMutations[0];
    useLifeRecordsStore.getState().applyMutationResults([
      {
        idempotencyKey: mutation.idempotencyKey,
        status: "applied",
        record: { ...sampleEvent({ id: eventId }), updatedAt: "2026-01-02T00:00:00.000Z" },
      },
    ]);
    expect(useLifeRecordsStore.getState().pendingMutations).toHaveLength(0);
    expect(
      useLifeRecordsStore.getState().events.find((item) => item.id === eventId)?.updatedAt,
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("applyMutationResults na conflict/ID_TAKEN (*.create, kolizja id) ADOPTUJE zwrócony serwerowy rekord dokładnie tak jak przy 'applied' -- to NIE trafia do ścieżki cichego rebase'u update'ów", () => {
    const taskId = "task-collide";
    seedAll({
      tasks: [{ ...sampleTaskShape(), id: taskId, title: "Moja lokalna wersja" }],
      pendingMutations: [
        {
          idempotencyKey: "key-1",
          op: "task.create",
          payload: { id: taskId, title: "Moja lokalna wersja" },
        },
      ],
    });

    const result: LifeMutationResult = {
      idempotencyKey: "key-1",
      status: "conflict",
      code: "ID_TAKEN",
      currentVersion: 1,
      record: {
        ...sampleTaskShape(),
        id: taskId,
        title: "Wersja z innego urządzenia (serwer)",
        version: 1,
      },
    };
    useLifeRecordsStore.getState().applyMutationResults([result]);

    // The queue drains (this is treated as terminal, not rebased/retried)...
    expect(useLifeRecordsStore.getState().pendingMutations).toHaveLength(0);
    // ...and the server's record (not the local attempt) wins outright, exactly like `applied`.
    const task = useLifeRecordsStore.getState().tasks.find((item) => item.id === taskId);
    expect(task?.title).toBe("Wersja z innego urządzenia (serwer)");
  });
});

describe("resetLifeRecordsData", () => {
  it("czyści wszystkie pięć kolekcji, kolejkę mutacji i flagę hydrated", () => {
    seedAll({
      tasks: [sampleTaskShape()],
      events: [sampleEvent()],
      reminders: [sampleReminder()],
      notes: [sampleNote()],
      habits: [sampleHabit()],
      pendingMutations: [{ idempotencyKey: "x", op: "task.create", payload: { id: "task-shape" } }],
    });
    useLifeRecordsStore.getState().resetLifeRecordsData();
    const state = useLifeRecordsStore.getState();
    expect(state.tasks).toHaveLength(0);
    expect(state.events).toHaveLength(0);
    expect(state.reminders).toHaveLength(0);
    expect(state.notes).toHaveLength(0);
    expect(state.habits).toHaveLength(0);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.hydrated).toBe(false);
  });
});
