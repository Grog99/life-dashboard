import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncIndicator } from "./SyncIndicator";
import { useSyncStatusStore, type ModuleSyncState } from "../store/useSyncStatusStore";

const report = (module: string, state: ModuleSyncState) =>
  act(() => useSyncStatusStore.getState().report(module, state));

describe("SyncIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSyncStatusStore.setState({ states: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("jest ukryty, gdy żaden moduł nie raportuje aktywności", () => {
    render(<SyncIndicator />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("pokazuje JEDEN wskaźnik 'Synchronizuję…' przy zapisie w wielu modułach", () => {
    render(<SyncIndicator />);
    report("finance", "saving");
    report("health", "saving");

    const indicators = screen.getAllByRole("status");
    expect(indicators).toHaveLength(1);
    expect(indicators[0]).toHaveTextContent("Synchronizuję…");
  });

  it("offline ma priorytet nad zapisem", () => {
    render(<SyncIndicator />);
    report("finance", "saving");
    report("car", "offline");
    expect(screen.getByRole("status")).toHaveTextContent("Zmiany czekają na sieć");
  });

  it("po zsynchronizowaniu pokazuje krótko 'Zsynchronizowano', potem znika", () => {
    render(<SyncIndicator />);
    report("finance", "saving");
    expect(screen.getByRole("status")).toHaveTextContent("Synchronizuję…");

    report("finance", "synced");
    expect(screen.getByRole("status")).toHaveTextContent("Zsynchronizowano");

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
