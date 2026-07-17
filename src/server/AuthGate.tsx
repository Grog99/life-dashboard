import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ArrowRight, Home, LoaderCircle, LockKeyhole, ShieldCheck, UserPlus } from "lucide-react";
import { apiRequest, ApiError, serverMode, type AuthSnapshot } from "./api";
import { WorkspaceSync } from "./WorkspaceSync";
import { FinanceSync } from "./FinanceSync";
import { TripsSync } from "./TripsSync";
import { MealsSync } from "./MealsSync";
import { CarSync } from "./CarSync";
import { removeCurrentPushSubscription } from "./push";
import { useLifeStore } from "../store/useLifeStore";
import { useAdvancedStore } from "../store/useAdvancedStore";
import { useFinanceStore } from "../store/useFinanceStore";
import { useTripsStore } from "../store/useTripsStore";
import { useMealsStore } from "../store/useMealsStore";
import { useCarStore } from "../store/useCarStore";
import {
  reportStorageWarning,
  safeGetStorageItem,
  safeRemoveStorageItem,
  safeRemoveStoragePrefix,
  safeSetStorageItem,
} from "../lib/safeStorage";
import "../styles/server.css";

interface AuthContextValue {
  snapshot: AuthSnapshot | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  snapshot: null,
  refresh: async () => undefined,
  logout: async () => undefined,
});

// eslint-disable-next-line react-refresh/only-export-components -- hook celowo współdzielony z komponentem AuthGate w tym samym pliku; korzysta z lokalnego AuthContext zdefiniowanego tutaj.
export const useServerAuth = () => useContext(AuthContext);

const STORAGE_OWNER_KEY = "puls-server-storage-owner";
const AUTH_SNAPSHOT_KEY = "puls-server-auth-snapshot";
const INVITE_WARNING_KEY = "puls-invite-warning";

function cachedSnapshot(): AuthSnapshot | null {
  try {
    const value = JSON.parse(
      safeGetStorageItem(AUTH_SNAPSHOT_KEY) ?? "null",
    ) as AuthSnapshot | null;
    return value?.user?.id && value.activeHouseholdId ? value : null;
  } catch {
    safeRemoveStorageItem(AUTH_SNAPSHOT_KEY);
    return null;
  }
}

function bindLocalStorageTo(snapshot: AuthSnapshot) {
  const scope = `${snapshot.user.id}:${snapshot.activeHouseholdId}`;
  const previous = safeGetStorageItem(STORAGE_OWNER_KEY);
  if (previous && previous !== scope) {
    useLifeStore.getState().resetData();
    useAdvancedStore.getState().resetAdvancedData();
    useFinanceStore.getState().resetFinanceData();
    useTripsStore.getState().resetTripsData();
    useMealsStore.getState().resetMealsData();
    useCarStore.getState().resetCarData();
    safeRemoveStorageItem("puls-life-dashboard");
    safeRemoveStorageItem("puls-advanced-dashboard");
    safeRemoveStorageItem("puls-finance");
    safeRemoveStorageItem("puls-trips");
    safeRemoveStorageItem("puls-meals");
    safeRemoveStorageItem("puls-car");
  }
  safeSetStorageItem(STORAGE_OWNER_KEY, scope);
}

function clearLocalUserData() {
  useLifeStore.getState().resetData();
  useAdvancedStore.getState().resetAdvancedData();
  useFinanceStore.getState().resetFinanceData();
  useTripsStore.getState().resetTripsData();
  useMealsStore.getState().resetMealsData();
  useCarStore.getState().resetCarData();
  safeRemoveStorageItem(STORAGE_OWNER_KEY);
  safeRemoveStorageItem(AUTH_SNAPSHOT_KEY);
  safeRemoveStorageItem("puls-life-dashboard");
  safeRemoveStorageItem("puls-advanced-dashboard");
  safeRemoveStorageItem("puls-finance");
  safeRemoveStorageItem("puls-trips");
  safeRemoveStorageItem("puls-meals");
  safeRemoveStorageItem("puls-car");
  safeRemoveStoragePrefix("puls-sync-");
}

function hasUnsyncedChanges(): boolean {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      if (localStorage.key(index)?.startsWith("puls-sync-dirty:")) return true;
    }
  } catch {
    return false;
  }
  return (
    useFinanceStore.getState().pendingMutations.length > 0 ||
    useTripsStore.getState().pendingMutations.length > 0 ||
    useMealsStore.getState().pendingMutations.length > 0 ||
    useCarStore.getState().pendingMutations.length > 0
  );
}

const isRejectedSession = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

