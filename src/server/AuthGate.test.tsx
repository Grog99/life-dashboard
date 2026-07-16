import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createAdvancedData } from "../data/advancedData";
import { createSampleData } from "../data/sampleData";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useLifeStore } from "../store/useLifeStore";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  removePush: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, apiRequest: mocks.apiRequest, serverMode: true };
});

vi.mock("./WorkspaceSync", () => ({
  WorkspaceSync: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./push", () => ({
  removeCurrentPushSubscription: mocks.removePush,
}));

import { ApiError, type AuthSnapshot } from "./api";
import { AuthGate, useServerAuth } from "./AuthGate";

const AUTH_SNAPSHOT_KEY = "puls-server-auth-snapshot";
const STORAGE_OWNER_KEY = "puls-server-storage-owner";

const snapshot = (id = "user-1", email = "ola@example.com"): AuthSnapshot => ({
  user: {
    id,
    email,
    name: id === "user-1" ? "Ola" : "Jan",
    locale: "pl-PL",
    timezone: "Europe/Warsaw",
  },
  activeHouseholdId: `house-${id}`,
  households: [
    {
      id: `house-${id}`,
      name: "Dom",
      currency: "PLN",
      timezone: "Europe/Warsaw",
      role: "owner",
    },
  ],
});

class FakeBroadcastChannel extends EventTarget {
  static instances: FakeBroadcastChannel[] = [];
  readonly name: string;
  postMessage = vi.fn();
  close = vi.fn();

  constructor(name: string) {
    super();
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function SessionProbe() {
  const { snapshot: current } = useServerAuth();
  return <span>{current?.user.email ?? "brak sesji"}</span>;
}

describe("AuthGate session regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    useLifeStore.setState(createSampleData());
    useAdvancedStore.setState(createAdvancedData());
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not restore a cached snapshot after the server rejects the session", async () => {
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(snapshot()));
    localStorage.setItem(STORAGE_OWNER_KEY, "user-1:house-user-1");
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) {
        return Promise.reject(new ApiError(401, "Sesja wygasła", "UNAUTHENTICATED"));
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );

