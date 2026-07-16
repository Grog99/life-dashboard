import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { createSampleData } from "./data/sampleData";
import { useLifeStore } from "./store/useLifeStore";
import { createAdvancedData } from "./data/advancedData";
import { useAdvancedStore } from "./store/useAdvancedStore";

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    useLifeStore.setState(createSampleData());
    useAdvancedStore.setState(createAdvancedData());
  });

  afterEach(() => cleanup());

  it("pokazuje najważniejsze elementy widoku dnia", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /Najważniejsze dzisiaj/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Plan na dziś/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Szybka notatka/i })).toBeInTheDocument();
  });

  it("ukrywa sekcję „Najważniejsze dzisiaj”, gdy nie ma priorytetów na dziś", () => {
    useLifeStore.setState({
      tasks: useLifeStore.getState().tasks.map((task) => ({ ...task, isFocus: false })),
    });
    render(<App />);
    expect(screen.queryByRole("heading", { name: /Najważniejsze dzisiaj/i })).toBeNull();
    expect(screen.getByRole("heading", { name: /Plan na dziś/i })).toBeInTheDocument();
  });

  it("otwiera wszystkie moduły zaawansowane z głównej nawigacji", async () => {
    const user = userEvent.setup();
    render(<App />);
    const modules = [
      ["Finanse", "Spokojny obraz pieniędzy"],
      ["Podróże", "Planer podróży"],
      ["Subskrypcje", "Subskrypcje"],
      ["Posiłki", "Posiłki"],
      ["Samochód", "Samochód"],
      ["Zdrowie", "Zdrowie"],
    ];
    for (const [navigation, heading] of modules) {
      await user.click(screen.getAllByRole("button", { name: navigation })[0]);
      expect(
        await screen.findByRole("heading", { name: heading, level: 1 }, { timeout: 5_000 }),
      ).toBeInTheDocument();
    }
  }, 15_000);

  it("obsługuje skrót PWA do szybkiego dodawania", async () => {
    window.history.replaceState(null, "", "/?quickAdd=1");
    render(<App />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.has("quickAdd")).toBe(false);
  });
});
