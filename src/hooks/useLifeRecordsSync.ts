// Silnik synchronizacji modułu Life — wzorowany na src/hooks/useHealthSync.ts, operuje na
// src/store/useLifeRecordsStore.ts (kolejka mutacji z idempotencją zamiast jednego dokumentu z
// rewizją). Patrz docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("Frontend — dedykowany
// store + silnik sync").
//
// Przy montażu: GET /api/v1/life (hydratacja snapshotem). Jeśli w kolejce są niewysłane mutacje
// (offline edycje z poprzedniej sesji), najpierw je wysyła (POST /api/v1/life/mutations) i
// dopiero po opróżnieniu kolejki robi pełną hydratację — inaczej ryzykowalibyśmy nadpisanie
// lokalnych, jeszcze niewysłanych zmian świeżym snapshotem serwera.
import { useEffect, useRef, useState } from "react";
import { apiRequest, ApiError } from "../server/api";
import {
  useLifeRecordsStore,
  type LifeMutationResult,
  type LifeRecordsSnapshot,
} from "../store/useLifeRecordsStore";

export type LifeRecordsSyncState = "synced" | "saving" | "offline";

// Zabezpieczenie przed nieskończoną pętlą, gdyby rebase konfliktu ciągle konfliktował (np. dwa
// urządzenia bez przerwy edytujące to samo pole) — po tylu rundach w jednym cyklu poddajemy się
// do najbliższego wyzwalacza (online/focus/kolejna zmiana w store).
const MAX_FLUSH_ROUNDS = 25;

export function useLifeRecordsSync(onSessionExpired?: () => void): {
  syncState: LifeRecordsSyncState;
} {
  const [syncState, setSyncState] = useState<LifeRecordsSyncState>("saving");
  const mounted = useRef(true);
  const flushing = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const onSessionExpiredRef = useRef(onSessionExpired);
  onSessionExpiredRef.current = onSessionExpired;

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;

    const sessionWasRejected = (error: unknown) => {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403))
        return false;
      onSessionExpiredRef.current?.();
      return true;
    };

    const hydrate = async () => {
      try {
        const snapshot = await apiRequest<LifeRecordsSnapshot>("/api/v1/life", {
          signal: controller.signal,
        });
        if (!mounted.current || controller.signal.aborted) return;
        useLifeRecordsStore.getState().hydrateFromSnapshot(snapshot);
        if (!mounted.current || controller.signal.aborted) return;
        setSyncState("synced");
      } catch (error) {
        if (!mounted.current || controller.signal.aborted) return;
        if (sessionWasRejected(error)) return;
        // Best-effort: zostaje ewentualny lokalny (offline-first) stan z poprzedniej sesji.
        setSyncState("offline");
      }
    };

    const flush = async () => {
      if (flushing.current || !mounted.current) return;
      flushing.current = true;
      try {
        let totalRounds = 0;
        // Pętla zewnętrzna: po opróżnieniu kolejki robimy hydratację; jeśli w MIĘDZYCZASIE (podczas
        // samego GET-a) przybyła nowa mutacja, drenujemy ją też od razu zamiast czekać na kolejny
        // zewnętrzny wyzwalacz (online/focus) — inaczej mutacja dodana dokładnie w tym oknie
        // zostałaby "uwięziona" w kolejce aż do następnej okazji.
        while (mounted.current && !controller.signal.aborted) {
          while (
            mounted.current &&
            !controller.signal.aborted &&
            useLifeRecordsStore.getState().pendingMutations.length > 0 &&
            totalRounds < MAX_FLUSH_ROUNDS
          ) {
            totalRounds += 1;
            setSyncState("saving");
            const batch = useLifeRecordsStore.getState().pendingMutations;
            let response: { results: LifeMutationResult[]; serverAt: string };
            try {
              response = await apiRequest<{ results: LifeMutationResult[]; serverAt: string }>(
                "/api/v1/life/mutations",
                {
                  method: "POST",
                  json: {
                    mutations: batch.map(({ idempotencyKey, op, payload, baseVersion }) => ({
                      idempotencyKey,
                      op,
                      payload,
                      ...(baseVersion !== undefined ? { baseVersion } : {}),
                    })),
                  },
                  signal: controller.signal,
                },
              );
            } catch (error) {
              if (!mounted.current || controller.signal.aborted) return;
              if (sessionWasRejected(error)) return;
              setSyncState("offline");
              return;
            }
            if (!mounted.current || controller.signal.aborted) return;
            useLifeRecordsStore.getState().applyMutationResults(response.results);
          }
          if (!mounted.current || controller.signal.aborted) return;
          if (useLifeRecordsStore.getState().pendingMutations.length > 0) {
            // Wyczerpaliśmy limit rund rebase'u w tym cyklu — spróbujemy ponownie przy kolejnym
            // wyzwalaczu (nowa mutacja / online / focus), zamiast kręcić się w kółko od razu.
            setSyncState("offline");
            return;
          }
          await hydrate();
          if (!mounted.current || controller.signal.aborted) return;
          if (
            useLifeRecordsStore.getState().pendingMutations.length === 0 ||
            totalRounds >= MAX_FLUSH_ROUNDS
          ) {
            return;
          }
          // W trakcie hydratacji przybyła nowa mutacja — wróć na początek pętli i wyślij ją.
        }
      } finally {
        flushing.current = false;
      }
    };

    void (async () => {
      if (useLifeRecordsStore.getState().pendingMutations.length > 0) {
        await flush();
      } else {
        await hydrate();
      }
    })();

    const unsubscribe = useLifeRecordsStore.subscribe((state) => {
      if (state.pendingMutations.length > 0) void flush();
    });

    const resumeSync = () => {
      if (useLifeRecordsStore.getState().pendingMutations.length > 0) void flush();
      else void hydrate();
    };
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") resumeSync();
    };
    window.addEventListener("online", resumeSync);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      mounted.current = false;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      unsubscribe();
      window.removeEventListener("online", resumeSync);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
    // Efekt ma odpalić się raz przy montowaniu (analogicznie do WorkspaceSync) — resync/hydrate/flush
    // czytają zawsze świeży stan przez useLifeRecordsStore.getState(), nie przez domknięcie.
  }, []);

  return { syncState };
}
