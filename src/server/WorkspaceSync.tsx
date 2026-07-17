import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cloud, CloudOff, Database, LoaderCircle, Upload } from "lucide-react";
import { exportAdvancedData, useAdvancedStore } from "../store/useAdvancedStore";
import { exportData, useLifeStore } from "../store/useLifeStore";
import type { AdvancedData } from "../advancedTypes";
import type { LifeData } from "../types";
import { apiRequest, ApiError } from "./api";
import { mergeWorkspaceChanges } from "./workspaceMerge";
import { advancedDataSchema, lifeDataSchema } from "../lib/schema";
import { safeGetStorageItem, safeRemoveStorageItem, safeSetStorageItem } from "../lib/safeStorage";

interface WorkspaceData {
  life?: LifeData;
  advanced?: AdvancedData;
  schemaVersion?: number;
}

interface WorkspacePayload {
  revision: number;
  data: WorkspaceData;
  updated_at?: string;
}

const localData = (): WorkspaceData => ({
  schemaVersion: 2,
  life: exportData(),
  advanced: exportAdvancedData(),
});

function replaceWithEmptyWorkspace() {
  const life = exportData();
  useLifeStore.getState().replaceData({
    tasks: [],
    events: [],
    reminders: [],
    notes: [],
    habits: [],
    scratchpad: "",
    intention: "",
    energy: "medium",
    preferences: life.preferences,
  });
  const advanced = exportAdvancedData();
  useAdvancedStore.getState().replaceAdvancedData({
    ...advanced,
    householdName: "Dom",
    householdMembers: [],
    subscriptions: [],
    vehicles: [],
    carExpenses: [],
    vehicleDeadlines: [],
    pets: [],
    petExpenses: [],
    petVisits: [],
    healthAppointments: [],
    medications: [],
    healthMeasurements: [],
    hideAmounts: false,
  });
}

