# Podróże (Trips) — migracja na znormalizowane tabele SQL

> Plan wygenerowany przez skill `/plan-feature`. Slug: `podroze-trips`. Branch: `feature/podroze-trips`.
>
> Kontynuacja serii migracji z `docs/DATA_MODEL_MIGRATION.md` (moduł #1, priorytet wysoki).
> **Wzorzec referencyjny: zmergowana migracja Finansów** (PR #11,
> `docs/plans/model-synchronizacji-danych.md`, kod: `server/src/finance.mjs`,
> `server/migrations/006_finance_normalized.sql`, `src/store/useFinanceStore.ts`,
> `src/hooks/useFinanceSync.ts`, `src/server/FinanceSync.tsx`). Ten plan świadomie kopiuje
> tamten kształt i wskazuje różnice specyficzne dla Podróży.

## Kontekst / Problem

Moduł Podróże to dziś fragment dokumentu JSONB (`workspace_states` / `user_workspace_states`),
synchronizowany generycznym mechanizmem `PUT /api/v1/workspace` (globalna rewizja + 3-way merge po
`id`, patrz `server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`). Kolekcje: `trips` (rodzic)
oraz `tripItinerary`, `tripBookings`, `packingItems` (dzieci przez `tripId` — patrz `CHILD_RELATIONS`).

Ma dokładnie te same dwie strukturalne wady, które migracja Finansów naprawiła — i to udokumentowane
dowodem w kodzie (`docs/DATA_MODEL_MIGRATION.md`, uzasadnienie priorytetu #1):

1. **Dowód (a) — pole agregujące read-modify-write.** `Trip.progress` jest inkrementowany klientowo:
   `src/pages/TripsPage.tsx:1090` `updateTrip(selectedTrip.id, { progress: Math.min(95, selectedTrip.progress + 3) })`
   (dodanie punktu planu) i `:1102` `Math.min(98, selectedTrip.progress + 5)` (rezerwacja). Klient
   czyta lokalną wartość `progress` i zapisuje ją z powrotem na tym samym polu tego samego wspólnego
   rekordu — **ta sama klasa błędu co `balanceMinor`**: dwoje domowników planujących równolegle (jedno
   dodaje nocleg, drugie punkt planu) odczyta tę samą bazę `progress`, a jedna z inkrementacji zniknie
   przy scaleniu dokumentu.
2. **Dowód (b) — częsta współbieżna edycja listy.** `packingItems` bywa współedytowana tuż przed
   wyjazdem przez kilkoro domowników (odznaczanie/dodawanie pozycji) — scenariusz, w którym globalny
   `409` + 3-way merge całego dokumentu odczuwalnie przeszkadza.

Efekt docelowy: Podróże przestają być częścią dokumentu JSONB. Dostają znormalizowane tabele SQL,
mutacje domenowe z kluczami idempotencji generowanymi po stronie klienta, optymistyczną kontrolę
współbieżności per rekord (kolumna `version`), a `progress` staje się **polem utrzymywanym po stronie
serwera** (klient przestaje je nadpisywać). UI/UX pozostaje ten sam poza zmianami wymuszonymi modelem.

## Wymagania

Funkcjonalne:

- Dane podróży (`trips`, `tripItinerary`, `tripBookings`, `packingItems`) w znormalizowanych tabelach
  SQL, nie w JSONB.
- Każda mutacja domenowa niesie **klucz idempotencji (UUID) generowany przez klienta**; serwer
  deduplikuje po kluczu (tabela `trip_mutations`, retencja 30 dni).
- **Optymistyczna współbieżność per rekord** (`version`); konflikt zwracany tylko dla konkretnego
  rekordu, reszta batcha przechodzi.
- **`Trip.progress` liczony po stronie serwera** — klient nie wysyła już `progress`; serwer ustala jego
  wartość atomowo w tej samej transakcji SQL co mutacja dziecka wpływająca na postęp. Współbieżne
  dodania punktu planu / rezerwacji **oba** podbijają postęp (znika read-modify-write).
- Jednorazowa migracja SQL przenosi istniejące dane podróży z JSONB (wspólne z `workspace_states`,
  historyczne prywatne z `user_workspace_states`) do nowych tabel z zachowaniem `id`/znaczników czasu,
  po czym **całkowicie usuwa** kolekcje trips z dokumentu JSONB i z generycznego sync (bez fallbacku).
- **Powiadomienia push „Za tydzień: <nazwa>"** (worker, `server/src/worker.mjs:170`) działają dalej —
  worker czyta podróże z nowej tabeli zamiast z `data.advanced.trips`.

Niefunkcjonalne:

- **Offline-first zachowany** — mutacje kolejkują się bez sieci i bezpiecznie odtwarzają (idempotencja),
  optymistyczny UI natychmiast pokazuje zmianę lokalnie.
- Widok Podróży wygląda i działa tak samo, także na wąskim ekranie (PWA).
- Reużycie istniejących wzorców backendu i frontendu z Finansów (patrz „Pliki do zmiany").

## Zakres i Non-goals

**W zakresie:**

- Moduł Podróże jako bounded context: `trips`, `trip_itinerary`, `trip_bookings`, `packing_items`
  + tabela idempotencji `trip_mutations`.
- Nowe endpointy REST `/api/v1/trips` (snapshot), `/api/v1/trips/mutations` (batch), `/api/v1/trips/reset`.
- Nowy store frontendu (`useTripsStore`) + silnik synchronizacji (`useTripsSync` / `TripsSync`).
- Serwerowe wyliczanie `progress`; usunięcie klientowego nadpisywania `progress`.
- **Migracja danych historycznych** z JSONB (wspólne + prywatne) do nowych tabel, wycięcie trips z JSONB.
- Aktualizacja workera (odczyt podróży z SQL do powiadomień o wyjazdach).
- Wycięcie trips z `workspace.mjs` (`META_COLLECTIONS`/`CHILD_RELATIONS`/`ADVANCED_COLLECTIONS`),
  `useAdvancedStore`, `WorkspaceSync.tsx`, `advancedDataSchema`.

**Non-goals (świadomie pomijamy):**

- **Żaden inny moduł nie jest ruszany** (Finanse już zmigrowane; Meals/Car/Pets/Health/Subscriptions/
  Life zostają na JSONB — patrz `docs/DATA_MODEL_MIGRATION.md`). Nie budujemy generycznej „platformy
  sync" na wyrost (YAGNI); kod idempotencji/wersjonowania piszemy w kontekście Podróży.
- **Bez redesignu UI Podróży.** Ten sam layout, te same modale i komunikaty. Zmienia się tylko warstwa
  danych i to, co wymusza nowy model: (1) `progress` przestaje być polem wysyłanym z klienta,
  (2) znika selektor „widoczność" z modalu nowej podróży (patrz niżej — podróże są zawsze wspólne).
- **Brak wsparcia dla `visibility: private`** dla podróży — zawsze wspólne dla gospodarstwa (decyzja
  użytkownika). Tabele podróży nie mają kolumn `owner_id`/`visibility` (model jak `finance_budgets`).
- **Bez nowych funkcji Podróży** — endpointy modelują dokładnie dzisiejszy zestaw mutacji UI.

## Podejście

### Decyzje ustalone z góry (twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe podjęto na podstawie ustaleń z użytkownikiem, parytetu
z Finansami i YAGNI:

1. **Zakres: tylko Podróże (jeden bounded context, jedna migracja SQL, jeden PR).**
2. **Migracja: pełna migracja SQL + całkowite zastąpienie** (po migracji trips znika z JSONB, brak shimów).
3. **Idempotency keys: klient generuje UUID per mutacja**, osobna tabela `trip_mutations` (jak
   `finance_mutations` — nie reużywamy jej; każdy moduł ma własną tabelę idempotencji, zgodnie z
   zasadą serii w `docs/DATA_MODEL_MIGRATION.md`).
4. **Konflikty: optimistic concurrency per rekord** przez `version`.
5. **`progress` serwerowy, wyliczany z rekordów potomnych** (nie ręczny inkrementalny licznik — patrz
   „Projekt `progress`").
6. **Podróże zawsze wspólne** — brak kolumn `owner_id`/`visibility`.

### Model tabel (Postgres) — `server/migrations/007_trips_normalized.sql`

`id` typu `text` (zachowanie legacy `id` 1:1, jak w Finansach — `idSchema` dopuszcza stringi do 200
znaków). `updated_by uuid REFERENCES users(id)` jako lekki audyt (jak w tabelach finance). **Brak
`owner_id`/`visibility`** — podróże są zawsze household-wide (model analogiczny do `finance_budgets`),
więc snapshot filtruje wyłącznie po `household_id`, bez `(visibility = 'household' OR owner_id = …)`.

- **`trips`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `name text NOT NULL`, `destination text NOT NULL`, `start_date date NOT NULL`, `end_date date NOT NULL`,
  `status text NOT NULL CHECK (status IN ('idea','planning','active','archived'))`,
  `budget_minor bigint` (nullable — `budgetMinor?`), `currency char(3) NOT NULL`,
  `travelers jsonb NOT NULL DEFAULT '[]'` (lista imion `string[]` — nietabelaryczna, prosta wartość),
  `progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100)`,
  `accent text NOT NULL CHECK (accent IN ('terracotta','ocean','forest','violet'))`,
  `notes text NOT NULL DEFAULT ''`, `version integer NOT NULL DEFAULT 1`,
  `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`,
  `updated_by uuid REFERENCES users(id)`. Indeks: `(household_id)`.
- **`trip_itinerary`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `trip_id text NOT NULL REFERENCES trips(id) ON DELETE CASCADE`, `date date NOT NULL`,
  `time text NOT NULL` (`clockTime` `HH:MM`), `title text NOT NULL`,
  `type text NOT NULL CHECK (type IN ('transport','stay','activity','food','other'))`,
  `location text`, `cost_minor bigint`, `booked boolean NOT NULL DEFAULT false`, `notes text`,
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(trip_id)`.
- **`trip_bookings`**: `id text PK`, `household_id …`, `trip_id text NOT NULL REFERENCES trips ON DELETE CASCADE`,
  `itinerary_item_id text` (nullable, `itineraryItemId?` — **bez** FK, żeby nie blokować usuwania punktu
  planu; parytet z dzisiejszym luźnym powiązaniem w JSONB),
  `type text NOT NULL CHECK (type IN ('flight','train','stay','car','activity'))`,
  `provider text NOT NULL DEFAULT ''`, `reference text NOT NULL DEFAULT ''`, `title text NOT NULL`,
  `start_at timestamptz NOT NULL`, `amount_minor bigint NOT NULL DEFAULT 0`,
  `paid boolean NOT NULL DEFAULT false`, `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(trip_id)`.
- **`packing_items`**: `id text PK`, `household_id …`, `trip_id text NOT NULL REFERENCES trips ON DELETE CASCADE`,
  `name text NOT NULL`, `category text NOT NULL CHECK (category IN ('documents','clothes','electronics','health','other'))`,
  `packed boolean NOT NULL DEFAULT false`, `assigned_to text`, `version integer NOT NULL DEFAULT 1`,
  `created_at`, `updated_at`, `updated_by`. Indeksy: `(household_id)`, `(trip_id)`.
- **`trip_mutations`** (idempotencja + lekki audyt, 1:1 jak `finance_mutations`):
  `idempotency_key uuid PRIMARY KEY`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `user_id uuid NOT NULL REFERENCES users`, `op text NOT NULL`, `result jsonb NOT NULL`,
  `created_at timestamptz NOT NULL DEFAULT now()`. Indeks `(created_at)` do retencji.

Uwaga: `date`/`timestamptz` mapujemy tak jak w `finance.mjs` — `date` przez `::text AS …` (uniknięcie
lokalno-strefowego parsowania przez node-postgres), `timestamptz` przez `.toISOString()`,
`bigint` przez `Number()`.

### Projekt `progress` — dwa podejścia i rekomendacja

**Dzisiejsza logika (klientowa, wadliwa):** start `5` (status `idea`) lub `12` (inaczej) przy tworzeniu;
`+3` (cap `95`) przy dodaniu punktu planu; `+5` (cap `98`) przy rezerwacji; **usuwanie nie zmniejsza**
postępu; nigdy nie zależy od `packingItems`.

- **Opcja A — serwerowy inkrementalny licznik (najbliższy `balanceMinor`).** Serwer w transakcji robi
  `UPDATE trips SET progress = LEAST(cap, progress + delta)` przy `itinerary.create`/`booking.create`.
  Wada: `LEAST(cap, …)` nie jest w pełni przemienne (przy dwóch współbieżnych inkrementacjach blisko
  capu wynik zależy od kolejności), usuwanie nadal nie odwraca, a `progress` zostaje mutowalnym stanem,
  który może „dryfować" względem faktycznej liczby dzieci (np. po ręcznym imporcie/migracji).
- **Opcja B — serwerowy `progress` wyliczany z rekordów potomnych (rekomendacja).** Serwer w tej samej
  transakcji co każda mutacja dziecka wpływająca na postęp **przelicza** `progress` z autorytatywnej
  liczby dzieci i zapisuje wynik do kolumny `trips.progress` (kolumna dalej istnieje, żeby snapshot,
  karty listy i worker miały gotową wartość bez agregacji przy każdym odczycie):

  ```
  progress = clamp(baseForStatus(status) + 3 * itineraryCount + 5 * bookingCount, 0, 98)
  baseForStatus: 'idea' -> 5, w przeciwnym razie -> 12
  ```

  gdzie `itineraryCount`/`bookingCount` to `SELECT count(*)` z `trip_itinerary`/`trip_bookings` dla
  danej podróży, liczone w tej samej transakcji.

**Rekomendacja: Opcja B.** Całkowicie eliminuje klasę błędu read-modify-write (nie ma „bazowej"
wartości do nadpisania), jest **idempotentna i samonaprawialna** (przeliczenie z autorytatywnego
`count(*)` — dwie współbieżne wstawki, każda w zserializowanej transakcji, dają wynik odzwierciedlający
oba dzieci), nie wymaga logiki odwracania przy usuwaniu ani osobnego tokenu OCC dla `progress`.
Świadoma zmiana zachowania (akceptowalna, wynika z modelu): **usunięcie** punktu planu/rezerwacji teraz
obniża `progress` (dziś nie obniżało) — to raczej poprawka niż regresja.

**Potwierdzone z użytkownikiem:** stałe zachowują dzisiejszą heurystykę — `+3` (punkt planu), `+5`
(rezerwacja), baza `5` (status `idea`) / `12` (inaczej), **jeden wspólny cap `98`** (zamiast dzisiejszych
rozbieżnych `95`/`98`). `packing_items` nadal nie wpływają na `progress`. Dodatkowo: **status `archived`
wymusza `progress = 100`** niezależnie od liczby dzieci — `computeTripProgress` zwraca `100`
natychmiast, gdy `status === 'archived'`, pomijając wzór z `count(*)`.

```
computeTripProgress(status, itineraryCount, bookingCount):
  if status === 'archived': return 100
  base = status === 'idea' ? 5 : 12
  return clamp(base + 3 * itineraryCount + 5 * bookingCount, 0, 98)
```

Punkty przeliczenia `progress` (w transakcji SQL): `trip.create` (start z bazy statusu),
`trip.update` gdy zmienia się `status` (w tym przejście w/z `archived`), `itinerary.create`,
`itinerary.delete`, `booking.create`, `booking.delete`. Mutacje `packing_items` **nie** dotykają
`progress` (parytet z dziś). Każda taka mutacja zwraca w wyniku zaktualizowany rekord `trip` (pole
`trip` w wyniku, analogicznie jak `transaction.create` w Finansach zwraca zaktualizowane `account`),
żeby klient zaadoptował autorytatywny `progress` bez osobnego GET-a.

### Ops mutacji (mapowanie 1:1 na dzisiejsze akcje UI)

Modelujemy dokładnie obecny zestaw akcji z `useAdvancedStore`/`TripsPage`:

- `trip.create`, `trip.update` (zmiany pól opisowych: `name`, `destination`, `startDate`, `endDate`,
  `status`, `budgetMinor`, `currency`, `travelers`, `accent`, `notes` — **bez `progress`**, serwer
  liczy sam), `trip.delete`.
- `itinerary.create`, `itinerary.delete`. (UI nie ma edycji punktu planu — tylko dodanie/usunięcie;
  `TripsPage.tsx:746`. Nie modelujemy `itinerary.update` — YAGNI.)
- `booking.create`, `booking.update` (dziś w UI jedynie przełącznik `paid`, `TripsPage.tsx:815` —
  `changes: { paid }`; klucze edytowalne domykamy do zestawu pól rezerwacji), `booking.delete`.
- `packing.create`, `packing.update` (`togglePackingItem` → `changes: { packed }`; **oraz** masowa
  zmiana `assignedTo` przy zmianie nazwy podróżnika, dziś robiona bezpośrednio
  `useAdvancedStore.setState` w `TripsPage.tsx:1119` → seria `packing.update` z `changes: { assignedTo }`),
  `packing.delete`.

Wersjonowanie (OCC) jak w Finansach: `*.update`/`*.delete` niosą `baseVersion`; `UPDATE … SET …,
version = version + 1 WHERE id=$ AND household_id=$ AND version=$baseVersion`; `rowCount=0` → zwróć
aktualny rekord + `currentVersion` jako `status:"conflict"`. Usuwanie idempotentne (brak rekordu =
`applied`). `progress` przeliczany jest deltą liczby dzieci i **nie** konsumuje OCC rodzica (tak jak
saldo konta nie konsumowało OCC w Finansach) — dwie równoległe `itinerary.create` na tę samą podróż
obie przechodzą.

### Endpointy REST (wzorzec 1:1 z Finansów — `server/src/server.mjs:657-702`)

- **`GET /api/v1/trips`** → `{ trips[], itinerary[], bookings[], packing[], serverAt }`, każdy rekord z
  `version`. Filtr: `WHERE household_id = $1` (bez filtra widoczności — wszystko wspólne).
- **`POST /api/v1/trips/mutations`** → body `{ mutations: Mutation[] }`,
  `Mutation = { idempotencyKey: uuid, op, payload, baseVersion? }`. Serwer: walidacja kształtu całego
  batcha z góry (jak `assertFinanceMutationShape`), potem sekwencyjnie każda mutacja w `transaction()`:
  claim klucza (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` → retry zwraca zapisany `result`),
  walidacja payloadu, SQL (create / update-z-OCC / delete-z-OCC + przeliczenie `progress`), zapis
  `result`. Odpowiedź `200` z `{ results: [{ idempotencyKey, status: "applied"|"duplicate"|"conflict"|"error",
  record?, trip?, currentVersion?, error?, code? }], serverAt }`. Globalne `400/413` tylko dla błędów
  całego żądania (zły kształt, przekroczony cap `MAX_TRIP_MUTATIONS` / bajtów).
- **`POST /api/v1/trips/reset`** → usuwa wszystkie rekordy podróży gospodarstwa (kaskada z `trips`).
  Potrzebne, bo „Wyczyść dane aplikacji" (`SettingsPage.tsx:168-174`) po normalizacji nie ma już czym
  nadpisać podróży w JSONB — analogicznie do `POST /api/v1/finance/reset`. Zakres prostszy niż w
  Finansach: brak rekordów prywatnych, więc czyścimy całe gospodarstwo bezwarunkowo.

Reużycie: `requireHousehold`, `transaction()`, handler `23505 → 409`, `httpError`, walidator id typu
`text`, cap batcha — wszystko już istnieje w `server.mjs` po Finansach.

### Frontend — dedykowany store + silnik sync (offline-first)

- **`src/store/useTripsStore.ts` (nowy)** — wzór 1:1 z `src/store/useFinanceStore.ts`: Zustand +
  `persist` (klucz `puls-trips`), `safeLocalStorage`, `parseArrayField`, `merge` z guardem
  `persistedState === undefined` (unikamy fałszywego „niezgodny format" na czystej instalacji — luka #3
  ze „Status po wdrożeniu" Finansów). Trzyma `trips/itinerary/bookings/packing` (każdy z `version`) +
  `pendingMutations[]`. Akcje **zachowują nazwy i sygnatury** dzisiejszych akcji z `useAdvancedStore`
  (`addTrip`, `updateTrip`, `addTripItineraryItem`, `deleteTripItineraryItem`, `addTripBooking`,
  `updateTripBooking`, `deleteTripBooking`, `togglePackingItem`, `addPackingItem`, `deletePackingItem`)
  + nowe `deleteTrip`, `updatePackingItem` (dla rename `assignedTo`), `resetTripsData`,
  `hydrateFromSnapshot`, `applyMutationResults`. Każda akcja: optymistyczna zmiana lokalna →
  `idempotencyKey` → dołożenie mutacji do `pendingMutations` z `baseVersion`. **`progress` liczony
  optymistycznie lokalnie** tą samą formułą co serwer (dla natychmiastowego UI), a po odpowiedzi
  serwera adoptujemy autorytatywny `record.trip` (rebase konfliktu jak `reconcileTerminal` /
  `upsertByUpdateOp` w Finansach).
- **`src/hooks/useTripsSync.ts` + `src/server/TripsSync.tsx` (nowe)** — wzór 1:1 z `useFinanceSync.ts` /
  `FinanceSync.tsx`: montaż → `GET /api/v1/trips` (hydratacja) → drenaż kolejki przez
  `POST /api/v1/trips/mutations`; obsługa `applied`/`duplicate`/`conflict`/`error`; nasłuch
  `online`/`focus`/`visibilitychange`; nieblokujący provider z własnym `sync-indicator` (etykiety
  „Zapisuję podróże" / „Podróże czekają na sieć" / „Podróże zsynchronizowane").
- **Montaż**: w `src/server/AuthGate.tsx` zagnieżdżony obok `FinanceSync`:
  `<WorkspaceSync><FinanceSync><TripsSync …>{children}</TripsSync></FinanceSync></WorkspaceSync>`
  (ten sam `onSessionExpired={() => endLocalSession(true, "expired")}`).

### Worker — powiadomienia o wyjazdach z SQL (różnica względem Finansów!)

`server/src/worker.mjs:170` czyta dziś `advanced.trips` z dokumentu JSONB, by wysłać push
„Za tydzień: <nazwa>" (7 dni przed `startDate`, statusy ≠ `archived`). Finanse **nie** dotykały workera,
Podróże **dotykają**. Po migracji:

- Główna pętla (`worker.mjs:273`) pobiera `ws.data` per gospodarstwo. Dołożymy per gospodarstwo odczyt
  `SELECT id, name, start_date::text, status FROM trips WHERE household_id = $1 AND status <> 'archived'`
  i przekażemy podróże do `derivedReminders` (albo osobną gałęzią budującą `trip:<id>` reminder z tą
  samą logiką `shiftLocalDateTime(startDate,'09:00', -7*24*60)` + `withinDeliveryWindow`).
- Usuniemy pętlę po `advanced.trips` z `derivedReminders` (nie ma już tam podróży).
- Dorzucimy prune retencji obok istniejącego dla finance (`worker.mjs:268`):
  `DELETE FROM trip_mutations WHERE created_at < now() - interval '30 days'`.

### Odróżnianie prywatne/wspólne

Nie dotyczy — podróże są zawsze wspólne. Snapshot i wszystkie mutacje scope'ują wyłącznie po
`household_id`. Znika selektor „widoczność" z `NewTripModal` (`TripsPage.tsx:1184`) i pola
`ownerId`/`visibility` z payloadu tworzenia (wymuszone modelem). Typ `Trip` przestaje rozszerzać
`SharedMeta` (patrz `src/tripsTypes.ts`).

### Migracja danych historycznych (`007_trips_normalized.sql`)

Wzór 1:1 z `006_finance_normalized.sql` (defensywność wobec `NULL`/nieobecnych kolekcji, `ON CONFLICT
(id) DO NOTHING`, idempotentne przez `schema_migrations`), z uproszczeniem (brak `owner_id`/`visibility`):

1. `CREATE TABLE IF NOT EXISTS` dla pięciu tabel + indeksy.
2. **Podróże wspólne**: `jsonb_array_elements(ws.data->'advanced'->'trips')` → `trips`
   (`household_id = ws.household_id`, `progress` przepisany z JSON `rec->>'progress'` z clampem
   0..100, `travelers` jako `COALESCE(rec->'travelers','[]'::jsonb)`).
3. **Podróże prywatne (historyczne)**: `jsonb_array_elements(uws.data->'advanced'->'trips')` →
   `trips` z `household_id = uws.household_id`, **jako household** (podróże nie mają już widoczności).
   Potwierdzone z użytkownikiem: migrujemy jako wspólne (zero utraty danych; ujawnienie całemu
   gospodarstwu jest akceptowaną konsekwencją decyzji „podróże zawsze wspólne", patrz Ryzyka).
4. **Dzieci** (`tripItinerary`/`tripBookings`/`packingItems`) z `workspace_states` **i**
   `user_workspace_states`, tylko gdy istnieje zmigrowany rodzic w tym samym gospodarstwie
   (`WHERE EXISTS (SELECT 1 FROM trips t WHERE t.id = rec->>'tripId' AND t.household_id = …)` — jak
   guard sierot dla transakcji w Finansach).
5. **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data #- '{advanced,trips}'
   #- '{advanced,tripItinerary}' #- '{advanced,tripBookings}' #- '{advanced,packingItems}',
   revision = revision + 1 WHERE data->'advanced' ?| array['trips','tripItinerary','tripBookings','packingItems']`
   oraz analogicznie `user_workspace_states` (`updated_at = now()`). Bump `revision` wymusza czysty
   refetch u klientów.

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/007_trips_normalized.sql` (**nowy**) — kolejny numer po `006`. `CREATE TABLE` pięciu
  tabel + indeksy + migracja danych (wspólne + prywatne) + wycięcie z JSONB (opis wyżej). Wzorzec:
  `server/migrations/006_finance_normalized.sql`.
- `src/tripsTypes.ts` (**nowy**) — przenieś `Trip`, `TripItineraryItem`, `TripBooking`, `PackingItem`
  z `src/advancedTypes.ts`; **dodaj `version: number`** do każdego; `Trip` **przestaje rozszerzać
  `SharedMeta`** (usuń `ownerId`/`visibility`; `progress` zostaje, ale jest serwerowo autorytatywny).
  Wspólne źródło prawdy backend/frontend (jak `src/financeTypes.ts`).
- `src/advancedTypes.ts` — usuń `trips`/`tripItinerary`/`tripBookings`/`packingItems` z interfejsu
  `AdvancedData` i definicje przeniesionych typów (re-eksport z `tripsTypes.ts`, jeśli inne pliki ich
  importują z tego miejsca — jak zrobiono z finance typami).
- `src/lib/schema.ts` — usuń `trips`/`tripItinerary`/`tripBookings`/`packingItems` z `advancedDataSchema`;
  przenieś/zachowaj `tripSchema` (+ `version`, **bez** `sharedMetaSchema`), `tripItinerarySchema`,
  `tripBookingSchema`, `packingItemSchema` (+ `version`) do walidacji snapshotu i persystencji nowego
  store'u (wzór: schematy finance z `version` już tam są).

### Backend (warstwa backend)

- `server/src/trips.mjs` (**nowy**) — analogicznie do `server/src/finance.mjs`: czyste walidatory
  payloadów per `op`, `resolveVersionConflict`, mapery wiersz→DTO, `computeTripProgress(...)`,
  `readTripsSnapshot(client, householdId)`, `applyTripMutation(client, ctx, mutation)`,
  `resetTripsForHousehold(client, householdId)`, `SUPPORTED_TRIP_OPS`, `assertTripMutationShape`,
  `MAX_TRIP_MUTATIONS*`. Reużywa `query`/`transaction` z `db.mjs`. **Bez importu z `src/`** (parytet z
  `finance.mjs` — serwer nie ma builda TS/zod; walidatory ręczne odzwierciedlają `tripSchema` i spółkę).
- `server/src/server.mjs` — dodaj `GET /api/v1/trips`, `POST /api/v1/trips/mutations`,
  `POST /api/v1/trips/reset` (kopiuj strukturę bloków finance `:657-702`; te same reużycia
  `requireHousehold`/`transaction`/`httpError`/cap batcha).
- `server/src/workspace.mjs` — usuń `"trips"` z `META_COLLECTIONS`; usuń `tripItinerary`/`tripBookings`/
  `packingItems` z `CHILD_RELATIONS`; usuń `trips`/`tripItinerary`/`tripBookings`/`packingItems` z
  `ADVANCED_COLLECTIONS` (to automatycznie wyłącza je z `splitWorkspaceData`/`mergeWorkspaceData` i z
  `workspaceDocumentIsValid`).
- `server/src/worker.mjs` — czytaj podróże z tabeli `trips` (per gospodarstwo) zamiast z
  `advanced.trips`; usuń pętlę po `advanced.trips` z `derivedReminders`; dodaj prune
  `trip_mutations` obok istniejącego `finance_mutations` (opis w „Worker").

### Frontend (warstwa frontend)

- `src/store/useTripsStore.ts` (**nowy**) — dedykowany store z optymistycznymi mutacjami, kolejką
  `pendingMutations`, `version` per rekord, lokalnym wyliczaniem `progress`. Wzór:
  `src/store/useFinanceStore.ts`.
- `src/hooks/useTripsSync.ts` + `src/server/TripsSync.tsx` (**nowe**) — silnik sync + provider. Wzór:
  `src/hooks/useFinanceSync.ts`, `src/server/FinanceSync.tsx` (+ `src/server/api.ts` `apiRequest`/`ApiError`).
- `src/store/useAdvancedStore.ts` — usuń stan `trips/tripItinerary/tripBookings/packingItems`, akcje
  (`addTrip`, `updateTrip`, `addTripItineraryItem`, `deleteTripItineraryItem`, `addTripBooking`,
  `updateTripBooking`, `deleteTripBooking`, `togglePackingItem`, `addPackingItem`, `deletePackingItem`),
  z `partialize`, `merge` i `exportAdvancedData` (analogicznie do wycięcia finance).
- `src/pages/TripsPage.tsx` — podmień importy akcji z `useAdvancedStore` na `useTripsStore` (nazwy bez
  zmian → diff minimalny). **Usuń klientowe nadpisywanie `progress`**: `:1090` i `:1102` przestają
  wołać `updateTrip(..., { progress })` — zostają same `addTripItineraryItem`/`addTripBooking` (serwer
  liczy `progress`). `NewTripModal`: usuń pole `progress` z tworzenia (`:1180`) i selektor/pola
  `visibility`/`ownerId` (`:1184`, prop `ownerId`). Masowy rename `assignedTo` (`:1119`,
  `useAdvancedStore.setState`) → seria `updatePackingItem(id, { assignedTo })` na nowym store.
  `hideAmounts` dalej z `useAdvancedStore` (osobista preferencja, zostaje w workspace).
- `src/server/WorkspaceSync.tsx` — usuń `trips`/`tripItinerary`/`tripBookings`/`packingItems` z
  `localData()` (`:48-51`) i z `replaceWithEmptyWorkspace()`.
- `src/server/AuthGate.tsx` — zamontuj `<TripsSync>` wewnątrz `<FinanceSync>` (opis w „Frontend").
- `src/pages/SettingsPage.tsx` — w „Wyczyść dane aplikacji" dodaj `await apiRequest("/api/v1/trips/reset",
  { method: "POST", json: {} })` obok istniejącego `finance/reset` (`:174`) i `resetTripsData()` obok
  `resetFinanceData()` (`:218`).
- `src/data/advancedData.ts` — usuń seed podróży z `createAdvancedData()` (serwer jest źródłem prawdy;
  domyślny stan offline = pusty), analogicznie do wycięcia seedu finance.

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do trips w
      `AdvancedData`/`advancedDataSchema`/`useAdvancedStore`/`WorkspaceSync`.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane: `useAdvancedStore.test.ts` (bez trips),
      `workspaceMerge.test.ts`, `schema.test.ts`, `WorkspaceSync.test.tsx`, `App.test.tsx`; nowe:
      `useTripsStore.test.ts` (optymistyczne mutacje, lokalny `progress`, wersje, kolejka),
      `useTripsSync` (idempotencja: retry z tym samym kluczem nie dubluje; `conflict` per rekord).
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (bez trips
      w split/merge i `workspaceDocumentIsValid`); nowy `server/test/trips.node.mjs`: walidatory,
      `resolveVersionConflict`, `computeTripProgress` (start z bazy statusu, `+3`/`+5`, cap, przeliczenie
      po usunięciu dziecka), addytywność `progress` (dwie współbieżne `itinerary.create` na tę samą
      podróż nie konfliktują i obie liczą się do postępu), kształt wyniku idempotencji.
- [ ] Migracja `007` na bazie z istniejącymi podróżami w JSONB: rekordy trafiają do tabel z zachowanym
      `id`/znacznikami czasu, `data->'advanced'` nie zawiera już kolekcji trips, dwukrotne uruchomienie
      nie duplikuje.
- [ ] `npm run preview` (także wąski ekran, PWA): dodanie punktu planu i rezerwacji podbija `progress`
      (serwerowo), edycja podróży, przełącznik `paid`, odznaczanie/dodawanie/usuwanie pozycji pakowania,
      usunięcie podróży — działają jak przed zmianą.
- [ ] Offline → online: mutacje bez sieci kolejkują się i zapisują po powrocie; retry tej samej kolejki
      nie tworzy duplikatów.
- [ ] Dwa „urządzenia": równoległe dodanie punktu planu i rezerwacji do tej samej podróży — **oba**
      podbijają `progress` (brak zgubionej inkrementacji); równoległa edycja różnych pozycji pakowania
      przechodzi bez konfliktu.
- [ ] Worker wysyła push „Za tydzień: <nazwa>" dla podróży z nowej tabeli (7 dni przed `startDate`,
      status ≠ `archived`).

## Ryzyka

- **Worker czyta trips z nowego źródła — regresja powiadomień.** W odróżnieniu od Finansów, wycięcie
  trips z JSONB **psuje** push o wyjazdach, jeśli nie zaktualizujemy `worker.mjs`. Pokryć testem/
  weryfikacją, że reminder `trip:<id>` powstaje z odczytu SQL.
- **Ujawnienie historycznie prywatnych podróży.** Podróże z `user_workspace_states` (dziś widoczne tylko
  właścicielowi) migrują jako household → stają się widoczne całemu gospodarstwu. To konsekwencja decyzji
  „zawsze wspólne", świadomie zaakceptowana przez użytkownika (zero utraty danych przeważa nad
  ujawnieniem) — odnotować w opisie PR.
- **Zmiana semantyki `progress` przy usuwaniu.** Opcja B obniża `progress` po usunięciu punktu/rezerwacji
  (dziś nie obniżało). Zamierzone i potwierdzone, warte odnotowania w PR.
- **Duży blast radius wycięcia trips** (`workspace.mjs`, `advancedTypes.ts`, `schema.ts`,
  `useAdvancedStore.ts`, `WorkspaceSync.tsx`, `advancedData.ts` + testy) — łapane przez `tsc` (strict) i
  testy; robić atomowo dane → backend → frontend (`implement-layered`).
- **Spójność sync z resztą modułów.** Usunięcie trips z `ADVANCED_COLLECTIONS`/`workspaceDocumentIsValid`
  musi być zsynchronizowane z klientem (schemat + `localData()`), inaczej `PUT /api/v1/workspace` zwróci
  `400 INVALID_WORKSPACE_SCHEMA`. Bump `revision` w migracji wymusza czysty refetch. Reszta modułów
  (Meals/Car/Pets/Health/…) zostaje nietknięta w tym samym dokumencie.
- **`progress` optymistyczny vs serwerowy.** Klient liczy `progress` lokalnie tą samą formułą dla
  natychmiastowego UI; rozjazd formuł klient/serwer dałby „miganie" wartości po odpowiedzi. Trzymać
  jedną formułę jako wspólne źródło (opis + testy po obu stronach).
- **Kolejność drenażu offline.** Mutacje zależne (`itinerary.create`/`packing.create` po `trip.create`)
  muszą zachować kolejność — batch wysyłamy uporządkowany, serwer przetwarza sekwencyjnie (jak Finanse).
- **Luźne `itinerary_item_id` w rezerwacjach.** Celowo bez FK — usunięcie punktu planu nie może wysypać
  rezerwacji; osierocone `itineraryItemId` traktujemy tolerancyjnie (parytet z JSONB).

## Pytania do doprecyzowania

Brak — wszystkie trzy pytania rozstrzygnięte z użytkownikiem (patrz „Projekt `progress`" i migracja
danych historycznych wyżej): historyczne prywatne podróże migrują jako wspólne; stałe `progress`
zachowują dzisiejszą heurystykę (`+3`/`+5`, baza `5`/`12`, wspólny cap `98`); status `archived`
wymusza `progress = 100`.