export function AuthGate({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot | null>(null);
  const [loading, setLoading] = useState(serverMode);
  const [configured, setConfigured] = useState(true);
  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  const [authMode, setAuthMode] = useState<AuthMode>(inviteToken ? "register" : "login");
  const authChannel = useRef<BroadcastChannel | null>(null);

  const commitSnapshot = (next: AuthSnapshot) => {
    bindLocalStorageTo(next);
    safeSetStorageItem(AUTH_SNAPSHOT_KEY, JSON.stringify(next));
    setSnapshot(next);
  };

  const endLocalSession = (broadcast = false, reason: "logout" | "expired" = "logout") => {
    setSnapshot(null);
    if (reason === "expired" && hasUnsyncedChanges()) {
      safeRemoveStorageItem(STORAGE_OWNER_KEY);
      safeRemoveStorageItem(AUTH_SNAPSHOT_KEY);
      reportStorageWarning(
        "Sesja wygasła, zanim zdążyliśmy zapisać Twoje zmiany na serwerze. Zostały zachowane lokalnie i zsynchronizują się po ponownym zalogowaniu.",
      );
    } else {
      clearLocalUserData();
    }
    if (broadcast) {
      try {
        authChannel.current?.postMessage({ type: "logout", reason });
      } catch {
        /* storage event remains the fallback */
      }
    }
  };

  const refresh = async (acceptPendingInvite = true) => {
    if (!serverMode) return;
    let next: AuthSnapshot;
    try {
      next = await apiRequest<AuthSnapshot>("/api/v1/auth/me");
    } catch (error) {
      if (isRejectedSession(error)) {
        endLocalSession(true, "expired");
        return;
      }
      const cached = cachedSnapshot();
      if (cached) {
        bindLocalStorageTo(cached);
        setSnapshot(cached);
      } else {
        setSnapshot(null);
      }
      return;
    }

    if (inviteToken && acceptPendingInvite) {
      try {
        await apiRequest("/api/v1/households/invitations/accept", {
          method: "POST",
          json: { inviteToken },
        });
        next = await apiRequest<AuthSnapshot>("/api/v1/auth/me");
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      } catch (error) {
        if (isRejectedSession(error) && (error as ApiError).status === 401) {
          endLocalSession(true, "expired");
          return;
        }
        // The session itself is valid. Keep it, remove a bad invitation from the URL,
        // and surface the invitation failure once the application mounts.
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
        try {
          sessionStorage.setItem(
            INVITE_WARNING_KEY,
            error instanceof Error ? error.message : "Nie udało się przyjąć zaproszenia",
          );
        } catch {
          // The valid session can still continue without a transient notice.
        }
      }
    } else if (inviteToken) {
      // Registration consumes the invitation atomically on the server.
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }

    commitSnapshot(next);
  };

  useEffect(() => {
    if (!serverMode) return;
    void (async () => {
      try {
        const status = await apiRequest<{ configured: boolean }>("/api/v1/auth/bootstrap-status");
        setConfigured(status.configured);
        if (status.configured) await refresh();
      } catch (error) {
        if (isRejectedSession(error)) {
          endLocalSession(true, "expired");
          return;
        }
        const cached = cachedSnapshot();
        if (cached) {
          setConfigured(true);
          bindLocalStorageTo(cached);
          setSnapshot(cached);
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refresh` nie jest memoizowane; ten efekt ma odpalić się tylko raz przy montowaniu, nie przy każdym renderze.
  }, []);

  useEffect(() => {
    if (!serverMode) return;
    const applyRemoteLogout = (reason: "logout" | "expired" = "logout") =>
      endLocalSession(false, reason);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_SNAPSHOT_KEY) return;
      if (!event.newValue) {
        applyRemoteLogout();
        return;
      }
      try {
        const next = JSON.parse(event.newValue) as AuthSnapshot;
        if (!next?.user?.id || !next.activeHouseholdId) return;
        bindLocalStorageTo(next);
        setSnapshot(next);
      } catch {
        applyRemoteLogout();
      }
    };
    window.addEventListener("storage", handleStorage);
    if ("BroadcastChannel" in window) {
      try {
        const channel = new BroadcastChannel("puls-auth");
        authChannel.current = channel;
        channel.addEventListener("message", (event) => {
          if (event.data?.type === "logout")
            applyRemoteLogout(event.data.reason === "expired" ? "expired" : "logout");
        });
      } catch {
        authChannel.current = null;
      }
    }
    return () => {
      window.removeEventListener("storage", handleStorage);
      authChannel.current?.close();
      authChannel.current = null;
    };
  }, []);

  const logout = async () => {
    try {
      await removeCurrentPushSubscription().catch(() => undefined);
      await apiRequest("/api/v1/auth/logout", { method: "POST", json: {} });
    } finally {
      endLocalSession(true);
    }
  };

  if (!serverMode) {
    return (
      <AuthContext.Provider value={{ snapshot: null, refresh, logout }}>
        {children}
      </AuthContext.Provider>
    );
  }

  if (loading) return <AuthLoading />;

  if (!configured) {
    return (
      <AuthScreen
        mode="bootstrap"
        onSuccess={async () => {
          setConfigured(true);
          await refresh(false);
        }}
      />
    );
  }

  if (!snapshot) {
    return (
      <AuthScreen
        mode={authMode}
        inviteToken={inviteToken ?? undefined}
        onModeChange={setAuthMode}
        onSuccess={() => refresh(authMode !== "register")}
      />
    );
  }

  return (
    <AuthContext.Provider value={{ snapshot, refresh, logout }}>
      <WorkspaceSync
        key={`${snapshot.user.id}:${snapshot.activeHouseholdId}`}
        scope={`${snapshot.user.id}:${snapshot.activeHouseholdId}`}
        onSessionExpired={() => endLocalSession(true, "expired")}
      >
        <FinanceSync
          key={`${snapshot.user.id}:${snapshot.activeHouseholdId}`}
          onSessionExpired={() => endLocalSession(true, "expired")}
        >
          <TripsSync
            key={`${snapshot.user.id}:${snapshot.activeHouseholdId}`}
            onSessionExpired={() => endLocalSession(true, "expired")}
          >
            <MealsSync
              key={`${snapshot.user.id}:${snapshot.activeHouseholdId}`}
              onSessionExpired={() => endLocalSession(true, "expired")}
            >
              <CarSync
                key={`${snapshot.user.id}:${snapshot.activeHouseholdId}`}
                onSessionExpired={() => endLocalSession(true, "expired")}
              >
                {children}
              </CarSync>
            </MealsSync>
          </TripsSync>
        </FinanceSync>
      </WorkspaceSync>
    </AuthContext.Provider>
  );
}

function AuthLoading() {
  return (
    <div className="auth-shell">
      <div className="auth-loading">
        <span className="brand__mark">P</span>
        <LoaderCircle size={22} className="spin" />
        <span>Uruchamiam Puls…</span>
      </div>
    </div>
  );
}

type AuthMode = "login" | "register" | "bootstrap";

function AuthScreen({
  mode,
  inviteToken,
  onModeChange,
  onSuccess,
}: {
  mode: AuthMode;
  inviteToken?: string;
  onModeChange?: (mode: AuthMode) => void;
  onSuccess: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [householdName, setHouseholdName] = useState("Nasz dom");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const path =
        mode === "bootstrap"
          ? "/api/v1/auth/bootstrap"
          : mode === "register"
            ? "/api/v1/auth/register"
            : "/api/v1/auth/login";
      await apiRequest(path, {
        method: "POST",
        json: {
          email,
          password,
          name,
          householdName,
          bootstrapToken,
          inviteToken,
        },
      });
      await onSuccess();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się zalogować");
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === "login"
      ? "Witaj ponownie"
      : mode === "register"
        ? "Dołącz do domu"
        : "Skonfiguruj swój Puls";
  const description =
    mode === "login"
      ? "Zaloguj się do wspólnej przestrzeni."
      : mode === "register"
        ? "Zaproszenie połączy Cię ze wspólnym dashboardem."
        : "Pierwsze konto otrzyma rolę właściciela.";

  return (
    <div className="auth-shell">
      <div className="auth-visual">
        <div className="auth-brand">
          <span className="brand__mark">P</span>
          <div>
            <strong>Puls</strong>
            <span>osobiste centrum życia</span>
          </div>
        </div>
        <div className="auth-visual__content">
          <span>
            <ShieldCheck size={17} /> Self-hosted · Twoje dane
          </span>
          <h1>
            Wszystko, co ważne.
            <br />W jednym spokojnym miejscu.
          </h1>
          <p>
            Plan dnia, wspólne finanse, podróże, posiłki, subskrypcje, samochód i podstawy zdrowia —
            dostępne na każdym urządzeniu.
          </p>
        </div>
        <div className="auth-feature-row">
          <span>
            <Home size={16} /> Wspólny dom
          </span>
          <span>
            <LockKeyhole size={16} /> Prywatne dane
          </span>
          <span>
            <UserPlus size={16} /> Zaproszenia
          </span>
        </div>
      </div>
      <main className="auth-card">
        <header>
          <span className="auth-mobile-logo brand__mark">P</span>
          <span className="page-eyebrow">Puls 2.0</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </header>
        <form onSubmit={submit}>
          {mode !== "login" && (
            <label className="field">
              <span>Twoje imię</span>
              <input
                required
                minLength={2}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
              />
            </label>
          )}
          {mode === "bootstrap" && (
            <label className="field">
              <span>Nazwa domu</span>
              <input
                required
                minLength={2}
                value={householdName}
                onChange={(event) => setHouseholdName(event.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>Adres e-mail</span>
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="field">
            <span>Hasło</span>
            <input
              required
              minLength={8}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
            <small>Minimum 8 znaków</small>
          </label>
          {mode === "bootstrap" && (
            <label className="field">
              <span>Token pierwszej konfiguracji</span>
              <input
                required
                type="password"
                value={bootstrapToken}
                onChange={(event) => setBootstrapToken(event.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button className="button button--primary auth-submit" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}
            {busy ? "Chwila…" : mode === "login" ? "Zaloguj się" : "Utwórz konto"}
          </button>
          {inviteToken && onModeChange && (
            <button
              className="button button--ghost auth-submit"
              type="button"
              onClick={() => onModeChange(mode === "login" ? "register" : "login")}
            >
              {mode === "login"
                ? "Nie mam konta — zarejestruj mnie"
                : "Mam już konto — zaloguj mnie"}
            </button>
          )}
        </form>
        <footer>
          <LockKeyhole size={14} /> Sesja jest chroniona ciasteczkiem HttpOnly. Puls nie wysyła
          danych poza Twój serwer.
        </footer>
      </main>
    </div>
  );
}