export function WorkspaceSync({
  children,
  scope,
  onSessionExpired,
}: {
  children: ReactNode;
  scope: string;
  onSessionExpired: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [migrationChoice, setMigrationChoice] = useState(false);
  const [syncState, setSyncState] = useState<"synced" | "saving" | "offline" | "conflict">(
    "saving",
  );
  const revision = useRef(0);
  const baseData = useRef<WorkspaceData>({});
  const applyingRemote = useRef(false);
  const readyRef = useRef(false);
  const mounted = useRef(true);
  const dirty = useRef(false);
  const saving = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const requestController = useRef<AbortController | null>(null);
  const dirtyKey = `puls-sync-dirty:${scope}`;
  const baseKey = `puls-sync-base:${scope}`;

  const rememberBase = (data: WorkspaceData) => {
    baseData.current = structuredClone(data);
    safeSetStorageItem(baseKey, JSON.stringify(data));
  };

  const applyData = (data: WorkspaceData) => {
    applyingRemote.current = true;
    if (data.life) {
      const notificationsEnabled = useLifeStore.getState().preferences.notificationsEnabled;
      const parsed = lifeDataSchema.parse(data.life);
      useLifeStore.getState().replaceData({
        ...parsed,
        preferences: { ...parsed.preferences, notificationsEnabled },
      });
    }
    if (data.advanced)
      useAdvancedStore.getState().replaceAdvancedData(advancedDataSchema.parse(data.advanced));
    queueMicrotask(() => {
      applyingRemote.current = false;
    });
  };

  const markDirty = () => {
    dirty.current = true;
    safeSetStorageItem(dirtyKey, "1");
  };

  const sessionWasRejected = (error: unknown) => {
    if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403))
      return false;
    onSessionExpired();
    return true;
  };

  const flush = async () => {
    if (!readyRef.current || saving.current) {
      if (readyRef.current) markDirty();
      return;
    }
    saving.current = true;
    const controller = requestController.current;
    try {
      while (dirty.current && mounted.current && !controller?.signal.aborted) {
        dirty.current = false;
        setSyncState("saving");
        const outgoing = localData();
        try {
          const result = await apiRequest<{ revision: number }>("/api/v1/workspace", {
            method: "PUT",
            json: { revision: revision.current, data: outgoing },
            signal: controller?.signal,
          });
          if (!mounted.current || controller?.signal.aborted) break;
          revision.current = Number(result.revision);
          rememberBase(outgoing);
          if (!dirty.current) {
            safeRemoveStorageItem(dirtyKey);
            setSyncState("synced");
          }
        } catch (error) {
          if (!mounted.current || controller?.signal.aborted) break;
          if (sessionWasRejected(error)) break;
          if (error instanceof ApiError && error.status === 409) {
            setSyncState("conflict");
            try {
              const latest = await apiRequest<WorkspacePayload>("/api/v1/workspace", {
                signal: controller?.signal,
              });
              if (!mounted.current || controller?.signal.aborted) break;
              const merged = mergeWorkspaceChanges(
                baseData.current,
                outgoing,
                latest.data,
              ) as WorkspaceData;
              revision.current = Number(latest.revision);
              rememberBase(latest.data);
              applyData(merged);
              markDirty();
            } catch (latestError) {
              if (!mounted.current || controller?.signal.aborted) break;
              if (sessionWasRejected(latestError)) break;
              markDirty();
              setSyncState("offline");
              break;
            }
          } else {
            markDirty();
            setSyncState("offline");
            break;
          }
        }
      }
    } finally {
      saving.current = false;
    }
  };
  flushRef.current = flush;

  const scheduleSave = () => {
    if (applyingRemote.current || !readyRef.current) return;
    markDirty();
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushRef.current(), 650);
  };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    const hasLocalCache = Boolean(
      safeGetStorageItem("puls-life-dashboard") || safeGetStorageItem("puls-advanced-dashboard"),
    );
    const hasPersistedDirtyState = safeGetStorageItem(dirtyKey) === "1";
    dirty.current = hasPersistedDirtyState && hasLocalCache;
    if (hasPersistedDirtyState && !hasLocalCache) safeRemoveStorageItem(dirtyKey);
    if (dirty.current) {
      try {
        baseData.current = JSON.parse(safeGetStorageItem(baseKey) ?? "null") ?? {};
      } catch {
        baseData.current = {};
      }
    }
    void (async () => {
      try {
        const payload = await apiRequest<WorkspacePayload>("/api/v1/workspace", {
          signal: controller.signal,
        });
        if (controller.signal.aborted || !mounted.current) return;
        revision.current = Number(payload.revision);
        const hasRemote = Boolean(payload.data?.life || payload.data?.advanced);
        if (hasRemote && dirty.current) {
          let previousBase: WorkspaceData = payload.data;
          try {
            previousBase = JSON.parse(safeGetStorageItem(baseKey) ?? "null") ?? payload.data;
          } catch {
            /* use remote base */
          }
          const merged = mergeWorkspaceChanges(
            previousBase,
            localData(),
            payload.data,
          ) as WorkspaceData;
          rememberBase(payload.data);
          applyData(merged);
          readyRef.current = true;
          setReady(true);
          markDirty();
          await flushRef.current();
        } else if (hasRemote) {
          applyData(payload.data);
          rememberBase(payload.data);
          readyRef.current = true;
          setReady(true);
          setSyncState("synced");
        } else if (hasLocalCache) {
          baseData.current = payload.data;
          setMigrationChoice(true);
        } else {
          replaceWithEmptyWorkspace();
          readyRef.current = true;
          markDirty();
          await flushRef.current();
          if (controller.signal.aborted || !mounted.current) return;
          try {
            const enriched = await apiRequest<WorkspacePayload>("/api/v1/workspace", {
              signal: controller.signal,
            });
            if (controller.signal.aborted || !mounted.current) return;
            revision.current = Number(enriched.revision);
            applyData(enriched.data);
            rememberBase(enriched.data);
          } catch (error) {
            if (controller.signal.aborted || !mounted.current) return;
            if (sessionWasRejected(error)) return;
            setSyncState("offline");
          }
          setReady(true);
        }
      } catch (error) {
        if (controller.signal.aborted || !mounted.current) return;
        if (sessionWasRejected(error)) return;
        if (
          !safeGetStorageItem("puls-life-dashboard") &&
          !safeGetStorageItem("puls-advanced-dashboard")
        ) {
          replaceWithEmptyWorkspace();
        }
        readyRef.current = true;
        setReady(true);
        setSyncState("offline");
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      if (requestController.current === controller) requestController.current = null;
      window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markDirty/rememberBase/sessionWasRejected są nowymi funkcjami co render; efekt ma resynchronizować się tylko przy zmianie baseKey/dirtyKey.
  }, [baseKey, dirtyKey]);

  useEffect(() => {
    if (!ready) return;
    const unsubscribeLife = useLifeStore.subscribe(scheduleSave);
    const unsubscribeAdvanced = useAdvancedStore.subscribe(scheduleSave);
    const refresh = () => {
      if (document.visibilityState !== "visible" || saving.current) return;
      if (dirty.current) {
        void flushRef.current();
        return;
      }
      const controller = requestController.current;
      void apiRequest<WorkspacePayload>("/api/v1/workspace", { signal: controller?.signal })
        .then((payload) => {
          if (!mounted.current || controller?.signal.aborted) return;
          if (Number(payload.revision) > revision.current) {
            revision.current = Number(payload.revision);
            applyData(payload.data);
            rememberBase(payload.data);
            setSyncState("synced");
          }
        })
        .catch((error) => {
          if (!mounted.current || controller?.signal.aborted) return;
          if (!sessionWasRejected(error)) setSyncState("offline");
        });
    };
    const resumeSync = () => {
      if (dirty.current) void flushRef.current();
      else refresh();
    };
    const flushBeforeLeave = () => {
      if (!dirty.current) return;
      window.clearTimeout(saveTimer.current);
      void flushRef.current();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", resumeSync);
    window.addEventListener("pagehide", flushBeforeLeave);
    document.addEventListener("visibilitychange", flushBeforeLeave);
    return () => {
      unsubscribeLife();
      unsubscribeAdvanced();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", resumeSync);
      window.removeEventListener("pagehide", flushBeforeLeave);
      document.removeEventListener("visibilitychange", flushBeforeLeave);
      window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rememberBase/scheduleSave/sessionWasRejected są nowymi funkcjami co render; efekt ma podpiąć listenery tylko przy zmianie `ready`.
  }, [ready]);

  const chooseMigration = async (upload: boolean) => {
    if (!upload) {
      replaceWithEmptyWorkspace();
    }
    setMigrationChoice(false);
    readyRef.current = true;
    markDirty();
    await flushRef.current();
    const controller = requestController.current;
    if (!mounted.current || controller?.signal.aborted) return;
    try {
      const enriched = await apiRequest<WorkspacePayload>("/api/v1/workspace", {
        signal: controller?.signal,
      });
      if (!mounted.current || controller?.signal.aborted) return;
      revision.current = Number(enriched.revision);
      applyData(enriched.data);
      rememberBase(enriched.data);
    } catch (error) {
      if (!mounted.current || controller?.signal.aborted) return;
      if (sessionWasRejected(error)) return;
      setSyncState("offline");
    }
    setReady(true);
  };

  if (migrationChoice) {
    return (
      <div className="migration-shell">
        <div className="migration-card">
          <span className="migration-icon">
            <Database size={23} />
          </span>
          <span className="page-eyebrow">Migracja Puls 1.0</span>
          <h1>Znaleźliśmy lokalne dane</h1>
          <p>
            Możesz bezpiecznie przenieść dotychczasowe zadania, kalendarz, notatki i rytuały do
            wspólnego domu. Lokalna kopia pozostanie w tej przeglądarce.
          </p>
          <div className="migration-summary">
            <span>
              Zadania <strong>{useLifeStore.getState().tasks.length}</strong>
            </span>
            <span>
              Wydarzenia <strong>{useLifeStore.getState().events.length}</strong>
            </span>
            <span>
              Notatki <strong>{useLifeStore.getState().notes.length}</strong>
            </span>
          </div>
          <button
            className="button button--primary"
            type="button"
            onClick={() => void chooseMigration(true)}
          >
            <Upload size={17} /> Przenieś moje dane
          </button>
          <button
            className="button button--ghost"
            type="button"
            onClick={() => void chooseMigration(false)}
          >
            Zacznij od czystego Pulsu 2.0
          </button>
        </div>
      </div>
    );
  }

  if (!ready) return <AuthSyncLoading />;

  return (
    <>
      {children}
      <div className={`sync-indicator sync-indicator--${syncState}`} role="status">
        {syncState === "saving" ? (
          <LoaderCircle size={13} className="spin" />
        ) : syncState === "offline" ? (
          <CloudOff size={13} />
        ) : (
          <Cloud size={13} />
        )}
        {syncState === "saving"
          ? "Zapisuję"
          : syncState === "offline"
            ? "Zmiany czekają na sieć"
            : syncState === "conflict"
              ? "Scalam zmiany"
              : "Zsynchronizowano"}
      </div>
    </>
  );
}

function AuthSyncLoading() {
  return (
    <div className="auth-shell">
      <div className="auth-loading">
        <LoaderCircle size={22} className="spin" />
        <span>Synchronizuję wspólny dom…</span>
      </div>
    </div>
  );
}
