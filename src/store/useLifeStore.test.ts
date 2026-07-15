import { beforeEach, describe, expect, it } from "vitest";
import { createSampleData } from "../data/sampleData";
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
    expect(useLifeStore.getState().tasks.filter((task) => task.isFocus && task.status === "todo")).toHaveLength(3);
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
    const habit = useLifeStore.getState().habits.find((item) => item.name === "Rytuał bez widoczności");
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
    const merged = merge(persistedState, useLifeStore.getState()) as ReturnType<typeof useLifeStore.getState>;

    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0].id).toBe(sample.tasks[0].id);
    expect(merged.events).toEqual(sample.events);
    expect(merged.notes).toEqual(sample.notes);
  });
});
