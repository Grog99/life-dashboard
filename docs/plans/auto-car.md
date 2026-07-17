# Migracja modułu Auto (Car) na znormalizowany model SQL

> Plan wygenerowany przez skill `/plan-feature`. Slug: `auto-car`. Branch: `feature/auto-car`.
>
> Kontynuacja serii migracji z `docs/DATA_MODEL_MIGRATION.md` (moduł #3, priorytet niski–średni).
> **Wzorce referencyjne — trzy zmergowane migracje wg tego samego wzorca:**
> - Finanse (PR #11, pilot, **najbliższy dla warstwy prywatne/wspólne**):
>   `docs/plans/model-synchronizacji-danych.md`, `server/src/finance.mjs`,
>   `server/migrations/006_finance_normalized.sql`, `src/store/useFinanceStore.ts`,
>   `src/hooks/useFinanceSync.ts`, `src/server/FinanceSync.tsx`.
> - Podróże (PR #13, **strukturalnie najbliższy — rodzic + kolekcje potomne, worker czytający SQL**):
>   `docs/plans/podroze-trips.md`, `server/src/trips.mjs`, `server/migrations/007_trips_normalized.sql`,
>   `src/store/useTripsStore.ts`, `src/hooks/useTripsSync.ts`, `src/server/TripsSync.tsx`.
> - Lista zakupów / Meals (PR #14, najświeższy precedens rodzic+dzieci):
>   `docs/plans/lista-zakupow-meals.md`, `server/src/meals.mjs`, `server/migrations/008_meals_normalized.sql`.
>
> **Kluczowa różnica względem Podróży i Meals:** te dwa moduły porzuciły widoczność (zawsze wspólne).
> Auto **zachowuje** rozróżnienie prywatne/wspólne — `Vehicle` i `CarExpense` rozszerzają dziś
> `SharedMeta` (`ownerId`/`visibility`), a `VehicleDeadline` dziedziczy prywatność po rodzicu-pojeździe
> (`CHILD_RELATIONS`). Dlatego **modelem referencyjnym dla warstwy prywatności są Finanse**
> (`finance_accounts`/`finance_transactions` z `owner_id`/`visibility`, `finance_budgets` bez), a nie Podróże.

## Kontekst / Problem

Moduł Auto to dziś fragment dokumentu JSONB (`workspace_states` / `user_workspace_states`),
synchronizowany generycznym mechanizmem `PUT /api/v1/workspace` (globalna rewizja + 3-way merge po
`id`, patrz `server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`). Kolekcje: `vehicles` (rodzic)
oraz `carExpenses`, `vehicleDeadlines` (dzieci przez `vehicleId` — patrz `CHILD_RELATIONS`
w `server/src/workspace.mjs:13-18`).

Uzasadnienie migracji (`docs/DATA_MODEL_MIGRATION.md`, „Uzasadnienie priorytetów" → punkt 3, tabela
priorytetów wiersz „Auto (Car)" — **status już „W trakcie"**):

- **Dowód (a) — pole agregujące, monotoniczne `Vehicle.mileage`, modyfikowane read-modify-write.**
  Współdzielone pole `mileage` jest dziś odczytywane z lokalnego stanu i zapisywane z powrotem w
  **trzech** miejscach klienta, co daje last-write-wins i regresję przebiegu przy równoległej edycji:
  1. `src/pages/CarPage.tsx:345-361` (`saveMileage`) — dedykowany formularz „Aktualny przebieg":
     waliduje klientowo `mileage >= selectedVehicle.mileage`, potem `updateVehicle(id, { mileage })`.
  2. `src/store/useAdvancedStore.ts:129-140` (`addCarExpense`) — dodanie kosztu z przebiegiem wyższym
     niż bieżący **podbija** `vehicle.mileage` jako efekt uboczny (monotonicznie). To **drugi**
     read-modify-write tego samego pola.
  3. `src/pages/CarPage.tsx:230-235` (`saveVehicle`, edycja) — modal edycji pojazdu ma pole „Przebieg",
     waliduje `mileage < editingVehicle.mileage` i woła `updateVehicle(id, data)` z `mileage` w środku.

  To **dokładnie ta sama klasa błędu**, którą normalizacja Finansów naprawiła dla `balanceMinor`: dwoje
  domowników odczytuje tę samą bazę `mileage` i jedna zmiana znika przy scaleniu dokumentu — a że
  przebieg jest **monotoniczny**, zgubienie wyższej wartości to realna regresja (cofnięty licznik).
  Częstotliwość jest niższa niż transakcje/checklisty (stąd priorytet niżej niż Podróże/Meals), ale
  klasa błędu identyczna.

- **Krucha heurystyka auto-generowania terminów po wolnym tekście.** `saveVehicle`
  (`CarPage.tsx:234-289`) utrzymuje `vehicleDeadlines` typu „Badanie techniczne" / „Odnowienie OC/AC"
  ręcznym read-modify-write przez `useAdvancedStore.setState`, dopasowując rekordy po **dopasowaniu
  tekstowym `title`** i wstawiając brakujące. To kruche (zmiana etykiety gubi powiązanie) i podatne na
  race condition (dwie równoległe edycje pojazdu mogą zdublować terminy). Migracja przenosi tę logikę
  na serwer jako atomową mutację domenową ze stabilnym polem `kind`.

Efekt docelowy: Auto przestaje być częścią dokumentu JSONB. Dostaje znormalizowane tabele SQL, mutacje
domenowe z kluczami idempotencji generowanymi po stronie klienta, optymistyczną kontrolę współbieżności
per rekord (kolumna `version`), a `mileage` staje się polem z **atomową, monotoniczną walidacją
serwerową** (klient przestaje bezpiecznie decydować o nadpisaniu). Zachowujemy rozróżnienie
prywatne/wspólne (pojazd/koszt mogą być prywatne; termin dziedziczy prywatność po pojeździe). UI/UX
pozostaje ten sam poza zmianami wymuszonymi modelem.

## Wymagania

Funkcjonalne:

- Dane Auta (`vehicles`, `carExpenses`, `vehicleDeadlines`) w znormalizowanych tabelach SQL, nie w JSONB.
- Każda mutacja domenowa niesie **klucz idempotencji (UUID) generowany przez klienta**; serwer
  deduplikuje po kluczu (tabela `car_mutations`, retencja 30 dni).
- **Optymistyczna współbieżność per rekord** (`version`); konflikt zwracany tylko dla konkretnego
  rekordu, reszta batcha przechodzi.
- **`Vehicle.mileage` z atomową, monotoniczną walidacją serwerową** — dedykowana mutacja domenowa
  `vehicle.mileage` (patrz „Projekt `mileage`"): serwer ustawia `mileage = GREATEST(mileage, $new)`
  atomowo w transakcji, odrzuca próbę cofnięcia i zwraca autorytatywną wartość. Współbieżne podbicia
  przebiegu **oba** się rozstrzygają do maksimum (znika read-modify-write / lost update). `mileage`
  przestaje być polem edytowalnym przez `vehicle.update` (parytet z `balanceMinor` wyciętym z
  `account.update`).
- **Auto-generowanie/aktualizacja terminów na serwerze, atomowo, po stabilnym `kind`** — `vehicle.create`
  zakłada dwa terminy (`kind='inspection'` z `dueDate=inspectionDate`, `kind='insurance'` z
  `dueDate=insuranceDate`) w tej samej transakcji; `vehicle.update` zmieniające `inspectionDate`
  i/lub `insuranceDate` **upsertuje** powiązany termin danego `kind` w tej samej transakcji. Znika
  heurystyka klienta po `title`.
- **Zachowanie prywatności per rekord**: `vehicles`/`car_expenses` mają `owner_id`/`visibility` (jak
  `finance_accounts`/`finance_transactions`); `vehicle_deadlines` **nie mają własnej widoczności** i
  dziedziczą ją po pojeździe-rodzicu (snapshot i push filtrują dostęp przez `EXISTS` na pojeździe).
  Koszt bez jawnej widoczności dziedziczy ją po pojeździe (jak transakcja po koncie).
- Jednorazowa migracja SQL przenosi istniejące dane Auta z JSONB (wspólne z `workspace_states`,
  prywatne z `user_workspace_states`) do nowych tabel z zachowaniem `id`/`ownerId`/`visibility`/
  znaczników czasu, backfilluje `kind` z dzisiejszego `title`, po czym **całkowicie usuwa** kolekcje
  Auta z dokumentu JSONB i z generycznego sync (bez fallbacku).
- **Powiadomienia push „Samochód: <termin>"** (worker, `server/src/worker.mjs:170-183`) działają dalej —
  worker czyta terminy z nowej tabeli, z zachowaniem targetowania per widoczność pojazdu (wspólny →
  wszyscy domownicy, prywatny → tylko właściciel).

Niefunkcjonalne:

- **Offline-first zachowany** — mutacje kolejkują się bez sieci i bezpiecznie odtwarzają (idempotencja),
  optymistyczny UI natychmiast pokazuje zmianę lokalnie.
- Widok Auta wygląda i działa tak samo, także na wąskim ekranie (PWA).
- Reużycie istniejących wzorców backendu i frontendu z Finansów/Podróży/Meals (patrz „Pliki do zmiany").

## Zakres i Non-goals

**W zakresie:**

- Moduł Auto jako bounded context: `vehicles`, `car_expenses`, `vehicle_deadlines` + tabela idempotencji
  `car_mutations`.
- Nowe endpointy REST `/api/v1/car` (snapshot), `/api/v1/car/mutations` (batch), `/api/v1/car/reset`.
- Nowy store frontendu (`useCarStore`) + silnik synchronizacji (`useCarSync` / `CarSync`).
- Serwerowe, atomowe, monotoniczne `mileage` (dedykowana mutacja `vehicle.mileage`); usunięcie
  klientowego read-modify-write przebiegu w trzech miejscach.
- Serwerowe auto-upsert terminów `inspection`/`insurance` po `kind` (usunięcie heurystyki `title`).
- Stabilne pole `kind` (`inspection` | `insurance` | `custom`) na `vehicle_deadlines`.
- **Migracja danych historycznych** z JSONB (wspólne + prywatne) do nowych tabel, backfill `kind`,
  wycięcie Auta z JSONB.
- Aktualizacja workera (odczyt terminów z SQL + targetowanie per widoczność pojazdu, prune `car_mutations`).
- Wycięcie Auta z `workspace.mjs` (`META_COLLECTIONS`/`CHILD_RELATIONS`/`ADVANCED_COLLECTIONS`),
  `useAdvancedStore`, `WorkspaceSync.tsx`, `advancedDataSchema`, `advancedData.ts`.

**Non-goals (świadomie pomijamy — dopasowane do Auta, nie kopia Finansów):**

- **Żaden inny moduł nie jest ruszany** (Finanse/Podróże/Meals już zmigrowane; Pets/Health/Subscriptions/
  Life zostają na JSONB — patrz `docs/DATA_MODEL_MIGRATION.md`). Nie budujemy generycznej „platformy sync"
  na wyrost (YAGNI); kod idempotencji/wersjonowania piszemy w kontekście Auta, **własna** tabela
  idempotencji (`car_mutations`, nie reużywamy `finance_mutations`/`trip_mutations`/`meal_mutations`).
- **Zachowujemy prywatność** — w odróżnieniu od Podróży i Meals (które ją porzuciły) Auto **zostaje**
  z rozróżnieniem prywatne/wspólne dla pojazdów i kosztów, bo dzisiejszy kod je ma (`Vehicle`/`CarExpense
  extends SharedMeta`, aktywne selektory „Widoczność" w obu modalach). Migracja **nie ujawnia** rekordów
  prywatnych (różnica względem `007`/`008`, gdzie prywatne migrowały jako wspólne). Termin
  (`VehicleDeadline`) nie ma i nie zyskuje własnej widoczności — dziedziczy po pojeździe (parytet z dziś).
- **Bez redesignu UI Auta.** Ten sam layout, te same modale i komunikaty. Zmienia się tylko warstwa
  danych i to, co wymusza nowy model: (1) `mileage` przestaje jechać przez generyczny `updateVehicle`
  i idzie osobną akcją `setVehicleMileage` (dedykowana mutacja) — pole w modalu edycji i formularz
  „Aktualny przebieg" wołają tę samą akcję; (2) `vehicleDeadlines` typu inspection/insurance przestają
  być zarządzane ręcznie w `saveVehicle` (serwer je upsertuje). Żadnych nowych ekranów/pól widocznych
  dla użytkownika (poza tym, że `kind` jest wewnętrznym identyfikatorem, nie polem UI).
- **Bez nowych funkcji Auta** — endpointy modelują dokładnie dzisiejszy zestaw mutacji UI
  (`CarPage.tsx`). W szczególności **nie ma `expense.update`** (UI nie edytuje kosztów — tylko dodaje
  i usuwa), więc go nie modelujemy (YAGNI).
- **Derived UI state zostaje po stronie klienta.** `deadlineIsDue`/`deadlineOrder`
  (`CarPage.tsx:101-114`, useMemo `:157-167`) — sortowanie i badge „pilne" liczone przy renderze z
  `dueMileage <= vehicle.mileage` i dni do terminu — to czysto prezentacyjny stan pochodny, **nie**
  migruje na serwer (nie ma odpowiednika `computeTripProgress`; Auto nie ma pola agregującego liczonego
  z dzieci — `mileage` jest wprowadzany przez użytkownika, nie wyliczany).

## Podejście

### Decyzje ustalone z góry (twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe podjęto na podstawie ustaleń z użytkownikiem (runda
pytań), parytetu z Finansami i YAGNI — **rozstrzygnięte, nie otwarte**:

1. **Zakres: cały bounded context Auto naraz** (jeden plan, jedna migracja SQL, jeden PR): `vehicles`
   (rodzic) + `carExpenses` + `vehicleDeadlines` (dzieci przez `vehicleId`).
2. **Migracja: pełna migracja SQL + całkowite zastąpienie** (po migracji Auto znika z JSONB, brak shimów).
3. **Idempotency keys: klient generuje UUID per mutacja**, osobna tabela `car_mutations`.
4. **Konflikty: optimistic concurrency per rekord** przez `version` (dla `vehicle.update`/`*.delete`/
   `deadline.update`), z jednym **świadomym wyjątkiem** dla `mileage` (patrz „Projekt `mileage`").
5. **Auto-generowanie terminów na serwerze**, atomowo w transakcji `vehicle.create`/`vehicle.update`,
   po stabilnym `kind` — nie po `title`.
6. **`mileage` z atomową walidacją server-side** (dedykowana mutacja `vehicle.mileage`), monotonicznie,
   odrzucając cofnięcie — właściwa poprawka klasy błędu (a) z trackera.
7. **Pole `kind`** (`inspection` | `insurance` | `custom`) na `vehicle_deadlines`; `title` zostaje jako
   opisowa etykieta (dla `custom` dowolna), `kind` jako identyfikator logiczny.
8. **Prywatność zachowana** — `vehicles`/`car_expenses` z `owner_id`/`visibility`; `vehicle_deadlines`
   dziedziczy po pojeździe. Rekordy prywatne migrują jako prywatne (bez ujawnienia).

### Model tabel (Postgres) — `server/migrations/009_car_normalized.sql`

`id` typu `text` (zachowanie legacy `id` 1:1, jak w Finansach/Podróżach/Meals — `idSchema` dopuszcza
stringi do 200 znaków). `updated_by uuid REFERENCES users(id)` jako lekki audyt. Mapowanie typów jak w
`finance.mjs`/`trips.mjs`: `date` przez `::text AS …` (uniknięcie lokalno-strefowego parsowania przez
node-postgres), `bigint` przez `Number()`, `timestamptz` przez `.toISOString()`.

- **`vehicles`** (model jak `finance_accounts` — **z** `owner_id`/`visibility`): `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`,
  `name text NOT NULL`, `make text NOT NULL DEFAULT ''`, `model text NOT NULL DEFAULT ''`,
  `year integer NOT NULL`, `plate text NOT NULL DEFAULT ''`,
  `mileage integer NOT NULL DEFAULT 0 CHECK (mileage >= 0)`,
  `fuel_type text NOT NULL CHECK (fuel_type IN ('petrol','diesel','hybrid','electric'))`,
  `inspection_date date NOT NULL`, `insurance_date date NOT NULL`, `color text NOT NULL`,
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(household_id, visibility)`, `(owner_id)` (parytet z `finance_accounts`).
- **`car_expenses`** (model jak `finance_transactions` — **z** `owner_id`/`visibility`): `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `vehicle_id text NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`,
  `date date NOT NULL`,
  `type text NOT NULL CHECK (type IN ('fuel','service','insurance','parking','other'))`,
  `amount_minor bigint NOT NULL CHECK (amount_minor >= 0)`,
  `mileage integer` (nullable — `mileage?`), `liters double precision` (nullable — `liters?`),
  `title text NOT NULL`, `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(vehicle_id)`, `(household_id, visibility)`.
- **`vehicle_deadlines`** (**bez** `owner_id`/`visibility` — dziedziczy po pojeździe, parytet z dzisiejszym
  `CHILD_RELATIONS`; model kolumnowo najbliższy dziecku typu `trip_itinerary`, ale z FK CASCADE do
  `vehicles`): `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `vehicle_id text NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE`,
  `kind text NOT NULL CHECK (kind IN ('inspection','insurance','custom'))`,
  `title text NOT NULL`, `due_date date` (nullable — `dueDate?`),
  `due_mileage integer` (nullable — `dueMileage?`), `completed boolean NOT NULL DEFAULT false`,
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(vehicle_id)`.
  **Częściowy unikat egzekwujący „jeden termin per (pojazd, kind)" dla auto-generowanych:**
  `CREATE UNIQUE INDEX vehicle_deadlines_kind_unique_idx ON vehicle_deadlines(vehicle_id, kind)
  WHERE kind IN ('inspection','insurance')` — pozwala na `INSERT … ON CONFLICT (vehicle_id, kind) DO
  UPDATE` przy auto-upsercie i gwarantuje brak duplikatów. `kind='custom'` nie jest objęty unikatem
  (dowolnie wiele własnych terminów).
- **`car_mutations`** (idempotencja + lekki audyt, 1:1 jak `finance_mutations`/`trip_mutations`):
  `idempotency_key uuid PRIMARY KEY`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `user_id uuid NOT NULL REFERENCES users(id)`, `op text NOT NULL`, `result jsonb NOT NULL`,
  `created_at timestamptz NOT NULL DEFAULT now()`. Indeks `(created_at)` do retencji.

### Projekt `mileage` — atomowa monotoniczna mutacja (analog `balanceMinor`)

**Dzisiaj (klientowo, wadliwie):** `mileage` jest read-modify-write w trzech miejscach (patrz „Kontekst").
Walidacja monotoniczności (`new >= current`) jest wyłącznie klientowa → przy równoległej edycji dwóch
urządzeń niższa wartość może nadpisać wyższą (regresja licznika).

**Docelowo — dedykowana mutacja domenowa `vehicle.mileage`** (op w batchu `/api/v1/car/mutations`, **nie**
osobny endpoint REST — patrz uwaga niżej), payload `{ id, mileage }`, **bez `baseVersion`**. Serwer w
transakcji:

```sql
UPDATE vehicles
   SET mileage = GREATEST(mileage, $newMileage), updated_at = now(), updated_by = $userId
 WHERE id = $id AND household_id = $hh AND (visibility = 'household' OR owner_id = $userId)
   AND $newMileage >= mileage
 RETURNING <VEHICLE_SELECT_COLUMNS>;
```

- **Sukces** (`rowCount=1`): zwróć zaktualizowany pojazd (`status:"applied", record`).
- **`rowCount=0`**: dogrywający `SELECT` po tym samym scope'ie widoczności rozróżnia:
  - pojazd istnieje, ale `$new < current` → `status:"conflict"` z aktualnym (wyższym) rekordem, żeby
    klient pokazał „Nowy przebieg nie może być niższy od obecnego" i **zaadoptował** autorytatywną wartość;
  - pojazd nie istnieje/niedostępny → `status:"error", code:"NOT_FOUND"`.

**Dlaczego to jest analog `balanceMinor`, a nie zwykły OCC:** przebieg — jak saldo — jest polem
**przemiennym** dla operacji, które ma dopuszczać (saldo: dodawanie; przebieg: monotoniczne maksimum).
`GREATEST(mileage, $new)` czyni dwie współbieżne mutacje przemiennymi: druga transakcja czeka na blokadę
wiersza, po zwolnieniu re-ewaluuje `$new >= mileage` względem **już podbitej** wartości i albo podbija
dalej, albo zostaje odrzucona jako cofnięcie — w obu przypadkach wynik to maksimum, **bez zgubionej
aktualizacji**. Dlatego `vehicle.mileage` **nie konsumuje `baseVersion`** (tak jak
`transaction.create` nie konsumował OCC konta — `finance.mjs:886-890`) i **nie bumpuje `version`
pojazdu** — inaczej podbicie przebiegu spod spodu spowodowałoby fałszywy konflikt równoległego
`vehicle.update` (zmiana nazwy). Klient adoptuje nową wartość `mileage` z odpowiedzi (ta sama `version`).

**Uwaga o zgodności z decyzją użytkownika:** runda pytań wskazała „dedykowany endpoint (np. `PATCH
/api/vehicles/:id/mileage`) … z optimistic concurrency przez `version`, analogicznie do `balanceMinor`".
Osadzamy tę mutację **wewnątrz batcha `/api/v1/car/mutations`** (op `vehicle.mileage`), a nie jako osobny
`PATCH`, bo tylko batch daje offline-queue + idempotencję (klucz UUID) — reszta modułu i tak ich wymaga,
a `balanceMinor` w Finansach też **nie** jest osobnym endpointem, lecz efektem mutacji w batchu. Fraza
„analogicznie do `balanceMinor`" prowadzi więc wprost do modelu przemiennego bez OCC opisanego wyżej
(saldo było addytywne bez OCC). Pojazd **ma** kolumnę `version` i `vehicle.update` **używa** OCC — tylko
pole `mileage` jest z niego wyłączone (dokładnie jak `balanceMinor` z `account.update`). To rozstrzygnięte
w tym planie, nie otwarte.

**Efekt uboczny przebiegu przy `expense.create`:** dziś `addCarExpense` podbija `vehicle.mileage`, gdy
koszt niesie wyższy przebieg (`useAdvancedStore.ts:133-137`). Serwerowe `execCarExpenseCreate` po
wstawieniu kosztu wykonuje **ten sam** monotoniczny `UPDATE vehicles SET mileage = GREATEST(mileage,
$expenseMileage) …` (gdy `payload.mileage` podane) i zwraca zaktualizowany pojazd jako `vehicle` w
wyniku (analogicznie jak `transaction.create` zwraca `account` — `finance.mjs:892-896`). Klient adoptuje
autorytatywny przebieg.

### Projekt terminów (`vehicle_deadlines`) — auto-upsert po `kind`, serwerowo i atomowo

**Dzisiaj (klientowo, kruchо):** `saveVehicle` (`CarPage.tsx:234-289`) przy tworzeniu wstawia dwa
terminy „Badanie techniczne"/„Odnowienie OC/AC"; przy edycji dopasowuje je po `(vehicleId, title)` i
aktualizuje `dueDate` albo wstawia brakujące — przez `useAdvancedStore.setState`.

**Docelowo (serwerowo, po `kind`):**

- **`vehicle.create`**: w tej samej transakcji co `INSERT vehicles` serwer wstawia dwa terminy —
  `kind='inspection'` (`title='Badanie techniczne'`, `due_date=inspectionDate`, `completed=false`) i
  `kind='insurance'` (`title='Odnowienie OC/AC'`, `due_date=insuranceDate`). ID terminów generuje serwer
  (`crypto.randomUUID()`) — klient dostaje je w wyniku (`deadlines` w rekordzie wyniku, patrz „Ops").
- **`vehicle.update`** zmieniające `inspectionDate`/`insuranceDate`: w tej samej transakcji, dla każdego
  zmienionego pola:
  `INSERT INTO vehicle_deadlines (…, kind, title, due_date, …) VALUES (…, 'inspection', 'Badanie
  techniczne', $inspectionDate, …) ON CONFLICT (vehicle_id, kind) DO UPDATE SET due_date = EXCLUDED.due_date,
  updated_at = now()` (analogicznie dla `insurance`). **Parytet z dziś:** upsert aktualizuje wyłącznie
  `due_date`, **nie** dotyka `completed` ani `title` (nie „odmyka" ukończonego terminu — dziś też nie
  odmykał, `CarPage.tsx:255`). `ON CONFLICT DO UPDATE` bumpuje `version` odnowionego terminu.
  `vehicle.update` zwraca w wyniku zaktualizowany pojazd **oraz** listę dotkniętych terminów
  (`deadlines`), żeby klient zaadoptował ich serwerowe `id`/`version`/`due_date` bez osobnego GET-a.
- **Terminy własne** (`custom`): `deadline.create`/`deadline.update`/`deadline.delete` — dzisiejsze
  `addDeadline`/`toggleVehicleDeadline`/`removeDeadline` (`CarPage.tsx:363-400`). `deadline.create` z UI
  zawsze tworzy `kind='custom'` (formularz „Nowy termin" nie ma pojęcia inspection/insurance —
  `CarPage.tsx:1032-1092`). `deadline.update` obsługuje `toggleVehicleDeadline` (`changes: { completed }`);
  domykamy zestaw edytowalnych pól do `{ completed, title, dueDate, dueMileage }` (parytet z tym, jak
  `booking.update` w Podróżach wystawia więcej niż UI dziś rusza). `deadline.delete` usuwa dowolny termin
  (także auto-generowany — dziś `removeDeadline` usuwa każdy).

### Ops mutacji (mapowanie 1:1 na dzisiejsze akcje UI z `CarPage.tsx`/`useAdvancedStore.ts`)

```
vehicle.create,  vehicle.update,  vehicle.mileage,  vehicle.delete
expense.create,  expense.delete
deadline.create, deadline.update, deadline.delete
```

- `vehicle.create` — dziś `addVehicle` (`CarPage.tsx:270`) + serwerowe założenie dwóch terminów. Payload:
  `id`, `name`, `make`, `model`, `year`, `plate`, `mileage`, `fuelType`, `inspectionDate`,
  `insuranceDate`, `color`, `visibility`. `ownerId` **z sesji** (`resolveOwnerId`, nigdy z payloadu).
- `vehicle.update` — dziś `updateVehicle` (edycja pól opisowych, `CarPage.tsx:235`). `VEHICLE_UPDATE_KEYS =
  { name, make, model, year, plate, fuelType, inspectionDate, insuranceDate, color }`. **Bez `mileage`**
  (idzie przez `vehicle.mileage`), **bez `ownerId`/`visibility`** (zmiana właściciela/widoczności po
  utworzeniu poza zakresem — parytet z `account.update`, `finance.mjs:259-264`). Zmiana
  `inspectionDate`/`insuranceDate` wyzwala auto-upsert terminów (wyżej). Wynik: `{ record: vehicle,
  deadlines? }`.
- `vehicle.mileage` — dedykowana monotoniczna mutacja (wyżej). Payload `{ id, mileage }`. Wynik:
  `{ record: vehicle }`.
- `vehicle.delete` — dziś brak dedykowanego UI usuwania pojazdu w `CarPage.tsx` (garaż nie ma przycisku
  „usuń pojazd"), ale „Wyczyść dane aplikacji" go potrzebuje przez `reset`; **modelujemy op dla
  kompletności i spójności z resztą** (koszty/terminy kaskadują przez FK `ON DELETE CASCADE`). OCC
  opcjonalne (`baseVersion?`). *Uwaga: jeśli okaże się, że nie ma żadnego wywołania z UI, op i tak jest
  potrzebny do symetrii store'u — ale go nie eksponujemy nowym przyciskiem (Non-goal: bez nowych funkcji).*
- `expense.create` — dziś `addCarExpense` (`CarPage.tsx:322`). Payload: `id`, `vehicleId`, `date`, `type`,
  `amountMinor`, `mileage?`, `liters?`, `title`, `visibility?`. Widoczność bez jawnej wartości dziedziczy
  po pojeździe (`resolveExpenseVisibility`, wzór `resolveTransactionVisibility`, `finance.mjs:100-104`).
  Efekt uboczny monotonicznego `mileage` (wyżej). Wynik: `{ record: expense, vehicle? }`.
- `expense.delete` — dziś `removeExpense` (`CarPage.tsx:337-343`). OCC opcjonalne. **Nie** cofa przebiegu
  (parytet z dziś — usunięcie kosztu nie obniża `mileage`, tak jak usunięcie CSV nie cofało salda).
- `deadline.create` / `deadline.update` / `deadline.delete` — patrz „Projekt terminów".

Wersjonowanie (OCC) jak w Finansach/Podróżach: `vehicle.update`/`deadline.update`/`*.delete` niosą
`baseVersion`; `UPDATE … SET …, version = version + 1 WHERE id=$ AND household_id=$ AND version=$baseVersion
AND (visibility='household' OR owner_id=$user)`; `rowCount=0` → dogrywający `SELECT` w tym samym scope'ie
→ `status:"conflict"` + `currentVersion` albo `status:"error", code:"NOT_FOUND"`. Usuwanie idempotentne
(brak rekordu = `applied`, wzór `resolveConflictOrGone` z `finance.mjs:730-735`). Wyjątek: `vehicle.mileage`
(bez OCC, wyżej). Auto-upsert terminów **nie** konsumuje OCC pojazdu (osobne wiersze).

**Bezpieczeństwo scope'u widoczności (jak `finance.mjs`):** każde zapytanie diagnostyczne
(`resolveConflictOrError`) niesie **ten sam** filtr `household_id` + `(visibility='household' OR
owner_id=$user)` co write, żeby konflikt nie wyciekł istnienia/treści prywatnego rekordu innego domownika.
Dla `vehicle_deadlines` (bez własnej widoczności) filtr dostępu idzie przez `EXISTS` na pojeździe-rodzicu
(patrz „Snapshot"). ID pojazdu w `deadline.create`/`expense.create` sprawdzamy tak jak `tripCheck`
w `execItineraryCreate` (`trips.mjs:937-947`), ale ze scope'em widoczności pojazdu.

### Snapshot read (GET /api/v1/car) — wspólne + własne prywatne, dzieci przez EXISTS

Wzór `readFinanceSnapshot` (`finance.mjs:640-673`), sekwencyjnie (jeden client):

- `vehicles`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2) ORDER BY created_at`.
- `car_expenses`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2) ORDER BY date DESC,
  created_at DESC`.
- `vehicle_deadlines` (bez własnej widoczności — filtr przez rodzica):
  `WHERE household_id=$1 AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_deadlines.vehicle_id
  AND v.household_id=$1 AND (v.visibility='household' OR v.owner_id=$2)) ORDER BY created_at`.

Odpowiedź `{ vehicles[], carExpenses[], vehicleDeadlines[], serverAt }`, każdy rekord z `version`.

### Endpointy REST (wzorzec 1:1 z Finansów/Podróży — `server/src/server.mjs:673-764`)

- **`GET /api/v1/car`** → snapshot (wyżej). Wzór: `GET /api/v1/finance` + `readFinanceSnapshot` (potrzebny
  `session.user_id` do filtra widoczności, jak finance — inaczej niż trips/meals).
- **`POST /api/v1/car/mutations`** → body `{ mutations: Mutation[] }`,
  `Mutation = { idempotencyKey: uuid, op, payload, baseVersion? }`. Serwer: walidacja kształtu całego
  batcha z góry (`assertCarMutationShape`, wzór `assertFinanceMutationShape`), potem sekwencyjnie każda
  mutacja w `transaction()`: claim klucza (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` → retry
  zwraca zapisany `result`), walidacja payloadu, SQL, zapis `result`. Odpowiedź `200`
  `{ results: [{ idempotencyKey, status: "applied"|"duplicate"|"conflict"|"error", record?, vehicle?,
  deadlines?, currentVersion?, error?, code? }], serverAt }`. Globalne `400/413` tylko dla błędów całego
  żądania (zły kształt, przekroczony cap `MAX_CAR_MUTATIONS` / bajtów). Wzór 1:1: blok finance/trips.
- **`POST /api/v1/car/reset`** → `resetCarForUser(client, householdId, userId)`: usuwa wspólne
  (`visibility='household'`) **plus WYŁĄCZNIE prywatne rekordy wywołującego** (`owner_id=userId`) — wzór
  `resetFinanceForUser` (`finance.mjs:684-701`), **nie** bezwarunkowy reset całego gospodarstwa jak
  trips/meals (bo Auto ma rekordy prywatne). Kolejność: `DELETE car_expenses` (household OR owner=user),
  potem `DELETE vehicles` (household OR owner=user) — kaskada FK usuwa `car_expenses`/`vehicle_deadlines`
  dotkniętych pojazdów; prywatne pojazdy innych domowników i ich terminy **zostają** (parytet z finance,
  gdzie prywatne konta innych też zostają).

Reużycie (wszystko już istnieje w `server.mjs`): `requireHousehold`, `transaction()`, handler `23505 →
409`, `httpError`, cap batcha (`MAX_CAR_MUTATIONS_PER_BATCH`/`_BYTES` na wzór `MAX_TRIP_MUTATIONS_*`),
sekwencyjne przetwarzanie mutacji, `session.user_id` w scope'ie.

### Backend — `server/src/car.mjs` (wzór 1:1 z `server/src/finance.mjs`)

Czyste, testowalne funkcje: walidatory payloadów per `op`, `resolveOwnerId`, `resolveExpenseVisibility`,
`resolveVersionConflict`, mapery wiersz→DTO (`vehicleRowToDto`/`carExpenseRowToDto`/
`vehicleDeadlineRowToDto`), `readCarSnapshot(client, householdId, userId)`,
`applyCarMutation(client, ctx, mutation)`, `resetCarForUser(client, householdId, userId)`,
`SUPPORTED_CAR_OPS`, `assertCarMutationShape`, `MAX_CAR_MUTATIONS_*`. **Bez importu z `src/`** (parytet z
`finance.mjs`/`trips.mjs` — serwer nie ma builda TS/zod; walidatory ręczne odzwierciedlają
`vehicleSchema`/`carExpenseSchema`/`vehicleDeadlineSchema` + nowe `version`/`kind`). Reużywa wzorca
`resolveConflictOrError`/`resolveConflictOrGone` (skopiowane z `finance.mjs`), `query`/`transaction` z
`db.mjs`. Stałe do reużycia jako wzór: `VISIBILITIES`/`isId`/`isIsoDate`/`isSafeMoney`/`UUID_PATTERN` z
`finance.mjs`. Auto-upsert terminów jako pomocnicza `upsertAutoDeadline(client, ctx, vehicleId, kind,
title, dueDate)` wołana z `execVehicleCreate`/`execVehicleUpdate`.

### Frontend — dedykowany store + silnik sync (offline-first)

- **`src/store/useCarStore.ts` (nowy)** — wzór 1:1 z `src/store/useTripsStore.ts`/`useFinanceStore.ts`:
  Zustand + `persist` (klucz `puls-car`), `safeLocalStorage`, `parseArrayField`, `merge` z guardem
  `persistedState === undefined` (unikamy fałszywego „niezgodny format" na czystej instalacji — luka #3
  ze „Status po wdrożeniu" Finansów, poprawiona już w `useTripsStore.ts`). Trzyma
  `vehicles/carExpenses/vehicleDeadlines` (każdy z `version`) + `pendingMutations[]` + `serverAt`/`hydrated`.
  Akcje **zachowują nazwy i sygnatury** dzisiejszych z `useAdvancedStore`, żeby diff w `CarPage` był
  minimalny: `addVehicle`, `updateVehicle`, `addCarExpense`, `toggleVehicleDeadline` — **oraz nowe**
  przenoszące dzisiejsze `useAdvancedStore.setState`/logikę z `CarPage`: `setVehicleMileage`
  (dedykowana mutacja `vehicle.mileage`, monotonicznie optymistycznie lokalnie), `deleteVehicle`,
  `addDeadline` (custom), `removeDeadline` (`deadline.delete`), `removeCarExpense` (`expense.delete`),
  `hydrateFromSnapshot`, `applyMutationResults`, `resetCarData`. **Kluczowa zmiana logiki klienta:**
  auto-terminy inspection/insurance **nie są już wstawiane lokalnie** w `saveVehicle` — store po
  `vehicle.create`/`vehicle.update` adoptuje `deadlines` z wyniku serwera (rebase jak `reconcileTerminal`/
  `upsertByUpdateOp` w `useTripsStore.ts`). Efekt uboczny przebiegu przy `addCarExpense` liczony
  optymistycznie lokalnie (`GREATEST`) i nadpisywany autorytatywnym `vehicle` z wyniku. Każda akcja:
  optymistyczna zmiana lokalna → `idempotencyKey` → mutacja do `pendingMutations` z `baseVersion` (poza
  `vehicle.mileage`, które nie niesie `baseVersion`).
- **`src/hooks/useCarSync.ts` + `src/server/CarSync.tsx` (nowe)** — wzór 1:1 z `useFinanceSync.ts` /
  `FinanceSync.tsx` / `TripsSync.tsx`: montaż → `GET /api/v1/car` (hydratacja) → drenaż kolejki przez
  `POST /api/v1/car/mutations`; obsługa `applied`/`duplicate`/`conflict`/`error`; `MAX_FLUSH_ROUNDS`;
  nasłuch `online`/`focus`/`visibilitychange`; nieblokujący provider z własnym `sync-indicator`
  (`sync-indicator--car`, etykiety „Zapisuję samochód" / „Samochód czeka na sieć" / „Samochód
  zsynchronizowany"). Reużywa `apiRequest`/`ApiError` z `src/server/api.ts`.
- **Montaż**: w `src/server/AuthGate.tsx` (`:340-346`) zagnieżdżony wewnątrz `<MealsSync>` (ten sam
  `key`/`onSessionExpired`):
  `…<TripsSync><MealsSync><CarSync …>{children}</CarSync></MealsSync></TripsSync>…`. Dorzuć `useCarStore`
  do importów (`:19-21`), do `bindLocalStorageTo`/`clearLocalUserData` (reset `resetCarData()` +
  `safeRemoveStorageItem("puls-car")`, `:66-92`) i do `hasUnsyncedChanges`
  (`useCarStore.getState().pendingMutations.length > 0`, `:104-108`).

### Odróżnianie prywatne/wspólne (zachowane, w odróżnieniu od Podróży/Meals)

- **Pojazd/koszt**: `owner_id` **zawsze z sesji** (`resolveOwnerId(ctx)`, nigdy z payloadu — pojedynczy
  choke point, `finance.mjs:94-96`), `visibility` z payloadu (walidowana `VISIBILITIES`). Selektory
  „Widoczność" w modalu pojazdu (`CarPage.tsx:871-883`) i kosztu (`:1005-1016`) **zostają**.
- **Termin**: brak własnej widoczności — dziedziczy po pojeździe przez `EXISTS` w snapshotcie i w workerze.
  Modal terminu nie ma i nie zyskuje selektora widoczności (parytet z dziś).
- **Koszt bez jawnej widoczności** dziedziczy po pojeździe (`resolveExpenseVisibility`, wzór
  `resolveTransactionVisibility`). Modal kosztu domyślnie ma `visibility:"household"`
  (`CarPage.tsx:98`), więc wysyła jawną wartość — dziedziczenie to bezpiecznik.

### Worker — powiadomienia o terminach z SQL, z targetowaniem per widoczność pojazdu

`server/src/worker.mjs:170-183` czyta dziś `advanced.vehicleDeadlines` z dokumentu JSONB, by wysłać push
„Samochód: <termin>" (14 dni przed `dueDate`, `completed=false`, `dueDate` obecny). `derivedReminders` jest
wołane dla dokumentu wspólnego (wszyscy domownicy) **i** per prywatny dokument (targetUserId) — dziś to
naturalnie targetuje terminy prywatnych pojazdów tylko do właściciela. Po migracji odtwarzamy to samo
targetowanie odczytem z SQL (analogicznie do `tripReminders`, `worker.mjs:238-257`, ale z rozróżnieniem
widoczności — różnica względem trips, które były zawsze wspólne):

- Nowa `carDeadlineReminders(householdId, nowKey)`:
  `SELECT d.id, d.title, d.due_date::text AS due_date, v.visibility, v.owner_id
   FROM vehicle_deadlines d JOIN vehicles v ON v.id = d.vehicle_id
   WHERE d.household_id = $1 AND d.completed = false AND d.due_date IS NOT NULL`.
  Dla każdego wiersza w oknie `withinDeliveryWindow(shiftLocalDateTime(due_date,'09:00',-14*24*60),
  nowKey, 14)` buduje reminder `{ id: "vehicle:<id>", title: "Samochód: <title>", date: due_date,
  time: "09:00" }` **oraz** `targetUserId = v.visibility === 'private' ? v.owner_id : null`.
- W głównej pętli (`worker.mjs:296-310`, obok `tripReminders`): dla każdego reminderu
  `deliverReminder(workspace, reminder, targetUserId)` — `null` = wszyscy domownicy, `owner_id` = tylko
  właściciel prywatnego pojazdu. `notification_deliveries` (unikat) dba o dedup dostaw.
- Usuwamy pętlę po `advanced.vehicleDeadlines` z `derivedReminders` (`worker.mjs:170-183`) — nie ma już
  tam terminów Auta.
- Dorzucamy prune retencji obok istniejących finance/trips/meals (`worker.mjs:285-288`):
  `DELETE FROM car_mutations WHERE created_at < now() - interval '30 days'`.

### Migracja danych historycznych (`009_car_normalized.sql`)

Wzór 1:1 z `006_finance_normalized.sql` (defensywność wobec `NULL`/nieobecnych kolekcji, `ON CONFLICT (id)
DO NOTHING`, idempotentne przez `schema_migrations`, `owner_id` prywatnych z **kolumny `user_id` wiersza
`user_workspace_states`**, nigdy z JSON):

1. `CREATE TABLE IF NOT EXISTS` dla czterech tabel + indeksy (w tym częściowy unikat `(vehicle_id, kind)`).
2. **Pojazdy wspólne**: `jsonb_array_elements(ws.data->'advanced'->'vehicles')` → `vehicles`
   (`household_id = ws.household_id`, `owner_id = COALESCE(hm.user_id, h.created_by)` z `LEFT JOIN
   household_members hm ON hm.user_id::text = rec->>'ownerId'`, `visibility` z `rec->>'visibility'` z
   fallbackiem `household`, `mileage`/`year` z clampami jak w finance). Wzór: sekcja „Konta: wspólne"
   `006:110-135`.
3. **Pojazdy prywatne**: `jsonb_array_elements(uws.data->'advanced'->'vehicles')` → `vehicles`
   z `household_id = uws.household_id`, `owner_id = uws.user_id`, `visibility='private'`. Wzór:
   „Konta: prywatne" `006:138-160`. **Bez ujawnienia** (różnica względem `007`/`008`).
4. **Koszty** (`carExpenses`) wspólne + prywatne, tylko gdy istnieje zmigrowany rodzic-pojazd w tym
   samym gospodarstwie (`WHERE EXISTS (SELECT 1 FROM vehicles v WHERE v.id = rec->>'vehicleId' AND
   v.household_id = …)` — guard sierot jak dla transakcji, `006:192-195`). `owner_id`/`visibility` jak
   pojazdy.
5. **Terminy** (`vehicleDeadlines`) wspólne + prywatne, tylko gdy istnieje zmigrowany rodzic-pojazd.
   **Backfill `kind`** (jednorazowe dopasowanie po `title`, ostatni raz):
   `CASE WHEN rec->>'title' = 'Badanie techniczne' THEN 'inspection'
         WHEN rec->>'title' = 'Odnowienie OC/AC' THEN 'insurance' ELSE 'custom' END`.
   `due_date = NULLIF(rec->>'dueDate','')::date`, `due_mileage = (rec->>'dueMileage')::integer`,
   `completed = COALESCE((rec->>'completed')::boolean, false)`. Terminy nie mają `owner_id`/`visibility`
   (dziedziczą po pojeździe — nic do przepisania). **Dedup unikatu:** gdyby historycznie istniały dwa
   terminy tego samego `kind` inspection/insurance dla jednego pojazdu (mało prawdopodobne), `ON CONFLICT
   (id) DO NOTHING` chroni PK, a przed unikatem `(vehicle_id, kind)` broni `DISTINCT ON (vehicle_id, kind)
   ORDER BY vehicle_id, kind, created_at ASC` przy insercie auto-kindów — zachowuje najwcześniej utworzony
   rekord danego rodzaju per pojazd (potwierdzone z użytkownikiem).
6. **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data #- '{advanced,vehicles}'
   #- '{advanced,carExpenses}' #- '{advanced,vehicleDeadlines}', revision = revision + 1
   WHERE data->'advanced' ?| array['vehicles','carExpenses','vehicleDeadlines']` oraz analogicznie
   `user_workspace_states` (`updated_at = now()`). Bump `revision` wymusza czysty refetch u klientów
   (wzór `006:305-320`).

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/009_car_normalized.sql` (**nowy**) — kolejny numer po `008_meals_normalized.sql`.
  `CREATE TABLE` czterech tabel + indeksy (w tym częściowy unikat `(vehicle_id, kind)`) + migracja danych
  (wspólne + prywatne, backfill `kind`, guard sierot) + wycięcie z JSONB. Wzorzec:
  `server/migrations/006_finance_normalized.sql` (prywatność) + `007_trips_normalized.sql` (dzieci CASCADE).
- `src/carTypes.ts` (**nowy**) — przenieś `Vehicle`, `CarExpense`, `VehicleDeadline` z
  `src/advancedTypes.ts`; **dodaj `version: number` i `updatedAt: string`** do każdego; **dodaj `kind:
  "inspection" | "insurance" | "custom"`** do `VehicleDeadline`. `Vehicle`/`CarExpense` **nadal
  rozszerzają `SharedMeta`** (zachowują `ownerId`/`visibility` — różnica względem `tripsTypes.ts`/
  `mealsTypes.ts`, które je porzuciły). `VehicleDeadline` bez `SharedMeta` (jak dziś). Wspólne źródło
  prawdy backend/frontend (wzór `src/financeTypes.ts`).
- `src/advancedTypes.ts` — usuń `Vehicle`/`CarExpense`/`VehicleDeadline` (`:35-67`) i pola
  `vehicles`/`carExpenses`/`vehicleDeadlines` z interfejsu `AdvancedData` (`:157-159`); dodaj re-eksport
  `export type { Vehicle, CarExpense, VehicleDeadline } from "./carTypes"` (wzór linii `:13`/`:18` dla
  trips/meals).
- `src/lib/schema.ts` — usuń `vehicles`/`carExpenses`/`vehicleDeadlines` z `advancedDataSchema`
  (`:438-440`); przebuduj `vehicleSchema`/`carExpenseSchema` (**zachowaj `sharedMetaSchema`**, dodaj
  `version: recordVersion` + `updatedAt: timestamp`), `vehicleDeadlineSchema` (dodaj `kind`
  (`z.enum([...])`), `version`, `updatedAt`; `:331-361`) do walidacji snapshotu i persystencji nowego
  store'u (wzór: `financeAccountSchema`/`financeTransactionSchema` z `version` — te z `sharedMetaSchema`).
  Zaktualizuj import typów (dodaj `Vehicle`/`CarExpense`/`VehicleDeadline` z `./carTypes`).

### Backend (warstwa backend)

- `server/src/car.mjs` (**nowy**) — analogicznie do `server/src/finance.mjs`: walidatory payloadów per `op`
  (`validateVehicleCreatePayload`, `validateVehicleUpdatePayload`, `validateVehicleMileagePayload`,
  `validateCarExpenseCreatePayload`, `validateDeadlineCreatePayload`, `validateDeadlineUpdatePayload`,
  `validateDeleteIdPayload`), `resolveOwnerId`, `resolveExpenseVisibility`, `resolveVersionConflict`,
  mapery wiersz→DTO, `upsertAutoDeadline`, `readCarSnapshot`, `applyCarMutation`, `resetCarForUser`,
  `SUPPORTED_CAR_OPS`, `assertCarMutationShape`, `MAX_CAR_MUTATIONS_*`. Reużywa
  `resolveConflictOrError`/`resolveConflictOrGone`/`resolveOwnerId`/`resolveTransactionVisibility` (wzorce
  z `finance.mjs`). **Bez importu z `src/`**. Monotoniczne `execVehicleMileage` + efekt uboczny w
  `execCarExpenseCreate` (opis w „Projekt `mileage`").
- `server/src/server.mjs` — dodaj importy z `./car.mjs` (obok `./finance.mjs`/`./trips.mjs`/`./meals.mjs`,
  `:20-26`); dodaj `GET /api/v1/car`, `POST /api/v1/car/mutations`, `POST /api/v1/car/reset` (kopiuj
  strukturę bloków finance `:673-718` — te używają `session.user_id` w scope'ie, w odróżnieniu od
  trips/meals; te same reużycia `requireHousehold`/`transaction`/`httpError`/cap batcha).
- `server/src/workspace.mjs` — usuń `"vehicles"`/`"carExpenses"` z `META_COLLECTIONS` (`:2-3`); usuń
  `carExpenses`/`vehicleDeadlines` z `CHILD_RELATIONS` (`:14-15`); usuń `vehicles`/`carExpenses`/
  `vehicleDeadlines` z `ADVANCED_COLLECTIONS` (`:24-26`) — to automatycznie wyłącza je z
  `splitWorkspaceData`/`mergeWorkspaceData` i z `workspaceDocumentIsValid`.
- `server/src/worker.mjs` — dodaj `carDeadlineReminders(householdId, nowKey)` (odczyt terminów z SQL +
  join na `vehicles` dla widoczności/właściciela) i wywołuj ją w głównej pętli obok `tripReminders`
  (`:296-310`) z targetowaniem `deliverReminder(workspace, reminder, targetUserId)`; usuń pętlę po
  `advanced.vehicleDeadlines` z `derivedReminders` (`:170-183`); dodaj prune `car_mutations`
  (`:285-288`). Opis w „Worker".

### Frontend (warstwa frontend)

- `src/store/useCarStore.ts` (**nowy**) — dedykowany store z optymistycznymi mutacjami, kolejką
  `pendingMutations`, `version` per rekord, monotonicznym lokalnym `mileage`, adopcją serwerowych
  `deadlines`/`vehicle` z wyników (opis w „Frontend"). Wzór: `src/store/useTripsStore.ts` /
  `useFinanceStore.ts`.
- `src/hooks/useCarSync.ts` + `src/server/CarSync.tsx` (**nowe**) — silnik sync + nieblokujący provider.
  Wzór: `src/hooks/useFinanceSync.ts` (`:1-166`), `src/server/FinanceSync.tsx` / `src/server/TripsSync.tsx`
  (+ `src/server/api.ts` `apiRequest`/`ApiError`).
- `src/store/useAdvancedStore.ts` — usuń stan `vehicles/carExpenses/vehicleDeadlines` (import typów
  `:25-34`, schematów `:8,19-20`), akcje `addVehicle`/`updateVehicle`/`addCarExpense`/
  `toggleVehicleDeadline` (interfejs `:66-69`, impl `:118-146`), z `partialize` (`:358-360`), `merge`
  (`:287-289,342-344`) i `exportAdvancedData` (`:381-382`).
- `src/pages/CarPage.tsx` — podmień importy akcji z `useAdvancedStore` na `useCarStore` (nazwy zachowane →
  diff minimalny). Konkretnie:
  - `saveMileage` (`:345-361`) → `setVehicleMileage(id, mileage)` (walidacja monotoniczności teraz
    autorytatywnie na serwerze; klient może zostawić lekkie sprawdzenie dla natychmiastowego toastu, ale
    źródłem prawdy jest odpowiedź).
  - `saveVehicle` (`:211-294`): **usuń cały ręczny blok `useAdvancedStore.setState` zarządzający
    terminami** (`:236-289`) — serwer je upsertuje; na edycji zostaje `updateVehicle(id, data-bez-mileage)`
    + osobne `setVehicleMileage`, gdy `mileage` się zmienił; na tworzeniu `addVehicle({...data, ownerId,
    visibility})` (store adoptuje serwerowe `deadlines` z wyniku). Usuń `generateId` dla terminów.
  - `addCarExpense` (`:322`) → `addCarExpense` na nowym store (efekt uboczny `mileage` po stronie serwera).
  - `removeExpense` (`:337-343`) → `removeCarExpense(id)`; `addDeadline` (`:363-392`) → `addDeadline`
    (custom); `removeDeadline` (`:394-400`) → `removeDeadline(id)`; `toggleVehicleDeadline` → bez zmian
    nazwy. Zamień bezpośrednie `useAdvancedStore.setState` na akcje store'u.
  - `hideAmounts` (`:122`) dalej z `useAdvancedStore` (osobista preferencja, zostaje w workspace).
    `currentOwnerId` (`:118`) dalej używany przy `addVehicle`/`addCarExpense`.
- `src/server/WorkspaceSync.tsx` — usuń `vehicles`/`carExpenses`/`vehicleDeadlines` z
  `replaceWithEmptyWorkspace` (`:49-51`).
- `src/server/AuthGate.tsx` — zamontuj `<CarSync>` wewnątrz `<MealsSync>` (`:340-346`); dodaj import
  `useCarStore` (`:19-21`), reset w `bindLocalStorageTo`/`clearLocalUserData` (`:66-92`) +
  `safeRemoveStorageItem("puls-car")`, oraz `useCarStore().pendingMutations` w `hasUnsyncedChanges`
  (`:104-108`).
- `src/pages/SettingsPage.tsx` — w „Wyczyść dane aplikacji" dodaj
  `await apiRequest("/api/v1/car/reset", { method: "POST", json: {} })` obok finance/trips/meals
  (`:178-180`) i `resetCarData()` obok `resetTripsData()`/`resetMealsData()` (`:217-219`); usuń
  `vehicles`/`carExpenses`/`vehicleDeadlines` z lokalnego `replaceAdvancedData` (`:207-209`).
- `src/data/advancedData.ts` — usuń seed `vehicles`/`carExpenses`/`vehicleDeadlines` z
  `createAdvancedData()` (`:92,109,134`); serwer jest źródłem prawdy (domyślny stan offline = pusty),
  analogicznie do wycięcia seedu finance/trips/meals.

### Testy (aktualizacja + nowe)

- Aktualizacja: `src/store/useAdvancedStore.test.ts` (bez Auta), `src/server/workspaceMerge.test.ts`,
  `src/lib/schema.test.ts` (jeśli waliduje advancedData z Autem), `src/server/WorkspaceSync.test.tsx`,
  `src/App.test.tsx`, `server/test/workspace.node.mjs` (bez vehicles/carExpenses/vehicleDeadlines w
  split/merge i `workspaceDocumentIsValid`).
- Nowe: `src/store/useCarStore.test.ts` (optymistyczne mutacje, monotoniczny `mileage` lokalnie, adopcja
  serwerowych terminów przy `addVehicle`/`updateVehicle`, wersje, kolejka, prywatność w payloadzie);
  `server/test/car.node.mjs` (walidatory, `resolveVersionConflict`, `resolveExpenseVisibility`,
  monotoniczny `vehicle.mileage` — dwie współbieżne mutacje dają maksimum, cofnięcie odrzucone;
  auto-upsert `inspection`/`insurance` po `kind` przy create/update; `expense.create` podbija `mileage`;
  scope widoczności w konfliktach; snapshot dzieci przez `EXISTS`; idempotencja retry; reset per-user).

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do Auta w
      `AdvancedData`/`advancedDataSchema`/`useAdvancedStore`/`WorkspaceSync`.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane testy generyczne bez Auta; nowy
      `useCarStore.test.ts` (optymistyczne mutacje, monotoniczny `mileage`, adopcja terminów, wersje,
      kolejka, idempotencja: retry z tym samym kluczem nie dubluje; `conflict` per rekord).
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (bez Auta w
      split/merge i `workspaceDocumentIsValid`); nowy `server/test/car.node.mjs` (opis wyżej).
- [ ] Migracja `009` na bazie z istniejącym Autem w JSONB (w tym prywatnymi pojazdami/kosztami): rekordy
      trafiają do tabel z zachowanym `id`/`ownerId`/`visibility`/znacznikami czasu, `kind` backfillowany
      z `title`, koszty/terminy bez zmigrowanego rodzica pominięte, `data->'advanced'` nie zawiera już
      kolekcji Auta, dwukrotne uruchomienie nie duplikuje, prywatne pozostają prywatne (nie ujawnione).
- [ ] `npm run preview` (także wąski ekran, PWA): dodanie/edycja pojazdu (auto-terminy inspection/insurance
      zakładane i aktualizowane serwerowo przy zmianie dat), aktualizacja przebiegu (formularz + pole w
      modalu edycji), próba cofnięcia przebiegu odrzucona z komunikatem, dodanie tankowania z wyższym
      przebiegiem podbija licznik, dodanie/usunięcie kosztu, dodanie/ukończenie/usunięcie własnego terminu,
      prywatny pojazd/koszt widoczny tylko właścicielowi — działają jak przed zmianą.
- [ ] Offline → online: mutacje bez sieci kolejkują się i zapisują po powrocie; retry tej samej kolejki
      nie tworzy duplikatów.
- [ ] Dwa „urządzenia": równoległe podbicie przebiegu i dodanie tankowania z przebiegiem do tego samego
      pojazdu — licznik osiąga maksimum obu (brak cofnięcia); równoległa edycja różnych pojazdów przechodzi
      bez konfliktu; równoległa edycja tego samego pojazdu ze starą wersją zwraca konflikt tylko dla niego.
- [ ] Worker wysyła push „Samochód: <termin>" z nowej tabeli (14 dni przed `dueDate`, `completed=false`):
      dla pojazdu wspólnego do wszystkich domowników, dla prywatnego tylko do właściciela.
- [ ] Po wdrożeniu: aktualizacja tabeli priorytetów w `docs/DATA_MODEL_MIGRATION.md` — wiersz „Auto (Car)"
      status „W trakcie" → „✅ Zrobione (PR #NN)" z faktycznym numerem PR (dziś ustawione na „W trakcie" bez
      numeru; plan finalizuje ten numer w PR).

## Ryzyka

- **Regresja push o terminach samochodu.** W odróżnieniu od Meals (worker nietknięty) i podobnie do
  Podróży, wycięcie Auta z JSONB **psuje** push, jeśli nie zaktualizujemy `worker.mjs`. Dodatkowo Auto
  ma widoczność — błędne targetowanie ujawniłoby prywatny termin całemu gospodarstwu. Pokryć weryfikacją,
  że reminder `vehicle:<id>` powstaje z SQL i trafia do właściwego audytorium (wszyscy vs właściciel).
- **`mileage` bez OCC (świadomy wyjątek).** `vehicle.mileage` nie niesie `baseVersion` i nie bumpuje
  `version` (analog `balanceMinor`). To zamierzone (monotoniczny `GREATEST` daje przemienność i brak lost
  update). Odnotować w PR, żeby recenzent nie potraktował braku OCC jako niedopatrzenia. Rozjazd formuły
  monotonicznej klient/serwer dałby „miganie" przebiegu — trzymać `GREATEST` po obu stronach (test).
- **Prywatność w konfliktach i snapshotcie dzieci.** Zapytania diagnostyczne konfliktów muszą nieść ten
  sam filtr `(visibility='household' OR owner_id=$user)` co write (inaczej wyciek prywatnego rekordu w
  odpowiedzi konfliktu — jak `finance.mjs` ostrzega przy `resolveConflictOrError`). `vehicle_deadlines`
  filtrowane wyłącznie przez `EXISTS` na pojeździe — łatwo pominąć, że termin sam nie ma widoczności.
- **`kind` jako identyfikator vs `title`.** Auto-upsert opiera się na `kind`, nie `title`. Częściowy unikat
  `(vehicle_id, kind)` egzekwuje „jeden inspection/insurance per pojazd". Migracja musi zbackfillować `kind`
  dokładnie tym samym dopasowaniem po `title`, którego używał dziś klient, inaczej istniejące terminy
  staną się `custom` i auto-upsert stworzy duplikat.
- **Efekt uboczny przebiegu przy `expense.create`.** Łatwo przeoczyć, że dodanie kosztu podbija `mileage`
  (jest w store, nie w UI). Bez tego równoległe „tankowanie z przebiegiem" znów gubiłoby aktualizację.
  Pokryć testem serwerowym.
- **`reset` per-user, nie bezwarunkowy.** W odróżnieniu od trips/meals (`reset` całego gospodarstwa),
  Auto ma rekordy prywatne — `resetCarForUser` kasuje wspólne + wyłącznie prywatne wywołującego (wzór
  `resetFinanceForUser`). Skopiowanie z `resetTripsForHousehold` nuknęłoby prywatne pojazdy innych
  domowników.
- **Duży blast radius wycięcia Auta** (`workspace.mjs`, `advancedTypes.ts`, `schema.ts`,
  `useAdvancedStore.ts`, `WorkspaceSync.tsx`, `advancedData.ts`, `AuthGate.tsx`, `SettingsPage.tsx`,
  `worker.mjs` + testy) — łapane przez `tsc` (strict) i testy; robić atomowo dane → backend → frontend
  (`implement-layered`).
- **Spójność sync z resztą modułów.** Usunięcie Auta z `ADVANCED_COLLECTIONS`/`workspaceDocumentIsValid`
  musi być zsynchronizowane z klientem (schemat + `replaceWithEmptyWorkspace`), inaczej `PUT
  /api/v1/workspace` zwróci `400 INVALID_WORKSPACE_SCHEMA`. Bump `revision` w migracji wymusza czysty
  refetch. Reszta modułów (Pets/Health/Subscriptions/Life) zostaje nietknięta w tym samym dokumencie.
- **Kolejność drenażu offline.** Mutacje zależne (`expense.create`/`deadline.create` po `vehicle.create`;
  `vehicle.mileage` po `vehicle.create`) muszą zachować kolejność — batch wysyłamy uporządkowany, serwer
  przetwarza sekwencyjnie (jak Finanse/Podróże/Meals). Store dokłada mutacje w kolejności wywołań akcji.

## Pytania do doprecyzowania

Wszystkie decyzje projektowe są rozstrzygnięte i wpisane wyżej. Trzy drobne detale techniczne zostały
potwierdzone z użytkownikiem (wybrano rekomendacje):

- **`vehicle.delete` bez wywołania z UI.** Op zdefiniowany w store/backendzie dla symetrii z resztą
  modułów i pod `reset`/kaskadę FK, ale **bez** nowego przycisku w UI (`CarPage.tsx` nie ma dziś usuwania
  pojazdu — zgodnie z Non-goal „bez nowych funkcji").
- **Dedup unikatu `(vehicle_id, kind)` w migracji.** Gdyby historycznie istniały dwa terminy tego samego
  `kind` (`inspection`/`insurance`) na jednym pojeździe, migracja zachowuje **najwcześniej utworzony**:
  `DISTINCT ON (vehicle_id, kind) … ORDER BY vehicle_id, kind, created_at ASC` przy insercie auto-kindów;
  `kind='custom'` bez unikatu, więc bez deduplikacji.
- **`vehicle.update` zmieniający datę NIE „odmyka" ukończonego auto-terminu.** Upsert aktualizuje wyłącznie
  `due_date`, zostawia `completed` bez zmian — parytet z dzisiejszym zachowaniem (`CarPage.tsx:255`).
