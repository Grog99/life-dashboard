# Migracja modelu synchronizacji danych — tracker (od 16.07.2026)

Żywy dokument śledzący kontynuację migracji modułów z dokumentowego modelu JSONB
(`workspace_states` / `user_workspace_states`) na znormalizowane tabele SQL z mutacjami
domenowymi, kluczami idempotencji i optymistyczną kontrolą współbieżności per rekord —
wzorzec ustalony przez pilota Finansów (`docs/plans/model-synchronizacji-danych.md`, PR #11).

`docs/plans/model-synchronizacji-danych.md` pozostaje **niezmieniony** jako historyczny zapis
tamtego PR-a (świadomie ograniczonego do „wyłącznie moduł Finanse"). Ten dokument to osobny,
aktualizowany na bieżąco tracker całej serii — kolejne moduły dostają tu wiersz w tabeli
priorytetów, a każdy z nich dostaje **własny** plan w `docs/plans/<slug>.md` w momencie, gdy
faktycznie ruszamy jego migrację.

## Zasady kontynuacji

1. **Jeden moduł (bounded context razem z kolekcjami potomnymi) = jeden plan = jedna migracja
   SQL = jeden PR.** Nie łączymy niepowiązanych modułów w jednym PR-ze — utrzymuje to blast
   radius review'owalny i izoluje niespodzianki (plan Finansów znalazł podczas E2E trzy luki,
   których nie przewidział; przy dwóch modułach naraz trudniej byłoby je rozdzielić).
2. **Kolekcje potomne migrują się razem z rodzicem, nigdy osobno** — np. `trips` +
   `tripItinerary` + `tripBookings` + `packingItems` to jedna migracja, tak jak
   `finance_accounts` + `finance_transactions` + `finance_budgets` + `finance_goals` były
   jedną.
3. **Migracje robimy sekwencyjnie, nie równolegle.** Każda dotyka tych samych plików
   generycznych (`server/src/workspace.mjs`, `src/store/useAdvancedStore.ts`,
   `src/server/WorkspaceSync.tsx`, `src/advancedTypes.ts`, `src/lib/schema.ts`) — równoległe
   gałęzie biłyby się na tych plikach.
4. **Migrujemy tylko tam, gdzie jest konkretny dowód w kodzie, nie na zapas** (YAGNI —
   zgodnie z Non-goals oryginalnego planu: „Nie budujemy generycznej platformy sync na
   wyrost"). Dwa kryteria kwalifikujące moduł do rozważenia:
   - **(a) Pole agregujące na współdzielonym rekordzie, modyfikowane przez read-modify-write.**
     Ta sama klasa błędu, którą naprawiał plan Finansów dla `balanceMinor`: dwie osoby czytają
     tę samą bazową wartość pola i nadpisują się nawzajem, mimo że logicznie ich zmiany powinny
     się zsumować.
   - **(b) Realna, częsta edycja współbieżna tej samej listy przez kilku domowników
     jednocześnie** (nie tylko teoretyczna możliwość) — scenariusz, w którym globalny
     `409`+3-way-merge całego dokumentu odczuwalnie przeszkadza w praktyce.
   Moduł bez żadnego z tych dowodów zostaje na modelu JSONB, dopóki dowód się nie pojawi.
5. **Wzorzec implementacji jak w Finansach**: warstwa danych → backend → frontend (skill
   `implement-layered`), własna tabela idempotency keys per moduł, `version` per rekord,
   dedykowany store + silnik sync po stronie klienta.

## Priorytetyzacja modułów (stan na 16.07.2026)

| # | Moduł | Kolekcje (dziś JSONB) | Dowód w kodzie | Priorytet | Status |
|---|-------|------------------------|-----------------|-----------|--------|
| — | **Finanse** | finance_accounts/transactions/budgets/goals | `balanceMinor` — read-modify-write addytywny | — | ✅ Zrobione (PR #11) |
| 1 | **Podróże (Trips)** | trips, tripItinerary, tripBookings, packingItems | (a)+(b), patrz niżej | Wysoki | Nie rozpoczęto |
| 2 | **Lista zakupów (Meals)** | recipes, mealSlots, shoppingItems | (b), patrz niżej | Średni | Nie rozpoczęto |
| 3 | **Auto (Car)** | vehicles, carExpenses, vehicleDeadlines | (a), niższa częstotliwość | Niski–średni | Nie rozpoczęto |
| — | Zwierzęta (Pets) | pets, petExpenses, petVisits | brak | — | Zostaje na JSONB |
| — | Zdrowie (Health) | healthAppointments, medications, healthMeasurements | brak | — | Zostaje na JSONB |
| — | Subskrypcje | subscriptions | brak | — | Zostaje na JSONB |
| — | Zadania/Kalendarz/Notatki/Nawyki | tasks, events, reminders, notes, habits (`useLifeStore`) | brak | — | Zostaje na JSONB |

## Uzasadnienie priorytetów

### 1. Podróże (Trips) — priorytet wysoki

- **Kolekcje**: `trips` (rodzic) + `tripItinerary`, `tripBookings`, `packingItems` (dzieci przez
  `tripId`, patrz `CHILD_RELATIONS` w `server/src/workspace.mjs`).
- **Dowód (a)**: `src/pages/TripsPage.tsx:1090` i `:1102` —
  `updateTrip(selectedTrip.id, { progress: Math.min(95, selectedTrip.progress + 3) })` (analogicznie
  `+ 5` przy rezerwacji). Pole `Trip.progress` jest odczytywane z lokalnego stanu i zapisywane jako
  nowa wartość tego samego pola tego samego rekordu — **dokładnie ta sama klasa błędu**, którą
  normalizacja Finansów naprawiła dla `balanceMinor`: dwoje domowników planujących wyjazd równolegle
  (jedno dodaje nocleg, drugie pozycję w planie dnia) odczyta tę samą bazową wartość `progress` i
  jedna z inkrementacji zniknie przy scaleniu dokumentu.
- **Dowód (b)**: lista pakowania (`packingItems`) bywa współedytowana tuż przed wyjazdem przez
  kilkoro domowników jednocześnie.
- **Nakład**: `TripsPage.tsx` ~1665 linii, 3 kolekcje potomne — porównywalny do Finansów (obecnie
  największy pozostały moduł), ale z najsilniejszym uzasadnieniem architektonicznym.

### 2. Lista zakupów (Meals → shoppingItems) — priorytet średni

- **Kolekcje**: `recipes` (rodzic), `mealSlots` (dziecko przez `recipeId`), `shoppingItems`
  (`sourceRecipeId` jest **opcjonalne** — lista działa też jako ogólna, wspólna lista zakupów
  niezwiązana z żadnym przepisem).
- **Dowód (b)**: brak pola agregującego, ale realna, częsta kolizja UX — kilka osób jednocześnie
  odznacza/dodaje pozycje stojąc razem w sklepie. To dokładnie scenariusz, w którym per-dokumentowy
  3-way merge odczuwalnie przeszkadza w praktyce (dużo drobnych, jednoczesnych zmian tej samej
  kolekcji w krótkim oknie czasu).
- `recipes`/`mealSlots` mają niższe ryzyko kolizji same w sobie, ale są tym samym bounded
  context (powiązane przez `sourceRecipeId`/`recipeId`), więc migrują się razem z listą zakupów.

### 3. Auto (Car) — priorytet niski–średni

- **Kolekcje**: `vehicles` (rodzic), `carExpenses`, `vehicleDeadlines` (dzieci przez `vehicleId`).
- **Dowód (a)**: `src/pages/CarPage.tsx` (`saveMileage`) —
  `updateVehicle(selectedVehicle.id, { mileage })` w osobnym formularzu „Zaktualizuj przebieg" to
  last-write-wins na współdzielonym polu `Vehicle.mileage`, które steruje też wyliczeniem
  `vehicleDeadlines` (terminy liczone po przebiegu). Ten sam wzorzec błędu co `progress`/
  `balanceMinor`, ale **niższa częstotliwość w praktyce** — aktualizacja przebiegu to rzadka,
  jednorazowa czynność, nie ciągły strumień zmian jak transakcje czy checklisty. Stąd priorytet
  niżej niż Podróże i lista zakupów, mimo tej samej klasy błędu.

## Moduły pozostające na modelu JSONB (na razie)

Świadomie **nie** migrujemy poniższych, dopóki nie pojawi się konkretny dowód (a) lub (b) —
migrowanie ich teraz byłoby budową „generycznej platformy sync na zapas", której oryginalny plan
Finansów wprost unikał:

- **Zwierzęta** (`pets`, `petExpenses`, `petVisits`) — kolekcje płaskie, bez pola agregującego,
  niska częstotliwość edycji.
- **Zdrowie** (`healthAppointments`, `medications`, `healthMeasurements`) — płaskie, bez pola
  agregującego; duża część rekordów jest prywatna (`visibility: private`), co dodatkowo ogranicza
  powierzchnię kolizji.
- **Subskrypcje** — płaskie, rzadkie zmiany (dodanie/anulowanie subskrypcji).
- **Zadania, Kalendarz, Notatki, Nawyki** (`useLifeStore` — inny dokument niż moduły „advanced") —
  częste zmiany, ale każdy rekord edytowany niezależnie, bez pól agregujących; obecny 3-way merge
  po `id` już dziś zachowuje niezależne zmiany różnych zadań/wydarzeń bez realnej kolizji.

Jeśli w którymś z powyższych pojawi się konkretny dowód (zgłoszony bug, nowa funkcja wprowadzająca
pole agregujące) — dopisz go do tabeli priorytetów wyżej z uzasadnieniem, zamiast migrować „na
wszelki wypadek".

## Jak dodać kolejną migrację

- [ ] Napisz plan per moduł w `docs/plans/<slug>.md` (wzorem
      `docs/plans/model-synchronizacji-danych.md`), zawężony do jednego bounded context —
      **nie** kopiuj Non-goals Finansów dosłownie, dopasuj zakres do tego modułu.
- [ ] Zaimplementuj warstwami: dane (migracja SQL + typy z `version`) → backend
      (`server/src/<moduł>.mjs` + endpointy REST + tabela idempotencji) → frontend (dedykowany
      store + silnik sync), analogicznie do `finance.mjs` / `useFinanceStore.ts` /
      `useFinanceSync.ts` / `FinanceSync.tsx`.
- [ ] Usuń moduł z generycznych `META_COLLECTIONS` / `CHILD_RELATIONS` / `ADVANCED_COLLECTIONS`
      w `server/src/workspace.mjs`, z `useAdvancedStore.ts`, z `WorkspaceSync.tsx` i z
      `advancedDataSchema` w `src/lib/schema.ts`.
- [ ] Zaktualizuj tabelę priorytetów w tym dokumencie (status → „W trakcie (PR #NN)" →
      „✅ Zrobione (PR #NN)").
- [ ] Po wdrożeniu dopisz do planu modułu sekcję „Status po wdrożeniu" z lukami znalezionymi
      podczas weryfikacji E2E, jeśli takie się znajdą (jak w planie Finansów).
