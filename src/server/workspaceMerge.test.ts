import { describe, expect, it } from "vitest";
import { mergeWorkspaceChanges } from "./workspaceMerge";

describe("workspace three-way merge", () => {
  it("preserves independent local and remote entity changes", () => {
    const base = { tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }] };
    const local = { tasks: [{ id: "a", title: "A local" }, { id: "b", title: "B" }] };
    const remote = { tasks: [{ id: "a", title: "A" }, { id: "b", title: "B remote" }] };

    expect(mergeWorkspaceChanges(base, local, remote)).toEqual({
      tasks: [{ id: "a", title: "A local" }, { id: "b", title: "B remote" }],
    });
  });

  it("keeps a local addition and a remote addition", () => {
    const base = { notes: [] };
    const local = { notes: [{ id: "local", title: "L" }] };
    const remote = { notes: [{ id: "remote", title: "R" }] };

    expect(mergeWorkspaceChanges(base, local, remote)).toEqual({
      notes: [{ id: "remote", title: "R" }, { id: "local", title: "L" }],
    });
  });

  it("resolves a same-field edit conflict using the more recent updatedAt, not the local side", () => {
    const base = { notes: [{ id: "n1", title: "Original", updatedAt: "2026-01-01T00:00:00.000Z" }] };
    const local = { notes: [{ id: "n1", title: "Local edit", updatedAt: "2026-01-02T00:00:00.000Z" }] };
    const remote = { notes: [{ id: "n1", title: "Remote edit", updatedAt: "2026-01-03T00:00:00.000Z" }] };

    expect(mergeWorkspaceChanges(base, local, remote)).toEqual({
      notes: [{ id: "n1", title: "Remote edit", updatedAt: "2026-01-03T00:00:00.000Z" }],
    });

    // Recency, not argument position, should decide the winner.
    expect(mergeWorkspaceChanges(base, remote, local)).toEqual({
      notes: [{ id: "n1", title: "Remote edit", updatedAt: "2026-01-03T00:00:00.000Z" }],
    });
  });

  it("resolves a same-field edit conflict on a task using updatedAt, not just notes", () => {
    const base = { tasks: [{ id: "t1", title: "Original", status: "todo", updatedAt: "2026-01-01T00:00:00.000Z" }] };
    const local = { tasks: [{ id: "t1", title: "Local edit", status: "todo", updatedAt: "2026-01-02T00:00:00.000Z" }] };
    const remote = { tasks: [{ id: "t1", title: "Remote edit", status: "todo", updatedAt: "2026-01-03T00:00:00.000Z" }] };

    expect(mergeWorkspaceChanges(base, local, remote)).toEqual({
      tasks: [{ id: "t1", title: "Remote edit", status: "todo", updatedAt: "2026-01-03T00:00:00.000Z" }],
    });
  });

  it("keeps a concurrent delete over a concurrent edit of the same record, regardless of which side deleted", () => {
    const base = { tasks: [{ id: "t1", title: "Buy milk", status: "todo" }] };
    const deleted = { tasks: [] };
    const edited = { tasks: [{ id: "t1", title: "Buy milk and eggs", status: "todo" }] };

    expect(mergeWorkspaceChanges(base, deleted, edited)).toEqual({ tasks: [] });
    expect(mergeWorkspaceChanges(base, edited, deleted)).toEqual({ tasks: [] });
  });

  it("dwa urządzenia rozwijające tę samą serię nie tworzą duplikatów (deterministyczne id seriesId#index)", () => {
    // Wspólny przodek: jedno wystąpienie serii (index 0).
    const base = { tasks: [{ id: "s1#0", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 0 }] };
    // Urządzenie A rozwinęło okno do 3 wystąpień.
    const deviceA = {
      tasks: [
        { id: "s1#0", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 0 },
        { id: "s1#1", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 1 },
        { id: "s1#2", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 2 },
      ],
    };
    // Urządzenie B niezależnie rozwinęło okno o jedno wystąpienie dalej.
    const deviceB = {
      tasks: [
        { id: "s1#0", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 0 },
        { id: "s1#1", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 1 },
        { id: "s1#2", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 2 },
        { id: "s1#3", title: "Sprzątanie", status: "todo", seriesId: "s1", seriesIndex: 3 },
      ],
    };

    const merged = mergeWorkspaceChanges(base, deviceA, deviceB) as { tasks: Array<{ id: string }> };
    const ids = merged.tasks.map((task) => task.id);
    // Brak duplikatów — te same logiczne wystąpienia mają te same id.
    expect(ids).toEqual([...new Set(ids)]);
    expect([...ids].sort()).toEqual(["s1#0", "s1#1", "s1#2", "s1#3"]);
  });
});
