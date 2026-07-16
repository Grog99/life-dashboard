import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdvancedData } from "../data/advancedData";
import { createSampleData } from "../data/sampleData";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useLifeStore } from "../store/useLifeStore";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, apiRequest };
});

import { ApiError } from "./api";
import { WorkspaceSync } from "./WorkspaceSync";

const scope = "user-1:house-1";

describe("WorkspaceSync regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLifeStore.setState(createSampleData());
    useAdvancedStore.setState(createAdvancedData());
    localStorage.clear();
  });

  afterEach(() => cleanup());

  it("reports an expired session instead of treating 401 as offline mode", async () => {
    const onSessionExpired = vi.fn();
    apiRequest.mockRejectedValueOnce(new ApiError(401, "Sesja wygasła", "UNAUTHENTICATED"));

    render(
      <WorkspaceSync scope={scope} onSessionExpired={onSessionExpired}>
        <span>dashboard</span>
      </WorkspaceSync>,
    );

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
  });

  it("aborts the active request when its scope unmounts", async () => {
    let signal: AbortSignal | undefined;
    apiRequest.mockImplementation((_path: string, options?: RequestInit) => {
      signal = options?.signal ?? undefined;
      return new Promise(() => undefined);
    });

    const view = render(
      <WorkspaceSync scope={scope} onSessionExpired={vi.fn()}>
        <span>dashboard</span>
      </WorkspaceSync>,
    );
    await waitFor(() => expect(signal).toBeDefined());

    view.unmount();

    expect(signal?.aborted).toBe(true);
  });

  it("retries a dirty workspace immediately when the browser comes online", async () => {
    apiRequest
      .mockRejectedValueOnce(new Error("network offline"))
      .mockResolvedValueOnce({ revision: 1 });

    render(
      <WorkspaceSync scope={scope} onSessionExpired={vi.fn()}>
        <span>dashboard</span>
      </WorkspaceSync>,
    );
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    act(() => useLifeStore.getState().setIntention("Zmiana offline"));
    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    expect(apiRequest.mock.calls[1][1]).toMatchObject({ method: "PUT" });
    await waitFor(() => expect(localStorage.getItem(`puls-sync-dirty:${scope}`)).toBeNull());
  });

  it("merges a persisted dirty workspace before syncing after an offline cold start", async () => {
    const baseLife = { ...createSampleData(), intention: "Wersja bazowa" };
    const remoteLife = { ...createSampleData(), intention: "Zmiana z drugiego urządzenia" };
    const advanced = createAdvancedData();
    useLifeStore.setState({ ...createSampleData(), intention: "Moja zmiana offline" });
    localStorage.setItem("puls-life-dashboard", "{}");
    localStorage.setItem("puls-advanced-dashboard", "{}");
    localStorage.setItem(`puls-sync-dirty:${scope}`, "1");
    localStorage.setItem(
      `puls-sync-base:${scope}`,
      JSON.stringify({
        schemaVersion: 2,
        life: baseLife,
        advanced,
      }),
    );
    apiRequest
      .mockRejectedValueOnce(new Error("cold start offline"))
      .mockRejectedValueOnce(new ApiError(409, "Konflikt", "REVISION_CONFLICT"))
      .mockResolvedValueOnce({
        revision: 1,
        data: { schemaVersion: 2, life: remoteLife, advanced },
      })
      .mockResolvedValueOnce({ revision: 2 });

    render(
      <WorkspaceSync scope={scope} onSessionExpired={vi.fn()}>
        <span>dashboard</span>
      </WorkspaceSync>,
    );
    expect(await screen.findByText("dashboard")).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(localStorage.getItem(`puls-sync-dirty:${scope}`)).toBeNull());
    expect(useLifeStore.getState().intention).toBe("Moja zmiana offline");
    expect(apiRequest.mock.calls[3][1]?.json).toMatchObject({
      data: { life: { intention: "Moja zmiana offline" } },
    });
  });

  it("refetches an empty workspace so server-provided household metadata replaces demo data", async () => {
    const advanced = {
      ...createAdvancedData(),
      householdName: "Rodzina Testowa",
      householdMembers: [
        {
          id: "user-1",
          name: "Ola",
          email: "ola@example.com",
          role: "owner" as const,
          color: "#397763",
        },
      ],
    };
    const enriched = {
      revision: 1,
      data: { schemaVersion: 2, life: createSampleData(), advanced },
    };
    apiRequest
      .mockResolvedValueOnce({ revision: 0, data: {} })
      .mockResolvedValueOnce({ revision: 1 })
      .mockResolvedValueOnce(enriched);

    render(
      <WorkspaceSync scope={scope} onSessionExpired={vi.fn()}>
        <span>dashboard</span>
      </WorkspaceSync>,
    );

    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(useAdvancedStore.getState().householdName).toBe("Rodzina Testowa");
    expect(useAdvancedStore.getState().householdMembers).toHaveLength(1);
    expect(apiRequest).toHaveBeenCalledTimes(3);
    expect(apiRequest.mock.calls[1][1]).toMatchObject({ method: "PUT" });
  });
});
