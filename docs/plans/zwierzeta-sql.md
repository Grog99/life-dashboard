# Migracja modułu Zwierzęta (Pets) na znormalizowany model SQL

> Plan wygenerowany przez skill `/plan-feature`. Slug: `zwierzeta-sql`. Branch: `feature/zwierzeta-sql`.
>
> Kontynuacja serii migracji z `docs/DATA_MODEL_MIGRATION.md` (moduł #4). **To CZWARTA migracja wg tego
> samego wzorca** — pilot Finansów (PR #11) ustalił kształt, po nim Podróże (PR #13), Lista zakupów/Meals
> (PR #14) i Auto/Car (PR #15).
>
> **Świadoma decyzja, nie odkrycie luki.** Zwierzęta **nie mają** dowodu (a) (pole agregujące
> read-modify-write) ani (b) (realna częsta kolizja edycji) z `docs/DATA_MODEL_MIGRATION.md` (kolekcje
> płaskie, niska częstotliwość edycji). Migrujemy je **wyłącznie** z decyzji użytkownika z 17.07.2026
> o ujednoliceniu architektury (wszystkie moduły → SQL), jawnie uchylając YAGNI z punktu 4 „Zasad
> kontynuacji". To nota, nie uzasadnienie techniczne — nie wymyślamy sztucznego (a)/(b).
>
> **Wzorce referencyjne — cztery zmergowane migracje:**
> - **Auto/Car (PR #15, NAJBLIŻSZY analog)**: `docs/plans/auto-car.md`, `server/src/car.mjs`,
>   `server/migrations/009_car_normalized.sql`, `src/carTypes.ts`, `src/store/useCarStore.ts`,
>   `src/hooks/useCarSync.ts`, `src/server/CarSync.tsx`, `server/test/car.node.mjs`. Car też ma rodzica
>   (`vehicles`≈`pets`) + kolekcje potomne, **zachowuje** rozróżnienie prywatne/wspólne, i ma worker
>   push targetowany per widoczność. **Prawie wszystko przenosi się 1:1.**
> - **Finanse (PR #11, model warstwy prywatne/wspólne)**: `docs/plans/model-synchronizacji-danych.md`,
>   `server/src/finance.mjs` (`resolveOwnerId`, `resolveTransactionVisibility`, `resetFinanceForUser`).
> - **Podróże (PR #13, wzór na zagnieżdżoną tablicę w JSONB kolumnie)**: `Trip.travelers` →
>   `trips.travelers jsonb` (`src/tripsTypes.ts:23`, `server/src/trips.mjs:171,297,837`,
>   `server/migrations/007_trips_normalized.sql:21,127`). **To wzorzec dla `fishStock`.**

## Kontekst / Problem

Moduł Zwierzęta to dziś fragment dokumentu JSONB (`workspace_states` / `user_workspace_states`),
synchronizowany generycznym mechanizmem `PUT /api/v1/workspace` (globalna rewizja + 3-way merge po `id`,
patrz `server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`). Kolekcje: `pets` (rodzic) oraz
`petExpenses`, `petVisits` (dzieci przez `petId` — patrz `CHILD_RELATIONS` w `server/src/workspace.mjs:16-19`).
Zbudował go plan `docs/plans/zwierzeta-wydatki-wet.md`, który **świadomie odrzucił** wtedy alternatywę
„znormalizowane tabele SQL" jako nadmiarową dla MVP (słuszna decyzja w tamtym kontekście).

Teraz — z decyzji użytkownika o ujednoliceniu architektury (`docs/DATA_MODEL_MIGRATION.md`, aktualizacja
17.07.2026) — robimy dokładnie to, co tam odrzucono. Zwierzęta są ostatnim modułem „advanced" z rodzicem +
dziećmi, który wciąż siedzi w JSONB; po ich wycięciu dokument `advanced` zostaje tylko z Subskrypcjami,
Zdrowiem i metadanymi gospodarstwa.

Efekt docelowy: Zwierzęta przestają być częścią dokumentu JSONB. Dostają znormalizowane tabele SQL,
mutacje domenowe z kluczami idempotencji generowanymi po stronie klienta i optymistyczną kontrolę
współbieżności per rekord (kolumna `version`). Zachowujemy rozróżnienie prywatne/wspólne (profil, wydatek
i wizyta mają własną `visibility`; dziecko dziedziczy prywatność po profilu). **UI/UX modułu pozostaje
identyczne** — `src/pages/PetsPage.tsx` zmienia tylko warstwę danych (import akcji ze store), nie layout.

### Czym Zwierzęta są PROSTSZE od Auta (istotne dla nakładu)

Auto niosło trzy komplikacje, których Zwierzęta **nie mają** — to czyni tę migrację ściśle prostszym
podzbiorem `car.mjs`:

1. **Brak pola agregującego / monotonicznego.** Nie ma odpowiednika `Vehicle.mileage` (`balanceMinor`) —
   **żadnej** dedykowanej mutacji `GREATEST` bez OCC, żadnego efektu ubocznego na rodzicu przy tworzeniu
   dziecka. Wszystkie mutacje Zwierząt to zwykłe create / OCC-update / delete.
2. **Brak dzieci auto-generowanych po stabilnym `kind`.** `petVisits` są w całości tworzone przez
   użytkownika — **żadnego** `upsertAutoDeadline`, `kind`, częściowego unikatu `(parent, kind)`, backfillu
   `kind` z `title` w migracji.
3. **Brak dziecka bez własnej widoczności.** W Aucie `vehicle_deadlines` nie miały `owner_id`/`visibility`
   (czysto dziedziczone przez `EXISTS`). W Zwierzętach **oba** dzieci (`petExpenses`, `petVisits`)
   rozszerzają dziś `SharedMeta` i mają własną `visibility` — więc oba modelujemy jak `car_expenses`
   (własne kolumny `owner_id`/`visibility`, filtr scope na własnym wierszu, `resolve*Visibility` dziedziczy
   z profilu tylko przy tworzeniu bez jawnej wartości). Znika cały wariant `EXISTS`-scoping.

Nowe względem Auta jest tylko jedno: **zagnieżdżona tablica `fishStock`** (wariant `kind==='aquarium'`) —
przechowywana jako kolumna JSONB w `pets`, wzorem `Trip.travelers` w `trips`.

## Wymagania

Funkcjonalne:

- Dane Zwierząt (`pets`, `petExpenses`, `petVisits`) w znormalizowanych tabelach SQL, nie w JSONB.
- `Pet.fishStock: {id, species, count}[]` (wariant akwarium) jako **kolumna JSONB w tabeli `pets`** —
  zagnieżdżona, wędruje atomowo z rekordem profilu, **bez** własnej wersji/kolizji (last-write-wins na
  całym profilu przez OCC profilu). Wzór: `Trip.travelers` (`trips.travelers jsonb`).
- Każda mutacja domenowa niesie **klucz idempotencji (UUID) generowany przez klienta**; serwer deduplikuje
  po kluczu (własna tabela `pet_mutations`, retencja 30 dni — **nie** reużywamy `car_mutations` itd.).
- **Optymistyczna współbieżność per rekord** (`version`); konflikt zwracany tylko dla konkretnego rekordu,
  reszta batcha przechodzi. **Wszystkie** update-y używają OCC (brak wyjątku typu `mileage`).
- **Zachowanie prywatności per rekord**: `pets`/`pet_expenses`/`pet_visits` mają `owner_id`/`visibility`
  (jak `finance_accounts`/`car_expenses`); `owner_id` zawsze **z sesji**, nigdy z payloadu. Wydatek/wizyta
  bez jawnej `visibility` dziedziczy ją z profilu-rodzica przy tworzeniu (jak transakcja po koncie).
- Jednorazowa migracja SQL przenosi istniejące dane Zwierząt z JSONB (wspólne z `workspace_states`,
  prywatne z `user_workspace_states`) do nowych tabel z zachowaniem `id`/`ownerId`/`visibility`/znaczników
  czasu i `fishStock`, po czym **całkowicie usuwa** kolekcje Zwierząt z dokumentu JSONB i z generycznego
  sync (bez fallbacku). Rekordy prywatne migrują jako prywatne (bez ujawnienia — jak Auto/Finanse).
- **Powiadomienia push „Wizyta u weterynarza: <tytuł>" (-24 h)** działają dalej — worker czyta wizyty
  z nowej tabeli, z zachowaniem targetowania per widoczność (wspólna → wszyscy domownicy, prywatna →
  tylko właściciel).

Niefunkcjonalne:

- **Offline-first zachowany** — mutacje kolejkują się bez sieci i bezpiecznie odtwarzają (idempotencja),
  optymistyczny UI natychmiast pokazuje zmianę lokalnie.
- Widok Zwierząt wygląda i działa tak samo, także na wąskim ekranie (PWA).
- Reużycie istniejących wzorców backendu i frontendu z Auta/Finansów (patrz „Pliki do zmiany").

## Zakres i Non-goals

**W zakresie:**

- Moduł Zwierzęta jako bounded context: `pets`, `pet_expenses`, `pet_visits` + tabela idempotencji
  `pet_mutations`.
- Nowe endpointy REST `/api/v1/pets` (snapshot), `/api/v1/pets/mutations` (batch), `/api/v1/pets/reset`.
- Nowy store frontendu (`usePetsStore`) + silnik synchronizacji (`usePetsSync` / `PetsSync`).
- `fishStock` jako kolumna JSONB w `pets` (nie osobna tabela dzieci — decyzja użytkownika, wzór `travelers`).
- **Migracja danych historycznych** z JSONB (wspólne + prywatne) do nowych tabel, wycięcie Zwierząt z JSONB.
- Aktualizacja workera (odczyt wizyt z SQL + targetowanie per widoczność profilu wizyty, prune
  `pet_mutations`).
- Wycięcie Zwierząt z `workspace.mjs` (`META_COLLECTIONS`/`CHILD_RELATIONS`/`ADVANCED_COLLECTIONS`),
  `useAdvancedStore`, `WorkspaceSync.tsx`, `advancedDataSchema`, `advancedData.ts`, `AuthGate.tsx`,
  `SettingsPage.tsx`, `TodayPage.tsx`, `CommandPalette.tsx`.

**Non-goals (świadomie pomijamy — dopasowane do Zwierząt):**

- **Ścisła migracja 1:1 — bez nowych funkcji, bez zmiany UX/zachowania.** Endpointy modelują dokładnie
  dzisiejszy zestaw mutacji `PetsPage.tsx`. Żadnych nowych pól ani ekranów. W szczególności **nie ma
  `expense.update`** (UI wydatków tylko dodaje i usuwa — jak w Aucie), więc go nie modelujemy (YAGNI).
- **Żaden inny moduł nie jest ruszany** (Finanse/Podróże/Meals/Auto już zmigrowane; Zdrowie/Subskrypcje/
  Life zostają na JSONB). Nie budujemy generycznej „platformy sync"; **własna** tabela idempotencji
  `pet_mutations`.
- **Zachowujemy prywatność** — `pets`/`pet_expenses`/`pet_visits` z `owner_id`/`visibility`. Migracja
  **nie ujawnia** rekordów prywatnych (różnica względem `007`/`008`, gdzie prywatne migrowały jako wspólne;
  parytet z `009`/Auto).
- **Bez redesignu UI.** Ten sam layout, te same modale, ten sam dolny pasek mobilny, te same nazwy akcji
  store'u (`addPet`/`updatePet`/`deletePet`/`addPetExpense`/`deletePetExpense`/`addPetVisit`/
  `updatePetVisit`/`deletePetVisit`/`togglePetVisitCompleted`) — żeby diff w `PetsPage.tsx` był minimalny.
- **Brak własnej wersji/kolizji dla `fishStock`.** Zagnieżdżona tablica rozstrzyga się last-write-wins na
  całym rekordzie profilu przez OCC profilu (decyzja użytkownika, parytet z `travelers`).

## Podejście

### Decyzje ustalone z góry (twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe podjęto na podstawie ustaleń z użytkownikiem, parytetu
z Autem/Finansami i YAGNI — **rozstrzygnięte, nie otwarte**:

1. **Zakres: cały bounded context Zwierzęta naraz** (jeden plan, jedna migracja SQL, jeden PR): `pets`
   (rodzic) + `petExpenses` + `petVisits` (dzieci przez `petId`).
2. **Migracja: pełna migracja SQL + całkowite zastąpienie** (po migracji Zwierzęta znikają z JSONB, brak
   shimów).
3. **Idempotency keys: klient generuje UUID per mutacja**, osobna tabela `pet_mutations`.
4. **Konflikty: optimistic concurrency per rekord** przez `version` (dla `pet.update`/`visit.update`/
   `*.delete`). **Bez żadnego wyjątku** — brak pola agregującego, więc brak analogu `balanceMinor`/
   `vehicle.mileage`.
5. **Prywatność zachowana** — trzy tabele z `owner_id`/`visibility`; dziecko bez jawnej widoczności
   dziedziczy po profilu przy tworzeniu (`resolveExpenseVisibility`/`resolveVisitVisibility`, wzór
   `resolveTransactionVisibility` z `finance.mjs`).
6. **`fishStock` jako kolumna JSONB w `pets`**, zagnieżdżona atomowo z profilem, bez własnej wersji (wzór
   `Trip.travelers`).

### Model tabel (Postgres) — `server/migrations/010_pets_normalized.sql`

Kolejny numer po `009_car_normalized.sql`. `id` typu `text` (zachowanie legacy `id` 1:1 — `idSchema`
dopuszcza stringi do 200 znaków). `updated_by uuid REFERENCES users(id)` jako lekki audyt. Mapowanie
typów jak w `car.mjs`: `date` przez `::text AS …` (uniknięcie lokalno-strefowego parsowania node-postgres),
`bigint` przez `Number()`, `timestamptz` przez `.toISOString()`, `jsonb` (fishStock) wraca już sparsowany
do tablicy JS.

- **`pets`** (model jak `vehicles` — **z** `owner_id`/`visibility`, **plus** kolumna JSONB `fish_stock`):
  `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`,
  `name text NOT NULL`,
  `kind text NOT NULL CHECK (kind IN ('rabbit','dog','cat','guinea_pig','aquarium','other'))`,
  `color text NOT NULL`, `species text` (nullable — `species?`), `birth_date date` (nullable — `birthDate?`),
  `fish_stock jsonb` (nullable — obecne tylko dla `kind='aquarium'`; wzór `travelers`, ale nullable bo
  opcjonalne), `notes text` (nullable), `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`,
  `updated_by`. Indeksy: `(household_id)`, `(household_id, visibility)`, `(owner_id)` (parytet z `vehicles`).
- **`pet_expenses`** (model jak `car_expenses` — **z** `owner_id`/`visibility`): `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `pet_id text NOT NULL REFERENCES pets(id) ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`, `date date NOT NULL`,
  `type text NOT NULL CHECK (type IN ('food','vet','accessories','grooming','other'))`,
  `amount_minor bigint NOT NULL CHECK (amount_minor >= 0)`, `title text NOT NULL`, `notes text` (nullable),
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(pet_id)`, `(household_id, visibility)`.
- **`pet_visits`** (model jak `car_expenses` — **z** `owner_id`/`visibility`; różnica względem
  `vehicle_deadlines`, które własnej widoczności nie miały): `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `pet_id text NOT NULL REFERENCES pets(id) ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`, `title text NOT NULL`,
  `clinician text NOT NULL`, `specialty text` (nullable), `date date NOT NULL`, `time text NOT NULL`
  (clockTime `HH:MM` — potrzebne dla push -24 h; przechowywane jako `text`, nie `time`, dla parytetu
  z dzisiejszym stringiem i uniknięcia strefowego parsowania), `location text` (nullable),
  `status text NOT NULL CHECK (status IN ('scheduled','completed','cancelled'))`, `notes text` (nullable),
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(pet_id)`, `(household_id, visibility)`.
- **`pet_mutations`** (idempotencja + lekki audyt, 1:1 jak `car_mutations`):
  `idempotency_key uuid PRIMARY KEY`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `user_id uuid NOT NULL REFERENCES users(id)`, `op text NOT NULL`, `result jsonb NOT NULL`,
  `created_at timestamptz NOT NULL DEFAULT now()`. Indeks `(created_at)` do retencji.

### Projekt `fishStock` — zagnieżdżona kolumna JSONB (wzór `Trip.travelers`)

**Dzisiaj:** `Pet.fishStock?: FishStockEntry[]` jest zagnieżdżone w rekordzie profilu w JSONB; równoległa
edycja obsady tego samego akwarium rozstrzyga się last-write-wins na całym rekordzie `Pet` (patrz Ryzyka
w `zwierzeta-wydatki-wet.md`).

**Docelowo — kolumna `pets.fish_stock jsonb`, dokładnie jak `trips.travelers jsonb`:**

- `pet.create`/`pet.update` niosą **całą** tablicę `fishStock` w payloadzie; serwer zapisuje ją atomowo
  jako `$n::jsonb` (`JSON.stringify(payload.fishStock)`), wzór `trips.mjs:837`
  (`JSON.stringify(data.travelers)`) i `:889` (update). Walidacja tablicy hand-rolled (wzór
  `isTravelersArray` z `trips.mjs`): każdy wpis `{ id:isId, species:nonEmptyText, count:nieujemna liczba
  całkowita }`, cap `.max(500)` (parytet z `src/lib/schema.ts:391`).
- Row→DTO: `fishStock: Array.isArray(row.fish_stock) ? row.fish_stock : undefined` (wzór `trips.mjs:171`,
  ale z `undefined` gdy null/brak, bo pole jest opcjonalne — nie pustą tablicą jak travelers, żeby
  zachować `fishStock?` i nie „materializować" akwariowego pola dla nie-akwariów).
- **Bez własnej wersji/kolizji** — obsada wędruje z `version` profilu; równoległa edycja obsady tego
  samego akwarium to last-write-wins na całym profilu przez OCC (`baseVersion`), dokładnie jak dziś
  i jak `travelers`.
- **Normalizacja pól wariantowych po `kind` (server-side).** Dziś `savePet` (`PetsPage.tsx:239-258`) przy
  zapisie zeruje pola przeciwnego wariantu: dla `aquarium` → `species`/`birthDate` = `undefined`; dla
  nie-akwarium → `fishStock` = `undefined`. **Uwaga na pułapkę serializacji:** klient wysyła te pola jako
  `undefined`, a `JSON.stringify` **usuwa** klucze `undefined` z payloadu, więc bez ostrożności serwer
  zachowałby stare wartości. Dlatego `pet.update` **normalizuje wariant po `kind` autorytatywnie na
  serwerze**: gdy wynikowy `kind !== 'aquarium'` → `fish_stock = NULL`; gdy `kind === 'aquarium'` →
  `species = NULL`, `birth_date = NULL`. To odtwarza dzisiejsze zerowanie z `savePet` niezależnie od tego,
  które klucze przetrwały serializację. (Patrz Ryzyka.)

### Ops mutacji (mapowanie 1:1 na dzisiejsze akcje UI z `PetsPage.tsx`/`useAdvancedStore.ts`)

```
pet.create,     pet.update,     pet.delete
expense.create, expense.delete
visit.create,   visit.update,   visit.delete
```

- `pet.create` — dziś `addPet` (`PetsPage.tsx:263`). Payload: `id`, `name`, `kind`, `color`, `species?`,
  `birthDate?`, `fishStock?`, `notes?`, `visibility`. `ownerId` **z sesji** (`resolveOwnerId`, nigdy
  z payloadu). Serwer normalizuje wariant po `kind` (jak wyżej). Wynik: `{ record: pet }`.
- `pet.update` — dziś `updatePet` (`PetsPage.tsx:260`). `PET_UPDATE_KEYS = { name, kind, color, species,
  birthDate, fishStock, notes, visibility }`. OCC przez `baseVersion`. Normalizacja wariantu po `kind`
  server-side. **Kaskada widoczności (decyzja użytkownika):** gdy `changes.visibility` jest obecne i różni
  się od bieżącej wartości, `execPetUpdate` w tej samej transakcji przestawia `visibility`/`owner_id`
  wszystkich `pet_expenses`/`pet_visits` tego profilu na nową wartość rodzica (`UPDATE pet_expenses SET
  visibility=$new, owner_id=$petOwnerId, version=version+1, updated_at=now() WHERE pet_id=$id`, analogicznie
  `pet_visits`) — wierne odtworzenie dzisiejszego `splitWorkspaceData` (prywatny rodzic wymusza prywatność
  dzieci). Bez tego prywatny profil ujawniałby wcześniej-wspólne wydatki/wizyty całemu gospodarstwu.
  Wynik: `{ record: pet }`.
- `pet.delete` — dziś `deletePet` (`PetsPage.tsx:272`) — usuwa profil **oraz** jego wydatki i wizyty
  (dziś `deletePet` filtruje `petExpenses`/`petVisits` po `petId`, `useAdvancedStore.ts:118-123`).
  W SQL: `DELETE FROM pets …` z kaskadą FK `ON DELETE CASCADE` usuwa `pet_expenses`/`pet_visits`
  automatycznie. OCC opcjonalne (`baseVersion?`, parytet z `vehicle.delete`).
- `expense.create` — dziś `addPetExpense` (`PetsPage.tsx:312`). Payload: `id`, `petId`, `date`, `type`,
  `amountMinor`, `title`, `notes?`, `visibility?`. Sprawdzenie istnienia/dostępności profilu-rodzica
  (scope widoczności, wzór `execCarExpenseCreate`). Widoczność bez jawnej wartości dziedziczy po profilu
  (`resolveExpenseVisibility`). Wynik: `{ record: expense }`. **Bez** efektu ubocznego na rodzicu (nie ma
  analogu `mileage`).
- `expense.delete` — dziś `deletePetExpense` (`PetsPage.tsx:327`). OCC opcjonalne. Usuwanie idempotentne.
- `visit.create` — dziś `addPetVisit` (`PetsPage.tsx:379`). Payload: `id`, `petId`, `title`, `clinician`,
  `specialty?`, `date`, `time`, `location?`, `status`, `notes?`, `visibility?`. Dziedziczenie widoczności
  z profilu jak wyżej. Wynik: `{ record: visit }`.
- `visit.update` — dziś `updatePetVisit` (`PetsPage.tsx:376`) **oraz** `togglePetVisitCompleted`
  (`PetsPage.tsx:685`, przełącza `status` między `completed` a `scheduled`). `VISIT_UPDATE_KEYS =
  { title, clinician, specialty, date, time, location, status, notes, visibility }`. OCC przez
  `baseVersion`. `togglePetVisitCompleted` wysyła `changes: { status }` z wyliczoną wartością (klient liczy
  toggle lokalnie z bieżącego stanu, jak dziś). Wynik: `{ record: visit }`.
- `visit.delete` — dziś `deletePetVisit` (`PetsPage.tsx:387`). OCC opcjonalne. Usuwanie idempotentne.

Wersjonowanie (OCC) jak w Aucie/Finansach: `pet.update`/`visit.update`/`*.delete` niosą `baseVersion`;
`UPDATE … SET …, version = version + 1 WHERE id=$ AND household_id=$ AND version=$baseVersion
AND (visibility='household' OR owner_id=$user)`; `rowCount=0` → dogrywający `SELECT` w tym samym scope'ie
→ `status:"conflict"` + `currentVersion` albo `status:"error", code:"NOT_FOUND"`. Usuwanie idempotentne
(brak rekordu = `applied`, wzór `resolveConflictOrGone` z `car.mjs`).

**Bezpieczeństwo scope'u widoczności (jak `car.mjs`/`finance.mjs`):** każde zapytanie diagnostyczne
konfliktu niesie **ten sam** filtr `household_id` + `(visibility='household' OR owner_id=$user)` co write,
żeby konflikt nie wyciekł istnienia/treści prywatnego rekordu innego domownika. ID profilu w
`expense.create`/`visit.create` sprawdzamy tak jak `vehicleId` w `execCarExpenseCreate` — ze scope'em
widoczności profilu (`WHERE id=$petId AND household_id=$ AND (visibility='household' OR owner_id=$user)`).
**Uwaga:** dzieci Zwierząt mają **własną** `visibility`, więc filtrują po swoim wierszu (jak `car_expenses`),
a **nie** przez `EXISTS` na rodzicu (tamten wariant dotyczył tylko `vehicle_deadlines`, które własnej
widoczności nie miały).

### Snapshot read (GET /api/v1/pets) — wspólne + własne prywatne (wzór `readCarSnapshot`)

Sekwencyjnie (jeden `client`; node-postgres = jedno zapytanie in-flight na połączenie):

- `pets`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2) ORDER BY created_at`.
- `pet_expenses`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2)
  ORDER BY date DESC, created_at DESC`.
- `pet_visits`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2) ORDER BY date, time`.

Wszystkie trzy na **własnej** widoczności (dzieci nie wymagają `EXISTS` na rodzicu — mają `visibility`).
Odpowiedź `{ pets[], petExpenses[], petVisits[], serverAt }`, każdy rekord z `version`.

### Endpointy REST (wzorzec 1:1 z Auta — `server/src/server.mjs:827-869`)

- **`GET /api/v1/pets`** → snapshot. Wzór: `GET /api/v1/car` + `readPetsSnapshot` (potrzebny
  `session.user_id` do filtra widoczności).
- **`POST /api/v1/pets/mutations`** → body `{ mutations: Mutation[] }`,
  `Mutation = { idempotencyKey: uuid, op, payload, baseVersion? }`. Serwer: walidacja kształtu całego
  batcha z góry (`assertPetsMutationShape`, wzór `assertCarMutationShape`), potem sekwencyjnie każda
  mutacja w `transaction()`: claim klucza (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` → retry
  zwraca zapisany `result`), walidacja payloadu, SQL, zapis `result`. Odpowiedź `200`
  `{ results: [{ idempotencyKey, status: "applied"|"duplicate"|"conflict"|"error", record?, currentVersion?,
  error?, code? }], serverAt }`. Globalne `400/413` tylko dla błędów całego żądania (zły kształt,
  przekroczony cap `MAX_PETS_MUTATIONS`/bajtów). Wzór 1:1: blok `POST /api/v1/car/mutations`.
- **`POST /api/v1/pets/reset`** → `resetPetsForUser(client, householdId, userId)`: usuwa wspólne
  (`visibility='household'`) **plus WYŁĄCZNIE prywatne rekordy wywołującego** (`owner_id=userId`) — wzór
  `resetCarForUser`/`resetFinanceForUser`, **nie** bezwarunkowy reset gospodarstwa jak trips/meals (bo
  Zwierzęta mają rekordy prywatne). Kolejność: `DELETE pet_expenses`, `DELETE pet_visits`, potem
  `DELETE pets` (wszystkie z filtrem `household OR owner=user`) — kaskada FK usuwa dzieci usuwanych
  profili; prywatne profile innych domowników i ich dzieci **zostają** (parytet z Autem/Finansami).

Reużycie (wszystko już istnieje w `server.mjs`): `requireHousehold`, `transaction()`, handler `23505 →
409`, `httpError`, cap batcha (`MAX_PETS_MUTATIONS_PER_BATCH`/`_BYTES` na wzór `MAX_CAR_MUTATIONS_*`),
sekwencyjne przetwarzanie mutacji, `session.user_id` w scope'ie. Nagłówki bezpieczeństwa/CSRF działają
automatycznie dla nowych tras.

### Backend — `server/src/pets.mjs` (wzór 1:1 z `server/src/car.mjs`)

Czyste, testowalne funkcje: walidatory payloadów per `op` (`validatePetCreatePayload`,
`validatePetUpdatePayload`, `validatePetExpenseCreatePayload`, `validatePetVisitCreatePayload`,
`validatePetVisitUpdatePayload`, `validateDeleteIdPayload`), `resolveOwnerId`, `resolveExpenseVisibility`,
`resolveVisitVisibility`, `resolveVersionConflict`, walidator tablicy `isFishStockArray` (wzór
`isTravelersArray` z `trips.mjs`), mapery wiersz→DTO (`petRowToDto`/`petExpenseRowToDto`/`petVisitRowToDto`),
`readPetsSnapshot(client, householdId, userId)`, `applyPetsMutation(client, ctx, mutation)`,
`resetPetsForUser(client, householdId, userId)`, `SUPPORTED_PETS_OPS`, `assertPetsMutationShape`,
`MAX_PETS_MUTATIONS_*`. Reużywa wzorca `resolveConflictOrError`/`resolveConflictOrGone` (skopiowane
z `car.mjs`), `query`/`transaction` z `db.mjs`, stałych `VISIBILITIES`/`isId`/`isIsoDate`/`isSafeMoney`/
`UUID_PATTERN`/`clockTime` (wzór z `car.mjs`). **Bez importu z `src/`** (serwer nie ma builda TS/zod;
walidatory ręczne odzwierciedlają `petSchema`/`petExpenseSchema`/`petVisitSchema` z `src/lib/schema.ts`
+ nowe `version`). **Brak** `upsertAutoDeadline`, **brak** monotonicznego `execVehicleMileage` — te nie
mają odpowiednika w Zwierzętach.

### Frontend — dedykowany store + silnik sync (offline-first)

- **`src/store/usePetsStore.ts` (nowy)** — wzór 1:1 z `src/store/useCarStore.ts`: Zustand + `persist`
  (klucz `puls-pets`), `safeLocalStorage`, `parseArrayField`, `merge` z guardem `persistedState ===
  undefined` (unikamy fałszywego „niezgodny format" na czystej instalacji — luka #3 ze „Status po
  wdrożeniu" Finansów, już poprawiona w `useCarStore.ts`). Trzyma `pets/petExpenses/petVisits` (każdy
  z `version`) + `pendingMutations[]` + `serverAt`/`hydrated`. Akcje **zachowują nazwy i sygnatury**
  dzisiejszych z `useAdvancedStore`, żeby diff w `PetsPage`/`TodayPage`/`CommandPalette` był minimalny:
  `addPet`, `updatePet`, `deletePet`, `addPetExpense`, `deletePetExpense`, `addPetVisit`, `updatePetVisit`,
  `deletePetVisit`, `togglePetVisitCompleted` — **oraz** `hydrateFromSnapshot`, `applyMutationResults`,
  `resetPetsData` (wzór `useCarStore`). Każda akcja: optymistyczna zmiana lokalna → `idempotencyKey =
  crypto.randomUUID()` (`generateId()`) → mutacja do `pendingMutations` z aktualnym `baseVersion` rekordu
  → flush. `togglePetVisitCompleted` liczy nowy `status` lokalnie z bieżącego rekordu i wysyła
  `visit.update` z `changes: { status }`. Obsada `fishStock` niesiona w całości w `pet.create`/`pet.update`.
- **`src/hooks/usePetsSync.ts` + `src/server/PetsSync.tsx` (nowe)** — wzór 1:1 z `src/hooks/useCarSync.ts`
  / `src/server/CarSync.tsx`: montaż → `GET /api/v1/pets` (hydratacja) → drenaż kolejki przez
  `POST /api/v1/pets/mutations`; obsługa `applied`/`duplicate`/`conflict`/`error`; `MAX_FLUSH_ROUNDS`;
  nasłuch `online`/`focus`/`visibilitychange`; nieblokujący provider z własnym `sync-indicator`
  (`sync-indicator--pets`, etykiety „Zapisuję zwierzęta" / „Zwierzęta czekają na sieć" / „Zwierzęta
  zsynchronizowane"). Reużywa `apiRequest`/`ApiError` z `src/server/api.ts`.
- **Montaż**: w `src/server/AuthGate.tsx` (`:351-356`) zagnieżdżony wewnątrz `<CarSync>` (ten sam
  `key`/`onSessionExpired`): `…<CarSync><PetsSync …>{children}</PetsSync></CarSync>…`. Dorzuć `usePetsStore`
  do importów (`:23`), do `bindLocalStorageTo`/`clearLocalUserData` (reset `resetPetsData()` +
  `safeRemoveStorageItem("puls-pets")`, `:73-98`) i do `hasUnsyncedChanges`
  (`usePetsStore.getState().pendingMutations.length > 0`, `:114`).

### Worker — powiadomienia o wizytach z SQL, z targetowaniem per widoczność

`server/src/worker.mjs:187-197` czyta dziś `advanced.petVisits` z dokumentu JSONB w `derivedReminders`,
by wysłać push „Wizyta u weterynarza: <tytuł>" (24 h przed `date`+`time`, `status='scheduled'`, okno
2 dni). `deliverDerived` jest wołane dla dokumentu wspólnego (wszyscy domownicy) **i** per prywatny
dokument (`targetUserId`) — dziś to naturalnie targetuje wizyty prywatne tylko do właściciela. Po migracji
odtwarzamy to samo targetowanie odczytem z SQL — **dokładnie jak `carDeadlineReminders`**
(`worker.mjs:252-276`), ale **prościej: bez joina** (wizyta ma własną `visibility`/`owner_id`, nie trzeba
sięgać do rodzica) i z **godziną z kolumny** (nie stałą „09:00"):

- Nowa `petVisitReminders(householdId, nowKey)`:
  `SELECT id, title, date::text AS date, time, visibility, owner_id FROM pet_visits
   WHERE household_id = $1 AND status = 'scheduled'`.
  Dla każdego wiersza: `dueKey = shiftLocalDateTime(date, time, -24*60)`; jeśli
  `withinDeliveryWindow(dueKey, nowKey, 2)` — buduje `{ reminder: { id: "pet-visit:<id>", title:
  "Wizyta u weterynarza: <title>", date, time }, targetUserId: visibility === 'private' ? owner_id : null }`.
  **Prefiks `pet-visit:` zachowany 1:1** (stabilny, różny od `health-appointment:`/`vehicle:`) — dedup
  w `notification_deliveries` niezmieniony.
- W głównej pętli (`worker.mjs:331-344`, obok `carDeadlineReminders`): dla każdego wpisu
  `deliverReminder(workspace, reminder, targetUserId)` — `null` = wszyscy domownicy, `owner_id` = tylko
  właściciel prywatnej wizyty.
- **Usuń** pętlę po `advanced.petVisits` z `derivedReminders` (`worker.mjs:187-197`) — nie ma już tam
  wizyt Zwierząt.
- Dorzuć prune retencji obok istniejących (`worker.mjs:304-307`):
  `DELETE FROM pet_mutations WHERE created_at < now() - interval '30 days'`.

### Migracja danych historycznych (`010_pets_normalized.sql`)

Wzór 1:1 z `009_car_normalized.sql` (defensywność wobec `NULL`/nieobecnych kolekcji, `ON CONFLICT (id)
DO NOTHING`, idempotentne przez `schema_migrations`; `owner_id` prywatnych z **kolumny `user_id` wiersza
`user_workspace_states`**, nigdy z JSON):

1. `CREATE TABLE IF NOT EXISTS` dla czterech tabel + indeksy.
2. **Profile wspólne**: `jsonb_array_elements(ws.data->'advanced'->'pets')` → `pets`
   (`household_id = ws.household_id`, `owner_id = COALESCE(hm.user_id, h.created_by)` z `LEFT JOIN
   household_members hm ON hm.user_id::text = rec->>'ownerId'`, `visibility` z `rec->>'visibility'`
   z fallbackiem `household`, `kind` z clampem do dozwolonego zbioru — fallback `other`,
   `fish_stock = rec->'fishStock'` (zostawiamy `NULL` gdy brak; **nie** `COALESCE …'[]'`, bo pole
   opcjonalne), `birth_date = NULLIF(rec->>'birthDate','')::date`, `species`/`notes` z `rec->>'…'`).
   Wzór: „Pojazdy: wspólne" w `009`.
3. **Profile prywatne**: `jsonb_array_elements(uws.data->'advanced'->'pets')` → `pets`
   z `household_id = uws.household_id`, `owner_id = uws.user_id`, `visibility='private'`. **Bez ujawnienia.**
4. **Wydatki** (`petExpenses`) wspólne + prywatne, tylko gdy istnieje zmigrowany profil-rodzic w tym
   samym gospodarstwie (`WHERE EXISTS (SELECT 1 FROM pets p WHERE p.id = rec->>'petId' AND
   p.household_id = …)` — guard sierot jak dla `car_expenses`). `owner_id`/`visibility` jak profile.
5. **Wizyty** (`petVisits`) wspólne + prywatne, analogicznie z guardem sierot; `date = (rec->>'date')::date`,
   `time = rec->>'time'` (text), `status` z clampem (fallback `scheduled`), pola opcjonalne z `rec->>'…'`.
6. **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data #- '{advanced,pets}'
   #- '{advanced,petExpenses}' #- '{advanced,petVisits}', revision = revision + 1
   WHERE data->'advanced' ?| array['pets','petExpenses','petVisits']` oraz analogicznie
   `user_workspace_states` (`updated_at = now()`; ta tabela nie ma `revision`). Bump `revision` wymusza
   czysty refetch u klientów (wzór `009`).

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/010_pets_normalized.sql` (**nowy**) — kolejny numer po `009_car_normalized.sql`.
  `CREATE TABLE` czterech tabel + indeksy + migracja danych (wspólne + prywatne, guard sierot, `fishStock`
  jako JSONB) + wycięcie z JSONB. Wzorzec: `server/migrations/009_car_normalized.sql` (prywatność, dzieci
  CASCADE) + `007_trips_normalized.sql` (kolumna `travelers jsonb` dla `fish_stock`).
- `src/petsTypes.ts` (**nowy**) — przenieś `Pet`, `PetExpense`, `PetVisit`, `PetKind`, `FishStockEntry`
  z `src/advancedTypes.ts` (`:40-82`); **dodaj `version: number` i `updatedAt: string`** do `Pet`/
  `PetExpense`/`PetVisit`. `Pet`/`PetExpense`/`PetVisit` **nadal rozszerzają `SharedMeta`** (zachowują
  `ownerId`/`visibility` — jak `carTypes.ts`, różnica względem trips/meals, które je porzuciły). Wspólne
  źródło prawdy backend/frontend (wzór `src/carTypes.ts`).
- `src/advancedTypes.ts` — usuń `Pet`/`PetExpense`/`PetVisit`/`PetKind`/`FishStockEntry` (`:40-82`) i pola
  `pets`/`petExpenses`/`petVisits` z interfejsu `AdvancedData` (`:128-130`); dodaj re-eksport
  `export type { Pet, PetExpense, PetVisit, PetKind, FishStockEntry } from "./petsTypes"` (wzór linii
  `:23` dla carTypes).
- `src/lib/schema.ts` — usuń `pets`/`petExpenses`/`petVisits` z `advancedDataSchema` (`:455-457`);
  przebuduj `petSchema`/`petExpenseSchema`/`petVisitSchema` (`:379-408`) — **zachowaj `sharedMetaSchema`
  i `fishStockEntrySchema`**, dodaj `version: recordVersion` + `updatedAt: timestamp` — do walidacji
  snapshotu i persystencji nowego store'u (wzór: `vehicleSchema`/`carExpenseSchema` z `version`).
  Zaktualizuj import typów (dodaj `Pet`/`PetExpense`/`PetVisit` z `./petsTypes` jeśli używane).

### Backend (warstwa backend)

- `server/src/pets.mjs` (**nowy**) — analogicznie do `server/src/car.mjs`: walidatory payloadów per `op`,
  `resolveOwnerId`, `resolveExpenseVisibility`, `resolveVisitVisibility`, `resolveVersionConflict`,
  `isFishStockArray`, mapery wiersz→DTO, `readPetsSnapshot`, `applyPetsMutation`, `resetPetsForUser`,
  `SUPPORTED_PETS_OPS`, `assertPetsMutationShape`, `MAX_PETS_MUTATIONS_*`. Reużywa
  `resolveConflictOrError`/`resolveConflictOrGone`/`resolveOwnerId`/`resolveTransactionVisibility` (wzorce
  z `car.mjs`/`finance.mjs`). **Bez importu z `src/`**. **Bez** `upsertAutoDeadline`/`execVehicleMileage`.
  Normalizacja wariantu po `kind` w `execPetCreate`/`execPetUpdate` (zerowanie `fish_stock` lub
  `species`/`birth_date`).
- `server/src/server.mjs` — dodaj importy z `./pets.mjs` (obok `./car.mjs`, `:36-42`); dodaj
  `GET /api/v1/pets`, `POST /api/v1/pets/mutations`, `POST /api/v1/pets/reset` (kopiuj strukturę bloków
  car `:827-869` — używają `session.user_id` w scope'ie; te same reużycia `requireHousehold`/`transaction`/
  `httpError`/cap batcha).
- `server/src/workspace.mjs` — usuń `"pets"`/`"petExpenses"`/`"petVisits"` z `META_COLLECTIONS`
  (`:11-13`); usuń `petExpenses`/`petVisits` z `CHILD_RELATIONS` (`:17-18` — zostanie pusty obiekt `{}`,
  co jest OK: pętle po `CHILD_RELATIONS` degradują się do braku dzieci); usuń
  `"pets"`/`"petExpenses"`/`"petVisits"` z `ADVANCED_COLLECTIONS` (`:29-31`) — to automatycznie wyłącza je
  z `splitWorkspaceData`/`mergeWorkspaceData` i `workspaceDocumentIsValid`. **To ostatni moduł
  z `CHILD_RELATIONS`** — po wycięciu obiekt jest pusty; zweryfikuj, że `splitWorkspaceData`/
  `mergeWorkspaceData` działają z pustym `CHILD_RELATIONS` (iterują `Object.entries`/`Object.keys` → brak
  iteracji, poprawnie).
- `server/src/worker.mjs` — dodaj `petVisitReminders(householdId, nowKey)` (odczyt wizyt z SQL, bez joina,
  z `visibility`/`owner_id` i godziną z kolumny) i wywołuj ją w głównej pętli obok `carDeadlineReminders`
  (`:331-344`) z targetowaniem `deliverReminder(workspace, reminder, targetUserId)`; usuń pętlę po
  `advanced.petVisits` z `derivedReminders` (`:187-197`); dodaj prune `pet_mutations` (`:304-307`).

### Frontend (warstwa frontend)

- `src/store/usePetsStore.ts` (**nowy**) — dedykowany store z optymistycznymi mutacjami, kolejką
  `pendingMutations`, `version` per rekord, obsadą `fishStock` niesioną w całości. Wzór: `useCarStore.ts`.
- `src/hooks/usePetsSync.ts` + `src/server/PetsSync.tsx` (**nowe**) — silnik sync + nieblokujący provider.
  Wzór: `useCarSync.ts` / `CarSync.tsx` (+ `apiRequest`/`ApiError` z `src/server/api.ts`).
- `src/store/useAdvancedStore.ts` — usuń stan `pets/petExpenses/petVisits` (import typów `:25-27`,
  schematów `:14-16`), akcje `addPet`/`updatePet`/`deletePet`/`addPetExpense`/`deletePetExpense`/
  `addPetVisit`/`updatePetVisit`/`deletePetVisit`/`togglePetVisitCompleted` (interfejs `:61-69`, impl
  `:109-150`), z `replaceAdvancedData` (`:226-228`), `merge` (`:249-251,275-277,298-300`), `partialize`
  (`:311-313`) i `exportAdvancedData` (`:329-331`).
- `src/pages/PetsPage.tsx` — podmień importy akcji z `useAdvancedStore` na `usePetsStore` (nazwy
  zachowane → diff minimalny, `:150-162`). `hideAmounts` (`:153`) dalej z `useAdvancedStore` (osobista
  preferencja, zostaje w workspace). `currentOwnerId` (`:149`) dalej z `useServerAuth`. **Bez zmian
  w JSX/layoutcie/modalach.**
- `src/pages/TodayPage.tsx` — podmień `petVisits` (`:105`) z `useAdvancedStore` na `usePetsStore`;
  `nextPetVisit` (`:206-208`) i kafelek „Zwierzęta" (`:577-586`) bez zmian logiki. UX niezmieniony.
- `src/components/CommandPalette.tsx` — podmień `pets` (`:122`) z `useAdvancedStore` na `usePetsStore`;
  wpis nawigacyjny (`:94`) i wyniki wyszukiwania (`:263-272`, zależność `useMemo` `:307`) bez zmian.
- `src/server/WorkspaceSync.tsx` — usuń `pets`/`petExpenses`/`petVisits` z `replaceWithEmptyWorkspace`
  (`:49-51`).
- `src/server/AuthGate.tsx` — zamontuj `<PetsSync>` wewnątrz `<CarSync>` (`:351-356`); dodaj import
  `usePetsStore` (`:23`), reset w `bindLocalStorageTo`/`clearLocalUserData` (`:73-98`) +
  `safeRemoveStorageItem("puls-pets")`, oraz `usePetsStore().pendingMutations` w `hasUnsyncedChanges`
  (`:114`).
- `src/pages/SettingsPage.tsx` — w „Wyczyść dane aplikacji" dodaj
  `await apiRequest("/api/v1/pets/reset", { method: "POST", json: {} })` obok car/finance/trips/meals
  (`:183`) i `resetPetsData()` obok `resetCarData()` (`:220`); usuń `pets`/`petExpenses`/`petVisits`
  z lokalnego `replaceAdvancedData` (`:210-212`). Dodaj import `usePetsStore` (obok `useCarStore` `:52`).
- `src/data/advancedData.ts` — usuń seed `pets`/`petExpenses`/`petVisits` z `createAdvancedData()`
  (`:96-164`); serwer jest źródłem prawdy (domyślny stan offline = pusty), analogicznie do wycięcia seedu
  car/finance/trips/meals.

### Nawigacja/routing — BEZ zmian

`src/types.ts` (`ViewId` z `"pets"`), `src/components/Layout.tsx` (wpis `navigation` + `titles`),
`src/App.tsx` (`lazy` import + `viewIds` + render `PetsPage`) — **nie ruszamy**, trasa/zakładka „Zwierzęta"
zostaje. Zmienia się wyłącznie warstwa danych pod stroną.

### Testy (aktualizacja + nowe)

- Aktualizacja: `src/store/useAdvancedStore.test.ts` (usuń przypadki pet CRUD — `:` wyszukać `Pet`),
  `src/server/workspaceMerge.test.ts`/`WorkspaceSync.test.tsx`, `src/lib/schema.test.ts` (jeśli waliduje
  advancedData ze Zwierzętami), `src/App.test.tsx`, `server/test/workspace.node.mjs` (bez pets/petExpenses/
  petVisits w split/merge i `workspaceDocumentIsValid`; **uwaga: to usuwa ostatnie `CHILD_RELATIONS` —
  dodaj/utrzymaj test, że split/merge działają z pustym rejestrem**).
- Nowe: `src/store/usePetsStore.test.ts` (optymistyczne mutacje, `fishStock` niesiony w create/update,
  wersje, kolejka, `togglePetVisitCompleted` liczy status lokalnie, prywatność w payloadzie, idempotencja:
  retry z tym samym kluczem nie dubluje; `conflict` per rekord); `server/test/pets.node.mjs` (walidatory
  w tym `isFishStockArray`, `resolveVersionConflict`, `resolveExpenseVisibility`/`resolveVisitVisibility`,
  `owner_id` z sesji niezależnie od payloadu, normalizacja wariantu po `kind` — akwarium zeruje
  species/birthDate, nie-akwarium zeruje fishStock, scope widoczności w konfliktach, dziecko sieroce
  odrzucone, idempotencja retry, reset per-user nie rusza prywatnych innych domowników, push wizyty
  targetowany per widoczność).

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do Zwierząt
      w `AdvancedData`/`advancedDataSchema`/`useAdvancedStore`/`WorkspaceSync`.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane testy generyczne bez Zwierząt; nowy
      `usePetsStore.test.ts` (optymistyczne mutacje, `fishStock`, wersje, kolejka, toggle statusu,
      idempotencja: retry z tym samym kluczem nie dubluje; `conflict` per rekord).
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (bez Zwierząt
      w split/merge i `workspaceDocumentIsValid`, poprawny przy pustym `CHILD_RELATIONS`); nowy
      `server/test/pets.node.mjs` (opis wyżej).
- [ ] Migracja `010` na bazie z istniejącymi Zwierzętami w JSONB (w tym prywatnymi profilami/wydatkami/
      wizytami): rekordy trafiają do tabel z zachowanym `id`/`ownerId`/`visibility`/znacznikami czasu,
      `fishStock` zachowany dla akwariów, wydatki/wizyty bez zmigrowanego rodzica pominięte,
      `data->'advanced'` nie zawiera już kolekcji Zwierząt, dwukrotne uruchomienie nie duplikuje, prywatne
      pozostają prywatne (nie ujawnione).
- [ ] `npm run preview` (także wąski ekran, PWA): dodanie/edycja/usunięcie profilu (standardowego
      i akwarium z obsadą `fishStock`), przełączenie `kind` czyści pola przeciwnego wariantu, dodanie/
      usunięcie wydatku z kategorią i kwotą PLN, filtr wydatków, dodanie/edycja/oznaczenie-odbytą/usunięcie
      wizyty, przełącznik „Tylko ja" na profilu/wydatku/wizycie, kafelek „Zwierzęta" na „Dzisiaj",
      „Ukryj kwoty" — działają identycznie jak przed zmianą.
- [ ] Offline → online: mutacje bez sieci kolejkują się i zapisują po powrocie; retry tej samej kolejki
      nie tworzy duplikatów.
- [ ] Dwa „urządzenia": równoległa edycja **różnych** rekordów przechodzi bez konfliktu; równoległa edycja
      **tego samego** profilu/wizyty ze starą wersją zwraca konflikt tylko dla niego, reszta batcha
      przechodzi; równoległa edycja obsady tego samego akwarium rozstrzyga się last-write-wins na profilu.
- [ ] Worker wysyła push „Wizyta u weterynarza: <tytuł>" z nowej tabeli (24 h przed, `status='scheduled'`):
      dla wizyty wspólnej do wszystkich domowników, dla prywatnej tylko do właściciela; prefiks
      `pet-visit:` niezmieniony (brak kolizji dedup).
- [ ] Po wdrożeniu: aktualizacja tabeli priorytetów w `docs/DATA_MODEL_MIGRATION.md` — wiersz „Zwierzęta
      (Pets)" status „🔜 W trakcie" → „✅ Zrobione (PR #NN)" z faktycznym numerem PR; ewentualna sekcja
      „Status po wdrożeniu" z lukami znalezionymi w E2E (jak w planach Finansów/Auta).

## Ryzyka

- **Regresja push o wizytach weterynaryjnych.** Wycięcie Zwierząt z JSONB **psuje** push, jeśli nie
  zaktualizujemy `worker.mjs`. Zwierzęta mają widoczność — błędne targetowanie ujawniłoby prywatną wizytę
  całemu gospodarstwu. Pokryć weryfikacją, że reminder `pet-visit:<id>` powstaje z SQL, z godziną
  z kolumny (nie „09:00"), i trafia do właściwego audytorium (wszyscy vs właściciel). Prefiks `pet-visit:`
  musi zostać identyczny (dedup w `notification_deliveries`).
- **Pułapka serializacji `undefined` przy zmianie `kind` (pola wariantowe).** Klient wysyła zerowane pola
  wariantu jako `undefined`, a `JSON.stringify` je usuwa — bez normalizacji serwerowej po `kind`
  akwarium zachowałoby stary `species`/`birthDate`, a nie-akwarium starą obsadę `fishStock`. **Musimy
  normalizować wariant autorytatywnie w `pet.update`** (`kind !== 'aquarium'` ⇒ `fish_stock = NULL`;
  `kind === 'aquarium'` ⇒ `species/birth_date = NULL`). Pokryć testem serwerowym w obie strony.
- **Prywatność w konfliktach i snapshotcie.** Zapytania diagnostyczne konfliktów muszą nieść ten sam filtr
  `(visibility='household' OR owner_id=$user)` co write (inaczej wyciek prywatnego rekordu w odpowiedzi
  konfliktu). **W odróżnieniu od Auta** dzieci Zwierząt mają własną `visibility` — filtrują po swoim
  wierszu, **nie** przez `EXISTS` na rodzicu; łatwo skopiować z `car.mjs` niepotrzebny wariant `EXISTS`
  (dotyczył tylko `vehicle_deadlines`).
- **`visibility` edytowalne w UI (klasa regresji „goal visibility" z Finansów).** `PetsPage` pozwala dziś
  zmienić `visibility` profilu (`updatePet`) i wizyty (`updatePetVisit`) po utworzeniu — w odróżnieniu od
  Auta, gdzie `vehicle.update` **nie** ma `visibility` w kluczach. Jeśli pominiemy `visibility` w
  `PET_UPDATE_KEYS`/`VISIT_UPDATE_KEYS`, to **regresja** względem dzisiejszego zachowania (dokładnie luka
  #1 ze „Status po wdrożeniu" Finansów). Plan **włącza** `visibility` do kluczy edycji **z kaskadą na
  dzieci** przy `pet.update` (decyzja użytkownika, patrz „Ops mutacji" wyżej) — wierne odtworzenie
  dzisiejszego `splitWorkspaceData`.
- **`reset` per-user, nie bezwarunkowy.** W odróżnieniu od trips/meals (`reset` całego gospodarstwa),
  Zwierzęta mają rekordy prywatne — `resetPetsForUser` kasuje wspólne + wyłącznie prywatne wywołującego
  (wzór `resetCarForUser`). Skopiowanie z `resetTripsForHousehold` nuknęłoby prywatne profile innych
  domowników.
- **Pusty `CHILD_RELATIONS` po wycięciu.** Zwierzęta to **ostatni** moduł z wpisem w `CHILD_RELATIONS`
  (Auto już wycięte — `server/src/workspace.mjs:16` ma tylko petExpenses/petVisits). Po migracji obiekt
  jest pusty `{}`. `splitWorkspaceData`/`mergeWorkspaceData` iterują po `Object.entries/keys` — pusty
  rejestr = brak iteracji, poprawnie — ale pokryć testem, żeby przyszła zmiana nie założyła niepustości.
- **Duży blast radius wycięcia** (`workspace.mjs`, `advancedTypes.ts`, `schema.ts`, `useAdvancedStore.ts`,
  `WorkspaceSync.tsx`, `advancedData.ts`, `AuthGate.tsx`, `SettingsPage.tsx`, `TodayPage.tsx`,
  `CommandPalette.tsx`, `worker.mjs` + testy) — łapane przez `tsc` (strict) i testy; robić atomowo
  dane → backend → frontend (`implement-layered`).
- **Spójność sync z resztą modułów.** Usunięcie Zwierząt z `ADVANCED_COLLECTIONS`/`workspaceDocumentIsValid`
  musi być zsynchronizowane z klientem (schemat + `replaceWithEmptyWorkspace`), inaczej `PUT
  /api/v1/workspace` zwróci `400 INVALID_WORKSPACE_SCHEMA`. Bump `revision` w migracji wymusza czysty
  refetch. Reszta modułów (Zdrowie/Subskrypcje/Life) zostaje nietknięta w tym samym dokumencie.
- **Kolejność drenażu offline.** Mutacje zależne (`expense.create`/`visit.create` po `pet.create` tego
  samego profilu) muszą zachować kolejność — batch wysyłamy uporządkowany, serwer przetwarza sekwencyjnie
  (jak Finanse/Podróże/Meals/Auto). Store dokłada mutacje w kolejności wywołań akcji.

## Pytania do doprecyzowania

Obie otwarte kwestie rozstrzygnięte z użytkownikiem w rundzie doprecyzowującej:

- **Kaskada zmiany `visibility` profilu na jego dzieci: TAK, kaskada.** `pet.update` przy zmianie
  `visibility` przestawia w tej samej transakcji `visibility`/`owner_id` wszystkich `pet_expenses`/
  `pet_visits` tego profilu (wierne odtworzenie dzisiejszego `splitWorkspaceData`). Wpisane do „Ops
  mutacji" i „Ryzyka" wyżej.
- **`pet_visits.time`: `text`.** Parytet z dzisiejszym stringiem `clockTime`, unika strefowego rzutowania
  node-postgres. Bez zmian względem założenia planu.