    expect(await screen.findByRole("heading", { name: /Witaj ponownie/i })).toBeInTheDocument();
    expect(localStorage.getItem(AUTH_SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(STORAGE_OWNER_KEY)).toBeNull();
  });

  it("keeps local data and warns instead of wiping when the session expires with unsynced changes", async () => {
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(snapshot()));
    localStorage.setItem(STORAGE_OWNER_KEY, "user-1:house-user-1");
    localStorage.setItem(
      "puls-life-dashboard",
      JSON.stringify({ state: { intention: "Coś ważnego" } }),
    );
    localStorage.setItem("puls-sync-dirty:user-1:house-user-1", "1");
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) {
        return Promise.reject(new ApiError(401, "Sesja wygasła", "UNAUTHENTICATED"));
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );

    expect(await screen.findByRole("heading", { name: /Witaj ponownie/i })).toBeInTheDocument();
    expect(localStorage.getItem(AUTH_SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(STORAGE_OWNER_KEY)).toBeNull();
    expect(localStorage.getItem("puls-life-dashboard")).not.toBeNull();
    expect(localStorage.getItem("puls-sync-dirty:user-1:house-user-1")).toBe("1");
    expect(sessionStorage.getItem("puls-storage-warning")).toMatch(/lokalnie/);
  });

  it("ends the local session when another tab broadcasts logout", async () => {
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) return Promise.resolve(snapshot());
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );
    expect(await screen.findByText("ola@example.com")).toBeInTheDocument();

    const channel = FakeBroadcastChannel.instances.find((item) => item.name === "puls-auth");
    expect(channel).toBeDefined();
    act(() => channel?.emit({ type: "logout" }));

    expect(await screen.findByRole("heading", { name: /Witaj ponownie/i })).toBeInTheDocument();
    expect(localStorage.getItem(AUTH_SNAPSHOT_KEY)).toBeNull();
  });

  it("preserves unsynced local data on another tab when the broadcast signals session expiry, not a real logout", async () => {
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) return Promise.resolve(snapshot());
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );
    expect(await screen.findByText("ola@example.com")).toBeInTheDocument();

    localStorage.setItem(
      "puls-life-dashboard",
      JSON.stringify({ state: { intention: "Coś ważnego" } }),
    );
    localStorage.setItem("puls-sync-dirty:user-1:house-user-1", "1");

    const channel = FakeBroadcastChannel.instances.find((item) => item.name === "puls-auth");
    expect(channel).toBeDefined();
    act(() => channel?.emit({ type: "logout", reason: "expired" }));

    expect(await screen.findByRole("heading", { name: /Witaj ponownie/i })).toBeInTheDocument();
    expect(localStorage.getItem(AUTH_SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem("puls-life-dashboard")).not.toBeNull();
    expect(localStorage.getItem("puls-sync-dirty:user-1:house-user-1")).toBe("1");
  });

  it("adopts a valid snapshot propagated through the storage event", async () => {
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) return Promise.resolve(snapshot());
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );
    expect(await screen.findByText("ola@example.com")).toBeInTheDocument();

    const next = snapshot("user-2", "jan@example.com");
    localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(next));
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_SNAPSHOT_KEY,
          newValue: JSON.stringify(next),
        }),
      );
    });

    expect(await screen.findByText("jan@example.com")).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_OWNER_KEY)).toBe("user-2:house-user-2");
  });

  it("does not accept an invitation twice after registration consumed it", async () => {
    window.history.replaceState(null, "", "/?invite=invite-1");
    let meCalls = 0;
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) {
        meCalls += 1;
        return meCalls === 1
          ? Promise.reject(new ApiError(401, "Brak sesji", "UNAUTHENTICATED"))
          : Promise.resolve(snapshot());
      }
      if (path.endsWith("/auth/register")) return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    const user = userEvent.setup();

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );
    expect(await screen.findByRole("heading", { name: /Dołącz do domu/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Twoje imię"), "Ola");
    await user.type(screen.getByLabelText("Adres e-mail"), "ola@example.com");
    await user.type(screen.getByLabelText(/^Hasło/), "bardzo-dlugie-haslo");
    await user.click(screen.getByRole("button", { name: /Utwórz konto/i }));

    expect(await screen.findByText("ola@example.com")).toBeInTheDocument();
    expect(
      mocks.apiRequest.mock.calls.some(([path]) => String(path).includes("invitations/accept")),
    ).toBe(false);
    expect(new URL(window.location.href).searchParams.has("invite")).toBe(false);
  });

  it("accepts an invitation after an existing account logs in", async () => {
    window.history.replaceState(null, "", "/?invite=invite-2");
    let meCalls = 0;
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) {
        meCalls += 1;
        return meCalls === 1
          ? Promise.reject(new ApiError(401, "Brak sesji", "UNAUTHENTICATED"))
          : Promise.resolve(snapshot());
      }
      if (path.endsWith("/auth/login")) return Promise.resolve({ ok: true });
      if (path.includes("invitations/accept")) return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    const user = userEvent.setup();

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );
    await user.click(await screen.findByRole("button", { name: /Mam już konto/i }));
    await user.type(screen.getByLabelText("Adres e-mail"), "ola@example.com");
    await user.type(screen.getByLabelText(/^Hasło/), "bardzo-dlugie-haslo");
    await user.click(screen.getByRole("button", { name: /Zaloguj się/i }));

    expect(await screen.findByText("ola@example.com")).toBeInTheDocument();
    expect(
      mocks.apiRequest.mock.calls.some(([path]) => String(path).includes("invitations/accept")),
    ).toBe(true);
    expect(new URL(window.location.href).searchParams.has("invite")).toBe(false);
  });

  it("keeps an invitation-acceptance failure message separate from a general storage warning", async () => {
    window.history.replaceState(null, "", "/?invite=invite-3");
    sessionStorage.setItem("puls-storage-warning", "Ogólne ostrzeżenie o pamięci");
    mocks.apiRequest.mockImplementation((path: string) => {
      if (path.endsWith("bootstrap-status")) return Promise.resolve({ configured: true });
      if (path.endsWith("/auth/me")) return Promise.resolve(snapshot());
      if (path.includes("invitations/accept"))
        return Promise.reject(new Error("Zaproszenie wygasło"));
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });

    render(
      <AuthGate>
        <SessionProbe />
      </AuthGate>,
    );

    expect(await screen.findByText("ola@example.com")).toBeInTheDocument();
    expect(sessionStorage.getItem("puls-invite-warning")).toBe("Zaproszenie wygasło");
    expect(sessionStorage.getItem("puls-storage-warning")).toBe("Ogólne ostrzeżenie o pamięci");
  });
});
