import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { createSampleData } from "./data/sampleData";
import { useLifeStore } from "./store/useLifeStore";
import { useLifeRecordsStore } from "./store/useLifeRecordsStore";
import { createAdvancedData } from "./data/advancedData";
import { useAdvancedStore } from "./store/useAdvancedStore";
import { useTripsStore } from "./store/useTripsStore";

const now = new Date().toISOString();

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    useLifeStore.setState(createSampleData());
    useLifeRecordsStore.setState({
      tasks: [
        {
          id: "task-focus",
          title: "Dokończyć prezentację projektu",
          status: "todo",
          priority: "high",
          category: "Praca",
          isFocus: true,
          energy: "high",
          ownerId: "me",
          visibility: "private",
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      events: [],
      reminders: [],
      notes: [],
      habits: [],
      pendingMutations: [],
      serverAt: null,
      hydrated: true,
    });
    useAdvancedStore.setState(createAdvancedData());
    // Podróże nie są już seedowane w createAdvancedData() (docs/plans/podroze-trips.md -- domyślny
    // stan offline jest pusty, serwer jest źródłem prawdy). Dorzuć jedną podróż, żeby test nawigacji
    // trafiał na widok "Planer podróży" zamiast na pusty stan "Zaplanuj następny wyjazd".
    useTripsStore.getState().resetTripsData();
    useTripsStore.getState().addTrip({
      name: "Toskania 2026",
      destination: "Florencja",
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      status: "planning",
      currency: "PLN",
      travelers: ["Ty"],
      accent: "terracotta",
      notes: "",
    });
  });

  afterEach(() => cleanup());

  it("pokazuje najważniejsze elementy widoku dnia", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /Najważniejsze dzisiaj/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Plan na dziś/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Szybka notatka/i })).toBeInTheDocument();
  });

  it("ukrywa sekcję „Najważniejsze dzisiaj”, gdy nie ma priorytetów na dziś", () => {
    useLifeRecordsStore.setState({
      tasks: useLifeRecordsStore.getState().tasks.map((task) => ({ ...task, isFocus: false })),
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
