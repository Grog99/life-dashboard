import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddModal } from "./QuickAddModal";
import { createSampleData } from "../data/sampleData";
import { useLifeStore } from "../store/useLifeStore";

describe("QuickAddModal", () => {
  beforeEach(() => {
    localStorage.clear();
    useLifeStore.setState({ ...createSampleData(), tasks: [] });
  });

  afterEach(() => cleanup());

  it("tworzy zadanie priorytetowe, gdy checkbox jest zaznaczony", async () => {
    const user = userEvent.setup();
    render(<QuickAddModal open onClose={vi.fn()} initialType="task" />);

    await user.type(screen.getByLabelText("Co chcesz zapisać?"), "Przygotować raport");
    await user.click(screen.getByRole("checkbox", { name: /Zadanie priorytetowe/i }));
    await user.click(screen.getByRole("button", { name: "Dodaj zadanie" }));

    const created = useLifeStore
      .getState()
      .tasks.find((task) => task.title === "Przygotować raport");
    expect(created?.isFocus).toBe(true);
  });

  it("domyślnie tworzy zadanie bez priorytetu", async () => {
    const user = userEvent.setup();
    render(<QuickAddModal open onClose={vi.fn()} initialType="task" />);

    await user.type(screen.getByLabelText("Co chcesz zapisać?"), "Umyć okna");
    await user.click(screen.getByRole("button", { name: "Dodaj zadanie" }));

    const created = useLifeStore.getState().tasks.find((task) => task.title === "Umyć okna");
    expect(created?.isFocus).toBe(false);
  });

  it("nie pokazuje checkboxa priorytetu dla innych typów", () => {
    render(<QuickAddModal open onClose={vi.fn()} initialType="event" />);
    expect(
      screen.queryByRole("checkbox", { name: /Zadanie priorytetowe/i }),
    ).not.toBeInTheDocument();
  });
});
