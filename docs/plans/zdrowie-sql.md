# Migracja modułu Zdrowie (Health) na znormalizowany model SQL

> Plan wygenerowany przez skill `/plan-feature`. Slug: `zdrowie-sql`. Branch: `feature/zdrowie-sql`.
>
> Kontynuacja serii migracji z `docs/DATA_MODEL_MIGRATION.md` (moduł #5). **To PIĄTA migracja wg tego
> samego wzorca** — pilot Finansów (PR #11) ustalił kształt, po nim Podróże (PR #13), Lista zakupów/Meals
> (PR #14), Auto/Car (PR #15) i Zwierzęta/Pets (PR #16, NAJŚWIEŻSZY i najbliższy analog).
>
> **Świadoma decyzja, nie odkrycie luki.** Zdrowie **nie ma** dowodu (a) (pole agregujące
> read-modify-write) ani (b) (realna częsta kolizja edycji) z `docs/DATA_MODEL_MIGRATION.md` (kolekcje
> płaskie, niska częstotliwość edycji, do tego **duża część rekordów jest prywatna** — `visibility:
> private` domyślnie w każdym drafcie `HealthPage.tsx`, co dodatkowo ogranicza powierzchnię kolizji).
> Migrujemy je **wyłącznie** z decyzji użytkownika z 17.07.2026 o ujednoliceniu architektury (wszystkie
> moduły → SQL), jawnie uchylając YAGNI z punktu 4 „Zasad kontynuacji". To nota, nie uzasadnienie
> techniczne — nie wymyślamy sztucznego (a)/(b).
>
> **Wzorce referencyjne — pięć zmergowanych migracji:**
> - **Zwierzęta/Pets (PR #16, NAJBLIŻSZY analog)**: `docs/plans/zwierzeta-sql.md`, `server/src/pets.mjs`,
>   `server/migrations/010_pets_normalized.sql`, `src/petsTypes.ts`, `src/store/usePetsStore.ts`,
>   `src/hooks/usePetsSync.ts`, `src/server/PetsSync.tsx`, `server/test/pets.node.mjs`. Pets **zachowuje**
>   rozróżnienie prywatne/wspólne z `visibility` per rekord i ma worker push targetowany per widoczność
>   (`petVisitReminders`). Struktura backendu/frontendu/migracji przenosi się **prawie 1:1**.
> - **Auto/Car (PR #15)**: `docs/plans/auto-car.md`, `server/src/car.mjs`, `src/store/useCarStore.ts`,
>   `src/hooks/useCarSync.ts`, `src/server/CarSync.tsx` — wzorzec store'u/sync i `resetCarForUser`.
> - **Finanse (PR #11, model warstwy prywatne/wspólne)**: `server/src/finance.mjs` (`resolveOwnerId`,
>   `resetFinanceForUser`).

## Kontekst / Problem

Moduł Zdrowie to dziś fragment dokumentu JSONB (`workspace_states` / `user_workspace_states`),
synchronizowany generycznym mechanizmem `PUT /api/v1/workspace` (globalna rewizja + 3-way merge po `id`,
patrz `server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`). Kolekcje: `healthAppointments`,
`medications`, `healthMeasurements` — **trzy PŁASKIE, niezależne kolekcje BEZ relacji rodzic/dziecko**
(inaczej niż Auto/Zwierzęta/Podróże, które mają dzieci przez FK). Są wpisane w `META_COLLECTIONS` oraz
`ADVANCED_COLLECTIONS` w `server/src/workspace.mjs:8-13,23-29`, ale **nie ma** ich w `CHILD_RELATIONS`
(który po migracji Zwierząt jest już pustym `{}`).

Teraz — z decyzji użytkownika o ujednoliceniu architektury (`docs/DATA_MODEL_MIGRATION.md`, aktualizacja
17.07.2026) — przenosimy je na znormalizowane tabele SQL. Po wycięciu Zdrowia w dokumencie „advanced"
z kolekcji zostają już tylko Subskrypcje (`subscriptions`) i metadane gospodarstwa (`householdMembers`/
`householdName`/`hideAmounts`).

Efekt docelowy: Zdrowie przestaje być częścią dokumentu JSONB. Dostaje znormalizowane tabele SQL,
mutacje domenowe z kluczami idempotencji generowanymi po stronie klienta i optymistyczną kontrolę
współbieżności per rekord (kolumna `version`). Zachowujemy rozróżnienie prywatne/wspólne (wizyta, lek
i pomiar mają własną `visibility`). **UI/UX modułu pozostaje identyczne** — `src/pages/HealthPage.tsx`
zmienia tylko warstwę danych (import akcji ze store), nie layout ani modale.

### Czym Zdrowie jest PROSTSZE od Zwierząt/Auta (istotne dla nakładu)

Zwierzęta i Auto niosły komplikacje, których Zdrowie **nie ma** — to czyni tę migrację ściśle prostszym
podzbiorem `pets.mjs`:

1. **Brak relacji rodzic/dziecko.** Trzy kolekcje są całkowicie niezależne — **żadnego** `pet_id`/
   `vehicle_id` FK, **żadnej** kaskady `ON DELETE CASCADE` między nimi, **żadnego** guardu sierot
   w migracji, **żadnego** scope'owania przez `EXISTS` na rodzicu. Każdy rekord filtruje wyłącznie po
   swoim wierszu (`visibility='household' OR owner_id=$user`).
2. **Brak kaskady widoczności.** Ponieważ nie ma dzieci, `*.update` zmieniające `visibility` dotyka
   tylko własnego wiersza — znika cała logika `cascadePetVisibility` z `pets.mjs`.
3. **Brak dziedziczenia widoczności przy tworzeniu.** Nie ma rodzica, po którym dziecko dziedziczyłoby
   `visibility` — każdy `*.create` niesie **jawną** `visibility` (draft w `HealthPage.tsx` zawsze ją
   ustawia, domyślnie `private`). Znika cały wariant `resolveExpenseVisibility`/`resolveVisitVisibility`.
4. **Brak pola agregującego / monotonicznego.** Nie ma odpowiednika `Vehicle.mileage` (`balanceMinor`) —
   **żadnej** dedykowanej mutacji `GREATEST` bez OCC. Wszystkie update-y używają OCC per rekord.
5. **Brak zagnieżdżonej tablicy JSONB.** Nie ma odpowiednika `fishStock`/`travelers` — same skalary.

Nowe (specyficzne dla Zdrowia) względem Zwierząt są tylko trzy drobiazgi pól „specjalnych" (patrz
„Projekt pól specjalnych" niżej): `medication.lastTakenOn` (prawdziwy toggle na jednym polu),
`medication.reminderTime`/`schedule`, oraz `healthMeasurement.measuredAt` (free-form timestamp).
Do tego worker ma **dwa** derived-reminery zdrowia (wizyta i lek), nie jeden.

## Wymagania

Funkcjonalne:

- Dane Zdrowia (`healthAppointments`, `medications`, `healthMeasurements`) w znormalizowanych tabelach
  SQL, nie w JSONB. Trzy niezależne, płaskie kolekcje bez FK między sobą.
- Każda mutacja domenowa niesie **klucz idempotencji (UUID) generowany przez klienta**; serwer
  deduplikuje po kluczu (własna tabela `health_mutations`, retencja 30 dni — **nie** reużywamy
  `pet_mutations`/`car_mutations` itd.).
- **Optymistyczna współbieżność per rekord** (`version`); konflikt zwracany tylko dla konkretnego
  rekordu, reszta batcha przechodzi. **Wszystkie** update-y używają OCC (brak wyjątku).
- **Zachowanie prywatności per rekord**: wszystkie trzy tabele mają `owner_id`/`visibility`
  (jak `pets`/`car_expenses`); `owner_id` zawsze **z sesji**, nigdy z payloadu. `visibility` jest
  **jawnie** wymagana na tworzeniu i **edytowalna** po utworzeniu (parytet z dzisiejszym
  `updateHealth*`).
- **`medication.lastTakenOn` zostaje JEDNYM polem** (nie tabelą historii — świadomy non-goal). Dzisiejszy
  `toggleMedicationTaken` nadpisuje pojedyncze pole datą albo czyści do `undefined` (prawdziwy toggle
  liczony lokalnie); ZACHOWUJEMY to 1:1 jako zwykłą kolumnę z OCC przez `version`.
- Jednorazowa migracja SQL przenosi istniejące dane Zdrowia z JSONB (wspólne z `workspace_states`,
  prywatne z `user_workspace_states`) do nowych tabel z zachowaniem `id`/`ownerId`/`visibility`/
  znaczników czasu i wartości pól, po czym **całkowicie usuwa** kolekcje Zdrowia z dokumentu JSONB i z
  generycznego sync (bez fallbacku). Rekordy prywatne migrują jako prywatne (bez ujawnienia — jak Pets/
  Auto/Finanse).
- **Powiadomienia push działają dalej** — worker czyta z nowych tabel, z zachowaniem targetowania per
  widoczność (wspólna → wszyscy domownicy, prywatna → tylko właściciel):
  - **„Nadchodzi wizyta: &lt;tytuł&gt;" (-24 h)** dla `healthAppointments` (`status='scheduled'`),
  - **„Pora przyjąć: &lt;name&gt; &lt;dosage&gt;"** codziennie o `reminderTime` dla `medications`
    (`active && lastTakenOn != today`).
  - Prefiksy `health-appointment:` i `medication:` MUSZĄ zostać identyczne (dedup w
    `notification_deliveries`).

Niefunkcjonalne:

- **Offline-first zachowany** — mutacje kolejkują się bez sieci i bezpiecznie odtwarzają (idempotencja),
  optymistyczny UI natychmiast pokazuje zmianę lokalnie.
- Widok Zdrowia wygląda i działa tak samo, także na wąskim ekranie (PWA).
- Reużycie istniejących wzorców backendu i frontendu ze Zwierząt/Auta (patrz „Pliki do zmiany").

## Zakres i Non-goals

**W zakresie:**

- Moduł Zdrowie jako bounded context: `health_appointments`, `medications`, `health_measurements`
  + tabela idempotencji `health_mutations`. **Wszystkie 3 kolekcje razem, jeden PR** (są tym samym
  modułem tracker'a, wiersz #5 — mimo braku relacji rodzic/dziecko migrują się jako jeden bounded
  context „Zdrowie").
- Nowe endpointy REST `/api/v1/health` (snapshot), `/api/v1/health/mutations` (batch),
  `/api/v1/health/reset`.
- Nowy store frontendu (`useHealthStore`) + silnik synchronizacji (`useHealthSync` / `HealthSync`).
- **Migracja danych historycznych** z JSONB (wspólne + prywatne) do nowych tabel, wycięcie Zdrowia
  z JSONB.
- Aktualizacja workera (dwa dedykowane reminery zdrowia czytające z SQL + targetowanie per widoczność,
  prune `health_mutations`).
- Wycięcie Zdrowia z `workspace.mjs` (`META_COLLECTIONS`/`ADVANCED_COLLECTIONS`), `useAdvancedStore`,
  `WorkspaceSync.tsx`, `advancedDataSchema`, `advancedData.ts`, `advancedTypes.ts`, `AuthGate.tsx`,
  `SettingsPage.tsx`, `TodayPage.tsx`, `CommandPalette.tsx`.

**Non-goals (świadomie pomijamy — dopasowane do Zdrowia):**

- **Ścisła migracja 1:1 — bez nowych funkcji, bez zmiany UX/zachowania.** Endpointy modelują dokładnie
  dzisiejszy zestaw mutacji `HealthPage.tsx`. Żadnych nowych pól ani ekranów.
- **Świadomie odrzucamy tabelę `medication_intake_log` / historię przyjęć leków** (YAGNI, poza
  zakresem). `lastTakenOn` zostaje jednym polem nadpisywanym 1:1, dokładnie jak dziś.
- **Żaden inny moduł nie jest ruszany** (Finanse/Podróże/Meals/Auto/Zwierzęta już zmigrowane;
  Subskrypcje/Life zostają na JSONB). Nie budujemy generycznej „platformy sync"; **własna** tabela
  idempotencji `health_mutations`.
- **Zachowujemy prywatność** — trzy tabele z `owner_id`/`visibility`. Migracja **nie ujawnia** rekordów
  prywatnych (parytet z `010`/Pets i `009`/Auto).
- **Bez redesignu UI.** Ten sam layout, te same modale, te same nazwy i sygnatury akcji store'u
  (`addHealthAppointment`/`updateHealthAppointment`/`deleteHealthAppointment`/`addMedication`/
  `updateMedication`/`deleteMedication`/`toggleMedicationTaken`/`toggleMedicationActive`/
  `addHealthMeasurement`/`updateHealthMeasurement`/`deleteHealthMeasurement`) — żeby diff w
  `HealthPage.tsx`/`TodayPage.tsx`/`CommandPalette.tsx` był minimalny.
- **Brak `appointment.update`-podobnego wyjątku dla toggli.** „Oznacz odbytą" (wizyta) i „Oznacz przyjęte"/
  „Wstrzymaj" (lek) reużywają zwykłego `*.update` z policzoną lokalnie zmianą (jak
  `togglePetVisitCompleted` → `visit.update { status }`).

## Podejście

### Decyzje ustalone z góry (twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe podjęto na podstawie ustaleń z użytkownikiem, parytetu
ze Zwierzętami/Autem i YAGNI — **rozstrzygnięte, nie otwarte**:

1. **Zakres: wszystkie 3 kolekcje Zdrowia naraz** (jeden plan, jedna migracja SQL, jeden PR):
   `healthAppointments` + `medications` + `healthMeasurements`. Kolekcje płaskie, bez relacji
   rodzic/dziecko.
2. **Migracja: pełna migracja SQL + całkowite zastąpienie** (po migracji Zdrowie znika z JSONB, brak
   shimów).
3. **Idempotency keys: klient generuje UUID per mutacja**, osobna tabela `health_mutations`.
4. **Konflikty: optimistic concurrency per rekord** przez `version` (dla wszystkich `*.update`/`*.delete`).
   **Bez żadnego wyjątku** — brak pola agregującego.
5. **Prywatność zachowana** — trzy tabele z `owner_id`/`visibility`; `owner_id` z sesji; `visibility`
   jawna na create, edytowalna na update. **Bez** dziedziczenia po rodzicu (nie ma rodzica) i **bez**
   kaskady na dzieci (nie ma dzieci).
6. **`medication.lastTakenOn` jako jedno pole z OCC** — prawdziwy toggle liczony lokalnie i wysyłany
   jako `medication.update { changes: { lastTakenOn } }`. **Bez** tabeli historii.

### Model tabel (Postgres) — `server/migrations/011_health_normalized.sql`

Kolejny numer po `010_pets_normalized.sql`. `id` typu `text` (zachowanie legacy `id` 1:1 — `idSchema`
dopuszcza stringi do 200 znaków). `updated_by uuid REFERENCES users(id)` jako lekki audyt. Mapowanie
typów jak w `pets.mjs`: `date` przez `::text AS …` (uniknięcie lokalno-strefowego parsowania
node-postgres), `bigint` — brak (Zdrowie nie ma kwot), `timestamptz` (`updated_at`) przez `.toISOString()`.
**Brak jakichkolwiek FK między tabelami Zdrowia** (kolekcje niezależne) — tylko FK do `households`/`users`.

- **`health_appointments`** (model jak `pet_visits`, ale **bez** `pet_id`): `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`, `title text NOT NULL`,
  `clinician text NOT NULL`, `specialty text` (nullable), `date date NOT NULL`, `time text NOT NULL`
  (clockTime `HH:MM` — potrzebne dla push -24 h; `text`, nie `time`, dla parytetu z dzisiejszym stringiem
  i uniknięcia strefowego parsowania — decyzja jak `pet_visits.time`), `location text` (nullable),
  `status text NOT NULL CHECK (status IN ('scheduled','completed','cancelled'))`, `notes text` (nullable),
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(household_id, visibility)`, `(owner_id)`.
- **`medications`**: `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`, `name text NOT NULL`,
  `dosage text NOT NULL`, `schedule text NOT NULL` (wolny tekst — etykieta, **nie** structured
  recurrence), `active boolean NOT NULL`, `last_taken_on date` (nullable — `lastTakenOn?`),
  `reminder_time text` (nullable — clockTime `HH:MM`, `text` z tej samej racji co `time` w wizytach;
  potrzebne dla codziennego push), `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`,
  `updated_by`. Indeksy: `(household_id)`, `(household_id, visibility)`, `(owner_id)`.
- **`health_measurements`**: `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`,
  `type text NOT NULL CHECK (type IN ('weight','blood_pressure','glucose','temperature','other'))`,
  `value text NOT NULL`, `unit text NOT NULL` (dopuszczalny pusty — `z.string().max(100)`, nie
  `nonEmptyText`), `measured_at text NOT NULL` (**free-form timestamp** Date.parse-able, np.
  `2026-07-18T07:30`, przechowywany jako `text` — patrz „Projekt pól specjalnych"), `notes text`
  (nullable), `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(household_id, visibility)`, `(owner_id)`.
- **`health_mutations`** (idempotencja + lekki audyt, 1:1 jak `pet_mutations`):
  `idempotency_key uuid PRIMARY KEY`, `household_id uuid NOT NULL REFERENCES households ON DELETE
  CASCADE`, `user_id uuid NOT NULL REFERENCES users(id)`, `op text NOT NULL`, `result jsonb NOT NULL`,
  `created_at timestamptz NOT NULL DEFAULT now()`. Indeks `(created_at)` do retencji.

### Projekt pól specjalnych

- **`healthMeasurement.measuredAt` → kolumna `text` (NIE `timestamptz`).** Dziś to free-form string
  budowany w `HealthPage.tsx:284` jako `` `${date}T${time}` `` (np. `2026-07-18T07:30`, bez sekund/strefy),
  a odczytywany przez `measurement.measuredAt.split("T")` (`:260`) oraz `parseISO(...)` w renderze. Schema
  waliduje go jako `timestamp` (`z.string().refine(Date.parse)`), **nie** `isoDate`. Przechowanie w
  `timestamptz` **zepsułoby** wartość 1:1: node-postgres sparsowałby go do `Date`, a `.toISOString()`
  zwróciłby `2026-07-18T05:30:00.000Z` (przesunięcie strefowe + sekundy/`Z`), łamiąc `split("T")` i
  wyświetlanie. Dlatego `text` — dokładnie ta sama racja co `pet_visits.time`/`medications.reminder_time`.
- **`medication.lastTakenOn` → kolumna `date` (nullable), jedno pole, OCC przez `version`.** Dziś
  `toggleMedicationTaken` (`useAdvancedStore.ts:128-135`) to **prawdziwy toggle**: ustawia
  `lastTakenOn = date` albo czyści do `undefined`, jeśli już równe (`medication.lastTakenOn === date ?
  undefined : date`). **Nie jest idempotentnym setem.** Zachowujemy 1:1: klient liczy nowy stan lokalnie
  z bieżącego rekordu (jak `togglePetVisitCompleted`) i wysyła `medication.update` z `changes:
  { lastTakenOn: <isoDate|null> }`. Idempotencja klucza chroni przed podwójnym flipnięciem przy retry
  (retry zwraca zapisany `result`, nie wykonuje toggle ponownie). Odczyt: `last_taken_on::text AS
  last_taken_on` (dodge strefowy), `null → undefined` w DTO. **Świadomie odrzucamy** tabelę historii
  przyjęć (`medication_intake_log`) — YAGNI, poza zakresem.
- **`medication.schedule` → `text NOT NULL`** — wolnotekstowa etykieta („Codziennie po śniadaniu"),
  **nie** structured recurrence. Zwykła kolumna, walidacja `nonEmptyText`.
- **`medication.reminderTime` / `healthAppointment.time` → `text` (clockTime `HH:MM`), nullable
  odpowiednio do opcjonalności.** `text` (nie `time`) dla parytetu z dzisiejszym stringiem i uniknięcia
  strefowego rzutowania; oba są czytane przez workera do budowy godziny push.

### Ops mutacji (mapowanie 1:1 na dzisiejsze akcje UI z `HealthPage.tsx`/`useAdvancedStore.ts`)

```
appointment.create,  appointment.update,  appointment.delete
medication.create,   medication.update,   medication.delete
measurement.create,  measurement.update,  measurement.delete
```

- `appointment.create` — dziś `addHealthAppointment` (`HealthPage.tsx:200`). Payload: `id`, `title`,
  `clinician`, `specialty?`, `date`, `time`, `location?`, `status`, `notes?`, `visibility`. `ownerId`
  **z sesji** (`resolveOwnerId`). Wynik: `{ record }`.
- `appointment.update` — dziś `updateHealthAppointment` (`HealthPage.tsx:197`) **oraz**
  `toggleAppointmentCompleted` (`:206-210`, przełącza `status` między `completed` a `scheduled` —
  reużywa `updateHealthAppointment`, **nie** ma dedykowanej akcji). `APPOINTMENT_UPDATE_KEYS = { title,
  clinician, specialty, date, time, location, status, notes, visibility }`. OCC przez `baseVersion`.
  Toggle liczy nowy `status` lokalnie i wysyła `changes: { status }`. Wynik: `{ record }`.
- `appointment.delete` — dziś `deleteHealthAppointment` (`HealthPage.tsx:255`). OCC opcjonalne
  (`baseVersion?`). Usuwanie idempotentne.
- `medication.create` — dziś `addMedication` (`HealthPage.tsx:241`). Payload: `id`, `name`, `dosage`,
  `schedule`, `active` (zawsze `true` przy tworzeniu z UI), `reminderTime?`, `lastTakenOn?` (przy
  tworzeniu z UI nieobecne), `visibility`. Wynik: `{ record }`.
- `medication.update` — dziś `updateMedication` (`HealthPage.tsx:238`), `toggleMedicationActive`
  (`:543` — flip `active`) **oraz** `toggleMedicationTaken` (`:521` — flip `lastTakenOn`). `MEDICATION_
  UPDATE_KEYS = { name, dosage, schedule, active, reminderTime, lastTakenOn, visibility }`. OCC przez
  `baseVersion`. Toggle-e liczą nowy `active`/`lastTakenOn` lokalnie i wysyłają odpowiednio `changes:
  { active }` / `changes: { lastTakenOn }`. `lastTakenOn` obsługiwany jako pole nullable (`hasOwnProperty`,
  wzór `species`/`notes` w `pets.mjs`) — `null` czyści kolumnę. Wynik: `{ record }`.
- `medication.delete` — dziś `deleteMedication` (`HealthPage.tsx:249`). OCC opcjonalne. Idempotentne.
- `measurement.create` — dziś `addHealthMeasurement` (`HealthPage.tsx:292`). Payload: `id`, `type`,
  `value`, `unit`, `measuredAt`, `notes?`, `visibility`. Wynik: `{ record }`.
- `measurement.update` — dziś `updateHealthMeasurement` (`HealthPage.tsx:289`). `MEASUREMENT_UPDATE_KEYS
  = { type, value, unit, measuredAt, notes, visibility }`. OCC przez `baseVersion`. Wynik: `{ record }`.
- `measurement.delete` — dziś `deleteHealthMeasurement` (`HealthPage.tsx:300`). OCC opcjonalne.
  Idempotentne.

Wersjonowanie (OCC) jak w Zwierzętach/Aucie: `*.update`/`*.delete` niosą `baseVersion`;
`UPDATE … SET …, version = version + 1 WHERE id=$ AND household_id=$ AND version=$baseVersion
AND (visibility='household' OR owner_id=$user)`; `rowCount=0` → dogrywający `SELECT` w tym samym scope'ie
→ `status:"conflict"` + `currentVersion` albo `status:"error", code:"NOT_FOUND"`. Usuwanie idempotentne
(brak rekordu = `applied`, wzór `resolveConflictOrGone` z `pets.mjs`).

**Bezpieczeństwo scope'u widoczności (jak `pets.mjs`/`finance.mjs`):** każde zapytanie diagnostyczne
konfliktu niesie **ten sam** filtr `household_id` + `(visibility='household' OR owner_id=$user)` co write,
żeby konflikt nie wyciekł istnienia/treści prywatnego rekordu innego domownika. **Brak** wariantu
`EXISTS`-scoping (nie ma rodzica) i **brak** kaskady widoczności (nie ma dzieci) — obie tabele-dzieci
z `pets.mjs` (`cascadePetVisibility`, sprawdzenie profilu-rodzica przy create) **nie mają tu
odpowiednika**.

### Snapshot read (GET /api/v1/health) — wspólne + własne prywatne (wzór `readPetsSnapshot`)

Sekwencyjnie (jeden `client`; node-postgres = jedno zapytanie in-flight na połączenie):

- `health_appointments`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2)
  ORDER BY date, time`.
- `medications`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2)
  ORDER BY created_at` (parytet z insertion order dzisiejszego `addMedication`, które dopisuje na koniec).
- `health_measurements`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2)
  ORDER BY measured_at DESC, created_at DESC` (UI i tak sortuje malejąco po `measuredAt`; `addHealthMeasurement`
  prependuje).

Wszystkie trzy na **własnej** widoczności. Odpowiedź `{ healthAppointments[], medications[],
healthMeasurements[], serverAt }`, każdy rekord z `version` i `updatedAt`.

### Endpointy REST (wzorzec 1:1 ze Zwierząt — `server/src/server.mjs:879-926`)

- **`GET /api/v1/health`** → snapshot. Wzór: `GET /api/v1/pets` + `readHealthSnapshot` (potrzebny
  `session.user_id` do filtra widoczności).
- **`POST /api/v1/health/mutations`** → body `{ mutations: Mutation[] }`,
  `Mutation = { idempotencyKey: uuid, op, payload, baseVersion? }`. Serwer: walidacja kształtu całego
  batcha z góry (`assertHealthMutationShape`, wzór `assertPetsMutationShape`), potem sekwencyjnie każda
  mutacja w `transaction()`: claim klucza (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` → retry
  zwraca zapisany `result`), walidacja payloadu, SQL, zapis `result`. Odpowiedź `200`
  `{ results: [{ idempotencyKey, status, record?, currentVersion?, error?, code? }], serverAt }`.
  Globalne `400/413` tylko dla błędów całego żądania (zły kształt, przekroczony cap
  `MAX_HEALTH_MUTATIONS`/bajtów). Wzór 1:1: blok `POST /api/v1/pets/mutations`.
- **`POST /api/v1/health/reset`** → `resetHealthForUser(client, householdId, userId)`: usuwa wspólne
  (`visibility='household'`) **plus WYŁĄCZNIE prywatne rekordy wywołującego** (`owner_id=userId`) —
  wzór `resetPetsForUser`/`resetCarForUser`, **nie** bezwarunkowy reset gospodarstwa jak trips/meals (bo
  Zdrowie ma rekordy prywatne). Trzy niezależne `DELETE` (kolejność dowolna — brak FK między tabelami):
  `DELETE health_appointments`, `DELETE medications`, `DELETE health_measurements`, każdy z filtrem
  `household OR owner=user`. Prywatne rekordy innych domowników **zostają**.

Reużycie (wszystko już istnieje w `server.mjs`): `requireHousehold`, `transaction()`, `httpError`, cap
batcha (`MAX_HEALTH_MUTATIONS_PER_BATCH`/`_BYTES` na wzór `MAX_PETS_MUTATIONS_*`), sekwencyjne
przetwarzanie mutacji, `session.user_id` w scope'ie. Nagłówki bezpieczeństwa/CSRF działają automatycznie
dla nowych tras.

### Backend — `server/src/health.mjs` (wzór 1:1 z `server/src/pets.mjs`)

Czyste, testowalne funkcje: walidatory payloadów per `op` (`validateAppointmentCreatePayload`,
`validateAppointmentUpdatePayload`, `validateMedicationCreatePayload`, `validateMedicationUpdatePayload`,
`validateMeasurementCreatePayload`, `validateMeasurementUpdatePayload`, `validateDeleteIdPayload`),
`resolveOwnerId`, `resolveVersionConflict`, `normalizeRequiredVersion`/`normalizeOptionalVersion`,
`normalizeOptionalText`, mapery wiersz→DTO (`appointmentRowToDto`/`medicationRowToDto`/
`measurementRowToDto`), `readHealthSnapshot(client, householdId, userId)`,
`applyHealthMutation(client, ctx, mutation)`, `resetHealthForUser(client, householdId, userId)`,
`SUPPORTED_HEALTH_OPS`, `assertHealthMutationShape`, `MAX_HEALTH_MUTATIONS_*`. Reużywa wzorca
`resolveConflictOrError`/`resolveConflictOrGone` (skopiowane z `pets.mjs`), `query`/`transaction`
z `db.mjs`, prymitywów `isPlainObject`/`isId`/`isNonEmptyText`/`isOptionalText`/`isIsoDate`/`isClockTime`/
`VISIBILITIES`/`UUID_PATTERN` (wzór z `pets.mjs`). **Bez importu z `src/`** (serwer nie ma builda TS/zod;
walidatory ręczne odzwierciedlają `healthAppointmentSchema`/`medicationSchema`/`healthMeasurementSchema`
z `src/lib/schema.ts` + nowe `version`). **Bez** `cascadePetVisibility`, **bez** `resolve*Visibility`
(dziedziczenia po rodzicu), **bez** sprawdzania istnienia rodzica przy create — te nie mają odpowiednika
w płaskim Zdrowiu.

Nowy prymityw względem `pets.mjs`: walidator `measuredAt` jako free-form timestamp — `isParsableTimestamp`
(`typeof value === "string" && !Number.isNaN(Date.parse(value))`, cap długości, wzór `timestamp`
z `schema.ts`), **nie** `isIsoDate`. Zapisywany do `text` bez rzutowania.

### Frontend — dedykowany store + silnik sync (offline-first)

- **`src/store/useHealthStore.ts` (nowy)** — wzór 1:1 z `src/store/usePetsStore.ts`/`useCarStore.ts`:
  Zustand + `persist` (klucz `puls-health`), `safeLocalStorage`, `parseArrayField`, `merge` z guardem
  `persistedState === undefined` (unikamy fałszywego „niezgodny format" na czystej instalacji — luka #3
  ze „Status po wdrożeniu" Finansów, już poprawiona w `useCarStore.ts`). Trzyma `healthAppointments/
  medications/healthMeasurements` (każdy z `version`) + `pendingMutations[]` + `serverAt`/`hydrated`.
  Akcje **zachowują nazwy i sygnatury** dzisiejszych z `useAdvancedStore`, żeby diff w `HealthPage`/
  `TodayPage`/`CommandPalette` był minimalny: `addHealthAppointment`, `updateHealthAppointment`,
  `deleteHealthAppointment`, `addMedication`, `updateMedication`, `deleteMedication`,
  `toggleMedicationTaken`, `toggleMedicationActive`, `addHealthMeasurement`, `updateHealthMeasurement`,
  `deleteHealthMeasurement` — **oraz** `hydrateFromSnapshot`, `applyMutationResults`, `resetHealthData`
  (wzór `usePetsStore`). Każda akcja: optymistyczna zmiana lokalna → `idempotencyKey =
  crypto.randomUUID()` (`generateId()`) → mutacja do `pendingMutations` z aktualnym `baseVersion` rekordu
  → flush. **Toggle-e liczą nowy stan lokalnie z bieżącego rekordu** (jak `togglePetVisitCompleted`):
  `toggleMedicationTaken(id, date)` → `medication.update { changes: { lastTakenOn: current === date ?
  null : date } }`; `toggleMedicationActive(id)` → `medication.update { changes: { active: !current } }`;
  „oznacz odbytą" (wizyta) w `HealthPage` woła istniejące `updateHealthAppointment(id, { status })`.
  `*.update` podlega cichemu rebase'owi przy konflikcie (wzór `isUpdateOp`/`upsertByUpdateOp` w
  `useCarStore.ts`) — reaplikuje deltę (`{ status }`/`{ active }`/`{ lastTakenOn }`/…) na świeży rekord.
- **`src/hooks/useHealthSync.ts` + `src/server/HealthSync.tsx` (nowe)** — wzór 1:1 z `usePetsSync.ts` /
  `PetsSync.tsx` (te z kolei kopiami `useCarSync.ts`/`CarSync.tsx`): montaż → `GET /api/v1/health`
  (hydratacja) → drenaż kolejki przez `POST /api/v1/health/mutations`; obsługa `applied`/`duplicate`/
  `conflict`/`error`; `MAX_FLUSH_ROUNDS`; nasłuch `online`/`focus`/`visibilitychange`; nieblokujący
  provider z własnym `sync-indicator` (`sync-indicator--health`, etykiety „Zapisuję zdrowie" / „Zdrowie
  czeka na sieć" / „Zdrowie zsynchronizowane"). Reużywa `apiRequest`/`ApiError` z `src/server/api.ts`.
- **Montaż**: w `src/server/AuthGate.tsx` (`:362-367`) zagnieżdżony wewnątrz `<PetsSync>` (ten sam
  `key`/`onSessionExpired`): `…<PetsSync><HealthSync …>{children}</HealthSync></PetsSync>…`. Dorzuć
  `useHealthStore` do importów (`:25`), do `bindLocalStorageTo`/`clearLocalUserData` (reset
  `resetHealthData()` + `safeRemoveStorageItem("puls-health")`, `:76-104`) i do `hasUnsyncedChanges`
  (`useHealthStore.getState().pendingMutations.length > 0`, `:117-122`).

### Worker — DWA reminery zdrowia z SQL, z targetowaniem per widoczność

`server/src/worker.mjs` czyta dziś oba reminery zdrowia z dokumentu JSONB wewnątrz `derivedReminders`:
- **wizyta** (`:170-186`): push „Nadchodzi wizyta: &lt;tytuł&gt;" 24 h przed `date`+`time`
  (`status='scheduled'`, okno 2 dni, id `health-appointment:<id>`);
- **lek** (`:187-204`): push „Pora przyjąć: &lt;name&gt; &lt;dosage&gt;" codziennie o `reminderTime`,
  gdy `active && lastTakenOn !== today && `${today} ${reminderTime}` <= nowKey` (id `medication:<id>`).

`deliverDerived` jest dziś wołane dla dokumentu wspólnego (wszyscy domownicy) **i** per prywatny dokument
(`targetUserId`) — co naturalnie targetuje rekordy prywatne tylko do właściciela. Po migracji odtwarzamy
to samo targetowanie odczytem z SQL — **dokładnie jak `petVisitReminders`/`carDeadlineReminders`**
(`worker.mjs:273-296`), z `visibility`/`owner_id` per wiersz, bez joina (Zdrowie nie ma rodzica):

- Nowa `healthAppointmentReminders(householdId, nowKey)`:
  `SELECT id, title, date::text AS date, time, visibility, owner_id FROM health_appointments
   WHERE household_id = $1 AND status = 'scheduled'`.
  Dla każdego wiersza: `dueKey = shiftLocalDateTime(date, time, -24*60)`; jeśli
  `withinDeliveryWindow(dueKey, nowKey, 2)` — `{ reminder: { id: "health-appointment:<id>", title:
  "Nadchodzi wizyta: <title>", date, time }, targetUserId: visibility === 'private' ? owner_id : null }`.
- Nowa `medicationReminders(householdId, nowKey)`:
  `SELECT id, name, dosage, reminder_time, last_taken_on::text AS last_taken_on, visibility, owner_id
   FROM medications WHERE household_id = $1 AND active = true AND reminder_time IS NOT NULL`.
  `today = nowKey.slice(0,10)`; dla każdego wiersza, gdy `last_taken_on IS DISTINCT FROM today`,
  `/^\d{2}:\d{2}$/.test(reminder_time)` i `` `${today} ${reminder_time}` <= nowKey `` — `{ reminder:
  { id: "medication:<id>", title: "Pora przyjąć: <name> <dosage>", date: today, time: reminder_time },
  targetUserId: visibility === 'private' ? owner_id : null }`. **Uwaga:** `date: today` zachowuje dzienny
  klucz dedup `occurrence` (`today T reminderTime`) 1:1 — powiadomienie raz na dobę, jak dziś. Filtr
  `last_taken_on != today` można zrobić w SQL (`WHERE (last_taken_on IS NULL OR last_taken_on <> $today)`)
  lub w JS — obojętne, byle wynik był identyczny z dzisiejszym.
- W głównej pętli (`worker.mjs:366-379`, obok `petVisitReminders`): dla każdego wpisu z obu funkcji
  `deliverReminder(workspace, reminder, targetUserId)` — `null` = wszyscy domownicy, `owner_id` = tylko
  właściciel prywatnego rekordu.
- **Usuń** obie pętle zdrowia z `derivedReminders` (`worker.mjs:170-204`) — nie ma już tam wizyt ani
  leków (zostają tam tylko `events` i `subscriptions`).
- Dorzuć prune retencji obok istniejących (`worker.mjs:328`):
  `DELETE FROM health_mutations WHERE created_at < now() - interval '30 days'`.
- **Prefiksy `health-appointment:` i `medication:` zachowane 1:1** — dedup w `notification_deliveries`
  niezmieniony.

### Migracja danych historycznych (`011_health_normalized.sql`)

Wzór 1:1 z `010_pets_normalized.sql` (defensywność wobec `NULL`/nieobecnych kolekcji, `ON CONFLICT (id)
DO NOTHING`, idempotentne; `owner_id` prywatnych z **kolumny `user_id` wiersza `user_workspace_states`**,
nigdy z JSON), ale **prościej — bez guardów sierot** (kolekcje niezależne, brak FK między nimi):

1. `CREATE TABLE IF NOT EXISTS` dla czterech tabel + indeksy.
2. **Wizyty wspólne**: `jsonb_array_elements(ws.data->'advanced'->'healthAppointments')` →
   `health_appointments` (`household_id = ws.household_id`, `owner_id = COALESCE(hm.user_id,
   h.created_by)` z `LEFT JOIN household_members hm ON hm.user_id::text = rec->>'ownerId'`, `visibility`
   z clampem do `household`/`private`, `date = (rec->>'date')::date`, `time = COALESCE(NULLIF(rec->>
   'time',''),'00:00')`, `status` z clampem — fallback `scheduled`, pola opcjonalne przez `NULLIF(...,'')`).
   Wzór: „Wizyty: wspólne" w `010`.
3. **Wizyty prywatne**: `jsonb_array_elements(uws.data->'advanced'->'healthAppointments')` z
   `household_id = uws.household_id`, `owner_id = uws.user_id`, `visibility='private'`. **Bez ujawnienia.**
4. **Leki** (`medications`) wspólne + prywatne: `active = COALESCE((rec->>'active')::boolean, true)`,
   `schedule = COALESCE(NULLIF(rec->>'schedule',''),'Codziennie')`, `last_taken_on = NULLIF(rec->>
   'lastTakenOn','')::date`, `reminder_time = NULLIF(rec->>'reminderTime','')`, `name`/`dosage` z
   fallbackiem non-empty.
5. **Pomiary** (`healthMeasurements`) wspólne + prywatne: `type` z clampem (fallback `other`),
   `value = COALESCE(NULLIF(rec->>'value',''),'—')`, `unit = COALESCE(rec->>'unit','')`,
   `measured_at = COALESCE(NULLIF(rec->>'measuredAt',''), to_char(now(),'YYYY-MM-DD"T"HH24:MI'))`
   (**text 1:1**, bez rzutowania na timestamp), `notes` opcjonalne.
6. **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data #- '{advanced,healthAppointments}'
   #- '{advanced,medications}' #- '{advanced,healthMeasurements}', revision = revision + 1
   WHERE data->'advanced' ?| array['healthAppointments','medications','healthMeasurements']` oraz
   analogicznie `user_workspace_states` (`updated_at = now()`; ta tabela nie ma `revision`). Bump
   `revision` wymusza czysty refetch u klientów (wzór `010`).

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/011_health_normalized.sql` (**nowy**) — kolejny numer po `010_pets_normalized.sql`.
  `CREATE TABLE` czterech tabel + indeksy + migracja danych (wspólne + prywatne, **bez** guardów sierot,
  `measuredAt` jako `text`) + wycięcie z JSONB. Wzorzec: `server/migrations/010_pets_normalized.sql`.
- `src/healthTypes.ts` (**nowy**) — przenieś `HealthAppointment`, `Medication`, `HealthMeasurement`,
  `HealthMeasurementType` z `src/advancedTypes.ts` (`:45-77`); **dodaj `version: number` i
  `updatedAt: string`** do wszystkich trzech. Nadal rozszerzają `SharedMeta` (zachowują
  `ownerId`/`visibility` — jak `petsTypes.ts`). Wspólne źródło prawdy backend/frontend (wzór
  `src/petsTypes.ts`).
- `src/advancedTypes.ts` — usuń `HealthAppointment`/`Medication`/`HealthMeasurement`/
  `HealthMeasurementType` (`:45-77`) i pola `healthAppointments`/`medications`/`healthMeasurements`
  z interfejsu `AdvancedData` (`:88-91`); dodaj re-eksport `export type { HealthAppointment, Medication,
  HealthMeasurement, HealthMeasurementType } from "./healthTypes"` (wzór linii `:28` dla petsTypes).
  Uprość alias `AdvancedDataWithHealth = AdvancedData` (`:97`) — po wycięciu Zdrowia nazwa jest myląca;
  można zostawić alias albo zamienić użycia na `AdvancedData` (`advancedData.ts:2,12`,
  `useAdvancedStore.ts:250`).
- `src/lib/schema.ts` — usuń `healthAppointments`/`medications`/`healthMeasurements` z
  `advancedDataSchema` (`:471-473`); przebuduj `healthAppointmentSchema`/`medicationSchema`/
  `healthMeasurementSchema` (`:431-458`) — **zachowaj `sharedMetaSchema`**, dodaj `version: recordVersion`
  + `updatedAt: timestamp` — do walidacji snapshotu i persystencji nowego store'u (wzór:
  `petVisitSchema`/`medicationSchema` z `version`). Zaktualizuj import typów (dodaj `HealthAppointment`/
  `Medication`/`HealthMeasurement` z `./healthTypes`, jeśli anotowane `z.ZodType<…>`). **Uwaga na
  `backupEnvelopeV2Schema`** (`:479-488`): używa `advancedDataSchema` — po wycięciu Zdrowia backupy
  przestają zawierać Zdrowie (parytet z Finansami/Autem/Zwierzętami, które już wypadły z tego schematu).

### Backend (warstwa backend)

- `server/src/health.mjs` (**nowy**) — analogicznie do `server/src/pets.mjs`: walidatory payloadów per
  `op`, `resolveOwnerId`, `resolveVersionConflict`, `normalizeRequired/OptionalVersion`,
  `isParsableTimestamp` (nowy — dla `measuredAt`), mapery wiersz→DTO, `readHealthSnapshot`,
  `applyHealthMutation`, `resetHealthForUser`, `SUPPORTED_HEALTH_OPS`, `assertHealthMutationShape`,
  `MAX_HEALTH_MUTATIONS_*`. Reużywa wzorca `resolveConflictOrError`/`resolveConflictOrGone`/
  `resolveOwnerId` (skopiowane z `pets.mjs`), `query`/`transaction` z `db.mjs`. **Bez importu z `src/`**.
  **Bez** `cascadePetVisibility`/`resolve*Visibility`/sprawdzania rodzica przy create.
- `server/src/server.mjs` — dodaj importy z `./health.mjs` (obok `./pets.mjs`, `:43-50`); dodaj
  `GET /api/v1/health`, `POST /api/v1/health/mutations`, `POST /api/v1/health/reset` (kopiuj strukturę
  bloków pets `:879-926` — używają `session.user_id` w scope'ie; te same reużycia `requireHousehold`/
  `transaction`/`httpError`/cap batcha).
- `server/src/workspace.mjs` — usuń `"healthAppointments"`/`"medications"`/`"healthMeasurements"`
  z `META_COLLECTIONS` (`:8-13`, zostanie `["subscriptions"]`) i z `ADVANCED_COLLECTIONS` (`:23-29`,
  zostanie `["subscriptions","householdMembers"]`) — to automatycznie wyłącza je z `splitWorkspaceData`/
  `mergeWorkspaceData` i `workspaceDocumentIsValid`. `CHILD_RELATIONS` jest już pusty `{}` (od migracji
  Zwierząt) — bez zmian. Zaktualizuj komentarz nagłówka pliku (`:1-7`), dopisując Zdrowie do listy
  modułów wyciętych z JSONB.
- `server/src/worker.mjs` — dodaj `healthAppointmentReminders(householdId, nowKey)` i
  `medicationReminders(householdId, nowKey)` (odczyt z SQL, bez joina, z `visibility`/`owner_id` i
  godziną z kolumny; lek z `date: today` i dziennym filtrem `lastTakenOn != today`) i wywołuj obie
  w głównej pętli obok `petVisitReminders` (`:366-379`) z targetowaniem `deliverReminder(workspace,
  reminder, targetUserId)`; usuń obie pętle zdrowia z `derivedReminders` (`:170-204`); dodaj prune
  `health_mutations` (`:328`).

### Frontend (warstwa frontend)

- `src/store/useHealthStore.ts` (**nowy**) — dedykowany store z optymistycznymi mutacjami, kolejką
  `pendingMutations`, `version` per rekord, cichym rebase'em `*.update`. Wzór: `usePetsStore.ts`/
  `useCarStore.ts`. Reużyj `parseArrayField`/`safeLocalStorage`/`quarantineRawValue`/
  `reportStorageWarning` (z `lib/safeStorage`) i `generateId` (z `lib/id`).
- `src/hooks/useHealthSync.ts` + `src/server/HealthSync.tsx` (**nowe**) — silnik sync + nieblokujący
  provider. Wzór: `usePetsSync.ts` / `PetsSync.tsx` (+ `apiRequest`/`ApiError` z `src/server/api.ts`).
- `src/store/useAdvancedStore.ts` — usuń stan `healthAppointments/medications/healthMeasurements` (import
  typów `:16-23`, schematów `:8-15`), akcje `addHealthAppointment`/`updateHealthAppointment`/
  `deleteHealthAppointment`/`addMedication`/`updateMedication`/`deleteMedication`/`toggleMedicationTaken`/
  `toggleMedicationActive`/`addHealthMeasurement`/`updateHealthMeasurement`/`deleteHealthMeasurement`
  (interfejs `:55-65`, impl `:94-162`), z `replaceAdvancedData` (`:163-169`), `merge`
  (`:186-235`), `partialize` (`:237-245`) i `exportAdvancedData` (`:250-261`). Po wycięciu store trzyma
  już tylko `subscriptions` + `householdMembers`/`householdName`/`hideAmounts`.
- `src/pages/HealthPage.tsx` — podmień importy akcji i selektorów z `useAdvancedStore` na `useHealthStore`
  (nazwy zachowane → diff minimalny, `:108-121`). `currentOwnerId` (`:107`) dalej z `useServerAuth`.
  **Bez zmian w JSX/layoutcie/modalach** (w tym `toggleAppointmentCompleted`, `toggleMedicationTaken`,
  `toggleMedicationActive`, `measuredAt` budowany jako `` `${date}T${time}` ``).
- `src/pages/TodayPage.tsx` — podmień `healthAppointments` (`:107`) i `medications` (`:108`)
  z `useAdvancedStore` na `useHealthStore`; `nextHealthAppointment` (`:210-`), `activeMedications`/
  `medicationsTakenToday` (`:213-`) i kafelek „Zdrowie" (`:593-604`) bez zmian logiki. `hideAmounts`
  (`:109`) i `subscriptions` (`:103`) zostają w `useAdvancedStore`. UX niezmieniony.
- `src/components/CommandPalette.tsx` — podmień `healthAppointments` (`:124`) i `medications` (`:125`)
  z `useAdvancedStore` na `useHealthStore`; wpis nawigacyjny (`:101`), wyniki wyszukiwania (`:276-`) i
  zależności `useMemo` (`:305-306`) bez zmian.
- `src/server/WorkspaceSync.tsx` — usuń `healthAppointments`/`medications`/`healthMeasurements`
  z `replaceWithEmptyWorkspace` (`:49-51`).
- `src/server/AuthGate.tsx` — zamontuj `<HealthSync>` wewnątrz `<PetsSync>` (`:362-367`); dodaj import
  `useHealthStore` (`:25`), reset w `bindLocalStorageTo`/`clearLocalUserData` (`:76-104`) +
  `safeRemoveStorageItem("puls-health")`, oraz `useHealthStore().pendingMutations` w `hasUnsyncedChanges`
  (`:117-122`).
- `src/pages/SettingsPage.tsx` — w „Wyczyść dane aplikacji" dodaj
  `await apiRequest("/api/v1/health/reset", { method: "POST", json: {} })` obok pets/car/finance/trips/
  meals (`:186`) i `resetHealthData()` obok `resetPetsData()` (`:221`); usuń `healthAppointments`/
  `medications`/`healthMeasurements` z lokalnego `replaceAdvancedData` (`:213-215`). Dodaj import
  `useHealthStore` (obok `usePetsStore` `:31`).
- `src/data/advancedData.ts` — usuń seed `healthAppointments`/`medications`/`healthMeasurements`
  z `createAdvancedData()` (`:98-169`); serwer jest źródłem prawdy (domyślny stan offline = pusty),
  analogicznie do wycięcia seedu car/pets. Zostawia seed `subscriptions`/`householdMembers`/
  `householdName`/`hideAmounts`.

### Nawigacja/routing — BEZ zmian

`src/types.ts` (`ViewId` z `"health"`), `src/components/Layout.tsx` (wpis `navigation` + `titles`),
`src/App.tsx` (`lazy` import + `viewIds` + render `HealthPage`) — **nie ruszamy**, trasa/zakładka
„Zdrowie" zostaje. Zmienia się wyłącznie warstwa danych pod stroną.

### Testy (aktualizacja + nowe)

- Aktualizacja: `src/store/useAdvancedStore.test.ts` (usuń przypadki Health CRUD i toggli — wyszukać
  `Health`/`Medication`), `src/server/workspaceMerge.test.ts`/`WorkspaceSync.test.tsx`,
  `src/lib/schema.test.ts` (jeśli waliduje `advancedData` ze Zdrowiem), `src/App.test.tsx`,
  `server/test/workspace.node.mjs` (bez healthAppointments/medications/healthMeasurements w split/merge
  i `workspaceDocumentIsValid`; `META_COLLECTIONS` = tylko `subscriptions`).
- Nowe: `src/store/useHealthStore.test.ts` (optymistyczne mutacje, wersje, kolejka, **toggle-e liczą
  stan lokalnie i nie dublują się przy retry z tym samym kluczem** — `lastTakenOn` prawdziwy toggle,
  `active`, status wizyty; prywatność w payloadzie; idempotencja; `conflict` per rekord z cichym
  rebase'em); `server/test/health.node.mjs` (walidatory w tym `isParsableTimestamp` dla `measuredAt`,
  `resolveVersionConflict`, `owner_id` z sesji niezależnie od payloadu, scope widoczności w konfliktach,
  idempotencja retry, reset per-user nie rusza prywatnych innych domowników, oba pushe zdrowia targetowane
  per widoczność — wizyta -24 h i lek dzienny o `reminderTime`).

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do Zdrowia
      w `AdvancedData`/`advancedDataSchema`/`useAdvancedStore`/`WorkspaceSync`.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane testy generyczne bez Zdrowia; nowy
      `useHealthStore.test.ts` (optymistyczne mutacje, wersje, kolejka, toggle-e liczone lokalnie,
      idempotencja: retry z tym samym kluczem nie dubluje toggle; `conflict` per rekord).
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (bez Zdrowia
      w split/merge i `workspaceDocumentIsValid`); nowy `server/test/health.node.mjs` (opis wyżej).
- [ ] Migracja `011` na bazie z istniejącym Zdrowiem w JSONB (w tym prywatnymi wizytami/lekami/
      pomiarami): rekordy trafiają do tabel z zachowanym `id`/`ownerId`/`visibility`/znacznikami czasu,
      `measuredAt` zachowany 1:1 jako tekst, `lastTakenOn`/`reminderTime` zachowane, `data->'advanced'`
      nie zawiera już kolekcji Zdrowia, dwukrotne uruchomienie nie duplikuje, prywatne pozostają
      prywatne (nie ujawnione).
- [ ] `npm run preview` (także wąski ekran, PWA): dodanie/edycja/oznaczenie-odbytą/usunięcie wizyty;
      dodanie/edycja/„oznacz przyjęte"/„wstrzymaj"/usunięcie leku (w tym godzina przypomnienia);
      dodanie/edycja/usunięcie pomiaru (w tym ciśnienie „120/80" i data+godzina `measuredAt`); przełącznik
      „Tylko ja/Domownicy" na każdym z trzech; kafelek „Zdrowie" na „Dzisiaj"; wyszukiwarka (Command
      Palette) — działają identycznie jak przed zmianą.
- [ ] „Oznacz przyjęte" jest prawdziwym togglem 1:1: drugie kliknięcie tego samego dnia czyści
      `lastTakenOn`; offline dwa kliknięcia netto dają poprawny stan; retry tej samej kolejki nie
      przekręca stanu.
- [ ] Offline → online: mutacje bez sieci kolejkują się i zapisują po powrocie; retry tej samej kolejki
      nie tworzy duplikatów.
- [ ] Dwa „urządzenia": równoległa edycja **różnych** rekordów przechodzi bez konfliktu; równoległa
      edycja **tego samego** rekordu ze starą wersją zwraca konflikt tylko dla niego (cichy rebase),
      reszta batcha przechodzi.
- [ ] Worker wysyła push z nowych tabel: „Nadchodzi wizyta: &lt;tytuł&gt;" (24 h przed,
      `status='scheduled'`) oraz „Pora przyjąć: &lt;name&gt; &lt;dosage&gt;" (codziennie o `reminderTime`,
      `active && lastTakenOn != today`) — dla rekordu wspólnego do wszystkich domowników, dla prywatnego
      tylko do właściciela; prefiksy `health-appointment:` i `medication:` niezmienione (brak kolizji
      dedup, jedno powiadomienie leku na dobę).
- [ ] Po wdrożeniu: aktualizacja tabeli priorytetów w `docs/DATA_MODEL_MIGRATION.md` — wiersz „Zdrowie
      (Health)" status „Zaplanowane po Pets" → „✅ Zrobione (PR #NN)" z faktycznym numerem PR; ewentualna
      sekcja „Status po wdrożeniu" z lukami znalezionymi w E2E (jak w planach Finansów/Auta).

## Ryzyka

- **Regresja obu pushów zdrowia.** Wycięcie Zdrowia z JSONB **psuje** oba reminery, jeśli nie
  zaktualizujemy `worker.mjs`. Rekordy mają widoczność — błędne targetowanie ujawniłoby prywatną wizytę/
  lek całemu gospodarstwu. Szczególna pułapka przy leku: `date: today` musi zostać, by dzienny klucz
  dedup (`occurrence = today T reminderTime`) był identyczny i lek nie przychodził wielokrotnie ani nie
  gubił się. Prefiksy `health-appointment:`/`medication:` muszą zostać 1:1. Pokryć weryfikacją audytorium
  (wszyscy vs właściciel) i częstotliwości.
- **`measuredAt` jako `timestamptz` zamiast `text` = cicha korupcja danych.** To free-form string
  `` `${date}T${time}` `` bez strefy/sekund, czytany przez `split("T")` i `parseISO`. Rzutowanie na
  `timestamptz` przesunęłoby wartość strefowo i dodało `Z`/sekundy, łamiąc UI. **Musi** być `text` w
  tabeli i w migracji (bez `::timestamptz`). Pokryć testem round-trip snapshotu.
- **`toggleMedicationTaken` to prawdziwy toggle, nie idempotentny set.** Model 1:1 wymaga liczenia
  nowego `lastTakenOn` lokalnie z bieżącego rekordu i wysyłania przez `medication.update`. Idempotencja
  klucza chroni retry przed podwójnym flipnięciem (retry zwraca zapisany `result`). Cichy rebase konfliktu
  musi reaplikować deltę `{ lastTakenOn }` na świeży rekord, nie ponawiać toggle od nowej bazy „na ślepo".
  Pokryć testem store'u (retry nie przekręca) i serwera (idempotencja).
- **`visibility` edytowalne w UI (klasa regresji „goal visibility" z Finansów).** `HealthPage` pozwala
  dziś zmienić `visibility` wizyty (`updateHealthAppointment`), leku (`updateMedication`) i pomiaru
  (`updateHealthMeasurement`) po utworzeniu. Jeśli pominiemy `visibility` w `*_UPDATE_KEYS`, to **regresja**
  (dokładnie luka #1 ze „Status po wdrożeniu" Finansów). Plan **włącza** `visibility` do kluczy edycji
  wszystkich trzech. **W odróżnieniu od Zwierząt brak kaskady** — Zdrowie nie ma dzieci, więc zmiana
  widoczności dotyka tylko własnego wiersza (prostsze, żaden `cascadePetVisibility`).
- **Prywatność w konfliktach i snapshotcie.** Zapytania diagnostyczne konfliktów muszą nieść ten sam
  filtr `(visibility='household' OR owner_id=$user)` co write (inaczej wyciek prywatnego rekordu w
  odpowiedzi konfliktu). **Brak** wariantu `EXISTS`/kaskady — łatwo skopiować z `pets.mjs` niepotrzebny
  kod rodzica/dziecka; Zdrowie jest płaskie, każdy rekord filtruje po swoim wierszu.
- **`reset` per-user, nie bezwarunkowy.** Zdrowie ma dużo rekordów prywatnych — `resetHealthForUser`
  kasuje wspólne + wyłącznie prywatne wywołującego (wzór `resetPetsForUser`). Skopiowanie z
  `resetTripsForHousehold` nuknęłoby prywatne rekordy innych domowników.
- **Backup/restore v2 przestaje zawierać Zdrowie.** Usunięcie Zdrowia z `advancedDataSchema` sprawia, że
  `backupEnvelopeV2Schema` (i import w `SettingsPage`) nie odtwarza już Zdrowia do SQL ze starego backupu
  — parytet z Finansami/Autem/Zwierzętami (które już wypadły). Świadome; do odnotowania, nie do naprawy
  w tym PR.
- **Duży blast radius wycięcia** (`workspace.mjs`, `advancedTypes.ts`, `schema.ts`, `useAdvancedStore.ts`,
  `WorkspaceSync.tsx`, `advancedData.ts`, `AuthGate.tsx`, `SettingsPage.tsx`, `TodayPage.tsx`,
  `CommandPalette.tsx`, `worker.mjs` + testy) — łapane przez `tsc` (strict) i testy; robić atomowo
  dane → backend → frontend (`implement-layered`).
- **Spójność sync z resztą modułów.** Usunięcie Zdrowia z `ADVANCED_COLLECTIONS`/`workspaceDocumentIsValid`
  musi być zsynchronizowane z klientem (schemat + `replaceWithEmptyWorkspace`), inaczej `PUT
  /api/v1/workspace` zwróci `400 INVALID_WORKSPACE_SCHEMA`. Bump `revision` w migracji wymusza czysty
  refetch. Reszta modułów (Subskrypcje/Life) zostaje nietknięta w tym samym dokumencie.
- **Kolejność drenażu offline.** Mutacje Zdrowia są niezależne (brak zależności rodzic→dziecko), ale
  wciąż wysyłamy batch uporządkowany i przetwarzamy sekwencyjnie (parytet z resztą) — istotne dla
  poprawnego liczenia toggli `lastTakenOn`/`active`/`status` w kolejności działań użytkownika.

## Pytania do doprecyzowania

Wszystko rozstrzygnięte w prompcie/ustaleniach z użytkownikiem i przez parytet ze Zwierzętami — brak
genuine otwartych pytań. Kluczowe decyzje, które mogłyby wyglądać na otwarte, są **rozstrzygnięte**:

- **Zakres: 3 kolekcje razem, jeden PR** — mimo braku relacji rodzic/dziecko migrują się jako jeden
  bounded context „Zdrowie" (wiersz #5 tracker'a). Rozstrzygnięte.
- **`medication.lastTakenOn`: jedno pole, OCC przez `version`, prawdziwy toggle liczony lokalnie i
  wysyłany przez `medication.update`.** Tabela historii (`medication_intake_log`) świadomie odrzucona
  (YAGNI). Rozstrzygnięte.
- **`healthMeasurement.measuredAt`: kolumna `text`** (nie `timestamptz`) — wymóg migracji 1:1 dla
  free-form timestampu; `timestamptz` mutowałby wartość. Rozstrzygnięte (nie otwarte — wynika wprost
  z mandatu 1:1).
- **`visibility` w kluczach edycji wszystkich trzech kolekcji, bez kaskady** (brak dzieci).
  Rozstrzygnięte.
