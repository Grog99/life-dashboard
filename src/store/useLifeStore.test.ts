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
