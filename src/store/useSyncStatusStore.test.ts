import { beforeEach, describe, expect, it } from "vitest";
import { aggregateSyncState, useSyncStatusStore } from "./useSyncStatusStore";

describe("aggregateSyncState", () => {
  it("pusta mapa (brak modułów) → synced", () => {
    expect(aggregateSyncState({})).toBe("synced");
  });

  it("wszystkie zsynchronizowane → synced", () => {
    expect(aggregateSyncState({ workspace: "synced", finance: "synced" })).toBe("synced");
  });

  it("dowolny moduł zapisuje → saving", () => {
    expect(aggregateSyncState({ workspace: "synced", finance: "saving" })).toBe("saving");
  });

  it("konflikt ma priorytet nad zapisem", () => {
    expect(aggregateSyncState({ workspace: "conflict", finance: "saving" })).toBe("conflict");
  });

  it("offline ma najwyższy priorytet", () => {
    expect(aggregateSyncState({ workspace: "conflict", finance: "saving", car: "offline" })).toBe(
      "offline",
    );
  });
});

describe("useSyncStatusStore", () => {
  beforeEach(() => {
    useSyncStatusStore.setState({ states: {} });
  });

  it("report zapisuje stan modułu, clear go usuwa", () => {
    useSyncStatusStore.getState().report("car", "saving");
    expect(useSyncStatusStore.getState().states).toEqual({ car: "saving" });

    useSyncStatusStore.getState().report("car", "synced");
    expect(useSyncStatusStore.getState().states).toEqual({ car: "synced" });

    useSyncStatusStore.getState().clear("car");
    expect(useSyncStatusStore.getState().states).toEqual({});
  });

  it("report tym samym stanem nie tworzy nowej referencji", () => {
    useSyncStatusStore.getState().report("car", "saving");
    const before = useSyncStatusStore.getState().states;
    useSyncStatusStore.getState().report("car", "saving");
    expect(useSyncStatusStore.getState().states).toBe(before);
  });
});
