// Silnik synchronizacji modułu Posiłki — wzorowany 1:1 na src/hooks/useTripsSync.ts, ale
// operuje na src/store/useMealsStore.ts. Patrz docs/plans/lista-zakupow-meals.md
// ("Frontend — dedykowany store + silnik sync").
//
// Przy montażu: GET /api/v1/meals (hydratacja snapshotem). Jeśli w kolejce są niewysłane mutacje
// (offline edycje z poprzedniej sesji), najpierw je wysyła (POST /api/v1/meals/mutations) i dopiero
// po opróżnieniu kolejki robi pełną hydratację — inaczej ryzykowalibyśmy nadpisanie lokalnych,
// jeszcze niewysłanych zmian świeżym snapshotem serwera.
import { useEffect, useRef, useState } from "react";
import { apiRequest, ApiError } from "../server/api";
import { useMealsStore, type MealMutationResult, type MealsSnapshot } from "../store/useMealsStore";

export type MealsSyncState = "synced" | "saving" | "offline";

// Zabezpieczenie przed nieskończoną pętlą, gdyby rebase konfliktu ciągle konfliktował (np. dwa
// urządzenia bez przerwy edytujące to samo pole) — po tylu rundach w jednym cyklu poddajemy się
// do najbliższego wyzwalacza (online/focus/kolejna zmiana w store).
const MAX_FLUSH_ROUNDS = 25;

export function useMealsSync(onSessionExpired?: () => void): { syncState: MealsSyncState } {
  const [syncState, setSyncState] = useState<MealsSyncState>("saving");
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
        const snapshot = await apiRequest<MealsSnapshot>("/api/v1/meals", {
          signal: controller.signal,
        });
        if (!mounted.current || controller.signal.aborted) return;
        useMealsStore.getState().hydrateFromSnapshot(snapshot);
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
            useMealsStore.getState().pendingMutations.length > 0 &&
            totalRounds < MAX_FLUSH_ROUNDS
          ) {
            totalRounds += 1;
            setSyncState("saving");
            const batch = useMealsStore.getState().pendingMutations;
            let response: { results: MealMutationResult[]; serverAt: string };
            try {
              response = await apiRequest<{ results: MealMutationResult[]; serverAt: string }>(
                "/api/v1/meals/mutations",
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
            useMealsStore.getState().applyMutationResults(response.results);
          }
          if (!mounted.current || controller.signal.aborted) return;
          if (useMealsStore.getState().pendingMutations.length > 0) {
            // Wyczerpaliśmy limit rund rebase'u w tym cyklu — spróbujemy ponownie przy kolejnym
            // wyzwalaczu (nowa mutacja / online / focus), zamiast kręcić się w kółko od razu.
            setSyncState("offline");
            return;
          }
          await hydrate();
          if (!mounted.current || controller.signal.aborted) return;
          if (
            useMealsStore.getState().pendingMutations.length === 0 ||
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
      if (useMealsStore.getState().pendingMutations.length > 0) {
        await flush();
      } else {
        await hydrate();
      }
    })();

    const unsubscribe = useMealsStore.subscribe((state) => {
      if (state.pendingMutations.length > 0) void flush();
    });

    const resumeSync = () => {
      if (useMealsStore.getState().pendingMutations.length > 0) void flush();
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
    // Efekt ma odpalić się raz przy montowaniu (analogicznie do TripsSync) — resync/hydrate/flush
    // czytają zawsze świeży stan przez useMealsStore.getState(), nie przez domknięcie.
  }, []);

  return { syncState };
}
