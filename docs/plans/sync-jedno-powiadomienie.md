# Jeden zbiorczy wskaźnik synchronizacji

> Plan wygenerowany przez skill `/plan-feature`. Slug: `sync-jedno-powiadomienie`. Branch: `claude/sync-notifications-single-bcyj70`.

## Kontekst / Problem

W trybie serwerowym (`serverMode`) `src/server/AuthGate.tsx` montuje **9 niezależnych providerów synchronizacji**: `WorkspaceSync`, `FinanceSync`, `TripsSync`, `MealsSync`, `CarSync`, `PetsSync`, `HealthSync`, `SubscriptionsSync`, `LifeRecordsSync`. Każdy z nich renderuje **własny** `<div className="sync-indicator sync-indicator--…">` z osobnym komunikatem („Zapisuję finanse", „Samochód zsynchronizowany", „Puls zsynchronizowany"…) i własną pozycją w CSS (`bottom: 16px / 54px / 92px / … / 320px` — 9-poziomowy stos w prawym dolnym rogu, na mobile do `408px`).

Efekt: użytkownik widzi kilka wskaźników naraz, „z każdego modułu wyskakuje oddzielnie". Cel: **jeden** wskaźnik zbiorczy zamiast dziewięciu.

## Wymagania

- Zamiast 9 osobnych wskaźników — dokładnie **jeden** wskaźnik synchronizacji w całej aplikacji.
- Wskaźnik agreguje stany wszystkich modułów w jeden zbiorczy stan.
- **Chowa się, gdy wszystko jest zsynchronizowane** — pojawia się tylko podczas zapisu / oczekiwania na sieć / scalania konfliktu; po zakończeniu synchronizacji pokazuje krótko „Zsynchronizowano" i znika.
- **Komunikat ogólny**, bez nazw modułów: „Synchronizuję…", „Zsynchronizowano", „Zmiany czekają na sieć", „Scalam zmiany".
- Zachowanie na wąskim ekranie (PWA) — jeden wskaźnik, poprawnie pozycjonowany, bez kolizji z dolną nawigacją.
- Bez zmian w logice synchronizacji poszczególnych modułów (endpointy, store'y danych, silniki sync zostają nietknięte).

## Zakres i Non-goals

**W zakresie:**
- Nowy, lekki store statusu synchronizacji (prezentacyjny) — mapa `moduł → stan`.
- Raportowanie stanu z każdego z 9 providerów do wspólnego store'u (zamiast renderowania własnego `<div>`).
- Jeden komponent `SyncIndicator` czytający zagregowany stan, z logiką auto-hide.
- Uproszczenie `src/styles/server.css` — usunięcie 9 reguł pozycjonowania per-moduł, dodanie stanu ukrytego/animacji.

**Non-goals (świadomie pomijamy):**
- Zmiana silników synchronizacji / hooków `useXSync` (logika `saving`/`offline`/`conflict` bez zmian).
- Zmiana endpointów, migracji, store'ów danych, modelu prywatne/wspólne.
- Nazwy modułów w komunikacie / rozwijana lista szczegółów per moduł.
- Zmiana systemu toastów akcji (`showToast` w `src/App.tsx`) — to osobny mechanizm, zostaje.

## Podejście

Wzorzec „raportowanie do wspólnego store'u + jeden konsument":

1. **Nowy store `src/store/useSyncStatusStore.ts`** (zustand, zgodnie z resztą `src/store/`). Trzyma `states: Record<ModuleId, ModuleSyncState>` oraz akcje `report(module, state)` i `clear(module)`. Selektor/util `aggregateSyncState(states)` liczy stan zbiorczy wg priorytetu:
   `offline` > `conflict` > `saving` > `synced` (pusta mapa = `synced`). Uzasadnienie priorytetu: offline to najważniejsza informacja dla użytkownika (dane niewysłane), potem trwające scalanie, potem zwykły zapis.

2. **Każdy z 9 providerów** przestaje renderować własny `<div className="sync-indicator …">`. Zamiast tego raportuje swój `syncState` do store'u przez wspólny hook pomocniczy `useReportSyncStatus(moduleId, syncState)` (useEffect: `report` przy zmianie, `clear` przy unmount). Dla 8 modułów `syncState` pochodzi z istniejącego `useXSync()`; dla `WorkspaceSync` — z jego wewnętrznego `syncState` (uwaga: `WorkspaceSync` jest blokujący i renderuje `AuthSyncLoading`/kartę migracji, więc raportowanie musi być wywołane bezwarunkowo, przed wczesnymi `return`).

3. **Jeden `SyncIndicator`** (`src/components/SyncIndicator.tsx`) montowany **raz** w `AuthGate` jako rodzeństwo drzewa `WorkspaceSync` (wewnątrz `AuthContext.Provider`, zawsze renderowany). Czyta zagregowany stan ze store'u. Logika widoczności:
   - stan `saving`/`offline`/`conflict` → widoczny natychmiast z odpowiednim komunikatem i ikoną (`LoaderCircle` spin / `CloudOff` / `Cloud`),
   - przejście do `synced` → pokazuje „Zsynchronizowano" przez ~1,5 s (timer), potem znika,
   - stan początkowy przy braku raportów → ukryty.

   Reużywamy istniejące klasy CSS (`.sync-indicator`, `--offline`, `--conflict`) i ikony `lucide-react` (`Cloud`, `CloudOff`, `LoaderCircle`) już używane w providerach.

Alternatywa odrzucona: React Context zamiast zustand — odrzucona, bo store'y w projekcie są konsekwentnie na zustand, a raportowanie z 9 miejsc bez re-renderów całego drzewa jest prostsze na zewnętrznym store.

Pamiętaj o `docs/ARCHITECTURE.md`: to Fastify + PostgreSQL (nie Next.js). Ta zmiana jest **czysto frontendowa i prezentacyjna** — nie dotyka granicy prywatne/wspólne ani synchronizacji przez rewizje.

## Pliki do zmiany

**Baza (warstwa danych):** — brak —

**Backend (warstwa backend):** — brak —

**Frontend (warstwa frontend):**

- `src/store/useSyncStatusStore.ts` — **nowy**. Zustand store: `states`, `report(module, state)`, `clear(module)`. Eksport typu `ModuleSyncState = "synced" | "saving" | "offline" | "conflict"` i czystej funkcji `aggregateSyncState(states): ModuleSyncState` (łatwo testowalna jednostkowo). Wzorzec: istniejące store'y w `src/store/` (np. `useCarStore.ts`).
- `src/hooks/useReportSyncStatus.ts` — **nowy**. `useReportSyncStatus(moduleId: string, state: ModuleSyncState)`: `useEffect` raportujący `report(moduleId, state)` przy każdej zmianie i `clear(moduleId)` przy unmount. Reużywany przez wszystkie 9 providerów.
- `src/components/SyncIndicator.tsx` — **nowy**. Jeden wskaźnik czytający `aggregateSyncState` ze store'u; auto-hide + krótkie „Zsynchronizowano". Reużywa ikon `lucide-react` i klas `.sync-indicator`.
- `src/server/AuthGate.tsx` — montaż `<SyncIndicator />` raz, jako rodzeństwo `<WorkspaceSync>` wewnątrz `AuthContext.Provider` (zawsze renderowane, niezależnie od gate'u `ready` w WorkspaceSync).
- `src/server/WorkspaceSync.tsx` — usunąć własny `<div className="sync-indicator sync-indicator--${syncState}">`; dodać `useReportSyncStatus("workspace", syncState)` (bezwarunkowo, przed wczesnymi `return` dla ładowania/migracji).
- `src/server/FinanceSync.tsx`, `TripsSync.tsx`, `MealsSync.tsx`, `CarSync.tsx`, `PetsSync.tsx`, `HealthSync.tsx`, `SubscriptionsSync.tsx`, `LifeRecordsSync.tsx` — w każdym: usunąć własny `<div className="sync-indicator sync-indicator--…">`, zamiast tego `useReportSyncStatus("<moduł>", syncState)`. Provider renderuje wtedy tylko `<>{children}</>`.
- `src/styles/server.css` — usunąć 9 reguł pozycjonowania per-moduł (`.sync-indicator--finance/trips/meals/car/pets/health/subscriptions/life` w sekcji bazowej i w `@media (max-width: 760px)`). Zostawić `.sync-indicator`, `--offline`, `--conflict`, bazowe pozycjonowanie mobilne. Dodać płynne pojawianie/znikanie (np. `--hidden` z `opacity`/`visibility` albo warunkowy render + prosta animacja).
- `src/store/useSyncStatusStore.test.ts` — **nowy** (opcjonalnie, zalecane). Test jednostkowy `aggregateSyncState` dla priorytetów.

## Kryteria akceptacji

- [ ] W trybie serwerowym w danej chwili widoczny jest **maksymalnie jeden** wskaźnik synchronizacji (brak stosu 2–9 wskaźników).
- [ ] Podczas zapisu w dowolnym module wskaźnik pokazuje „Synchronizuję…"; gdy któryś moduł jest offline — „Zmiany czekają na sieć"; przy konflikcie workspace — „Scalam zmiany".
- [ ] Po zakończeniu synchronizacji wszystkich modułów wskaźnik pokazuje krótko „Zsynchronizowano" i **znika**.
- [ ] Na wąskim ekranie (PWA) jeden wskaźnik nie koliduje z dolną nawigacją.
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą.
- [ ] Aplikacja odpala się i feature działa w preview (w tym na wąskim ekranie).

## Ryzyka

- **WorkspaceSync jest blokujący** — renderuje `AuthSyncLoading` / kartę migracji przed `{children}`. `useReportSyncStatus` musi być wywołany bezwarunkowo na górze komponentu (reguły hooków Reacta), przed wczesnymi `return`.
- **Test `src/server/WorkspaceSync.test.tsx`** — sprawdzono: nie asertuje na tekst/klasę wskaźnika, więc usunięcie `<div>` nie powinno go zepsuć. Zweryfikować w kroku testów.
- **Tryb lokalny (`!serverMode`)** — `AuthGate` zwraca dzieci bez providerów, więc żaden moduł nie raportuje i `SyncIndicator` pozostaje ukryty (zgodnie z obecnym zachowaniem — brak wskaźników poza serverMode). `SyncIndicator` montowany tylko w gałęzi serverMode.
- **Migotanie przy szybkich cyklach** krótkie `saving`→`synced` — auto-hide z timerem i płynną animacją minimalizuje efekt; unikać zbyt długiego przetrzymywania „Zsynchronizowano".
- **Unmount modułu** — providery żyją przez całą sesję, ale `clear` przy unmount pilnuje, by stan po przelogowaniu (zmiana `key`) nie „przyklejał się" jako stary.

## Pytania do doprecyzowania

Brak — decyzje ustalone w rundzie pytań: (1) wskaźnik chowa się po synchronizacji, (2) komunikat ogólny bez nazw modułów, (3) zakres tylko UI wskaźnika (logika sync bez zmian).
