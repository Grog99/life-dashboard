# Migracja modułu Subskrypcje (Subscriptions) na znormalizowany model SQL

> Plan wygenerowany przez skill `/plan-feature`. Slug: `subskrypcje-sql`.
>
> Kontynuacja serii migracji z `docs/DATA_MODEL_MIGRATION.md` (moduł #6). **To SZÓSTA migracja wg tego
> samego wzorca** — pilot Finansów (PR #11) ustalił kształt, po nim Podróże (PR #13), Lista zakupów/Meals
> (PR #14), Auto/Car (PR #15), Zwierzęta/Pets (PR #16) i Zdrowie/Health (PR #17, NAJŚWIEŻSZY analog).
>
> **Świadoma decyzja, nie odkrycie luki.** Subskrypcje **nie mają** dowodu (a) (pole agregujące
> read-modify-write) ani (b) (realna częsta kolizja edycji) z `docs/DATA_MODEL_MIGRATION.md` — to jedna
> płaska kolekcja, rzadko edytowana (dodanie/anulowanie subskrypcji). Migrujemy ją **wyłącznie** z decyzji
> użytkownika z 17.07.2026 o ujednoliceniu architektury (wszystkie moduły → SQL), jawnie uchylając YAGNI
> z punktu 4 „Zasad kontynuacji". To nota, nie uzasadnienie techniczne — nie wymyślamy sztucznego (a)/(b).
> Użytkownik potwierdził zakres: **wyłącznie `subscriptions`, bez rozszerzania**.
>
> **Najprostszy przypadek w całej serii.** Subskrypcje to **jedna, płaska kolekcja** bez kolekcji
> potomnych (w odróżnieniu od Trips/Meals/Car/Pets, które miały dzieci przez FK, i od Zdrowia, które miało
> trzy niezależne kolekcje). To ściśle **podzbiór** wzorca Zdrowia/Pets: jedna tabela + jedna tabela
> idempotencji, bez `EXISTS`-scopingu, bez kaskad, bez pól specjalnych (żadnego `measuredAt`/`lastTakenOn`/
> `mileage`), bez prawdziwych toggli. Wszystkie akcje UI mapują się na trzy zwykłe mutacje CRUD z OCC.
>
> **Wzorce referencyjne — sześć zmergowanych migracji:**
> - **Zdrowie/Health (PR #17, NAJBLIŻSZY analog — płaska kolekcja z `visibility`, worker per widoczność)**:
>   `docs/plans/zdrowie-sql.md`, `server/src/health.mjs`, `server/migrations/011_health_normalized.sql`,
>   `src/healthTypes.ts`, `src/store/useHealthStore.ts`, `src/hooks/useHealthSync.ts`,
>   `src/server/HealthSync.tsx`, `server/test/health.node.mjs`. Zdrowie zachowuje `visibility` per rekord
>   i ma worker push targetowany per widoczność. Struktura przenosi się **niemal 1:1** — Subskrypcje to
>   jedna kolekcja zamiast trzech.
> - **Zwierzęta/Pets (PR #16)**: `server/src/pets.mjs`, `src/store/usePetsStore.ts`, `src/hooks/usePetsSync.ts`,
>   `src/server/PetsSync.tsx` — wzorzec store'u/sync/reset per-user i `resolveConflictOrGone`.
> - **Auto/Car (PR #15, wzorzec workera per widoczność bez joina rodzica)**: `docs/plans/auto-car.md`,
>   `server/src/car.mjs`, `carDeadlineReminders`/`deliverReminder`/`targetUserId` w `server/src/worker.mjs`.
> - **Finanse (PR #11, model warstwy prywatne/wspólne)**: `server/src/finance.mjs` (`resolveOwnerId`,
>   `resetFinanceForUser`).

## Kontekst / Problem

Moduł Subskrypcje to dziś fragment dokumentu JSONB (`workspace_states` / `user_workspace_states`),
synchronizowany generycznym mechanizmem `PUT /api/v1/workspace` (globalna rewizja + 3-way merge po `id`,
patrz `server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`). Kolekcja: `subscriptions` — **jedna
PŁASKA kolekcja BEZ relacji rodzic/dziecko**. Jest wpisana w `META_COLLECTIONS` (`server/src/workspace.mjs:10`,
gdzie jest **jedyną** pozostałą pozycją) oraz w `ADVANCED_COLLECTIONS` (`:20`); `CHILD_RELATIONS` jest już
pustym `{}` (od migracji Zwierząt).

Teraz — z decyzji użytkownika o ujednoliceniu architektury (`docs/DATA_MODEL_MIGRATION.md`, aktualizacja
17.07.2026) — przenosimy ją na znormalizowaną tabelę SQL. **Po wycięciu Subskrypcji w dokumencie „advanced"
nie zostaje już żadna kolekcja użytkownika** — tylko metadane gospodarstwa (`householdMembers`/
`householdName`/`hideAmounts`). `META_COLLECTIONS` staje się pustą tablicą `[]`.

Efekt docelowy: Subskrypcje przestają być częścią dokumentu JSONB. Dostają znormalizowaną tabelę SQL,
mutacje domenowe z kluczami idempotencji generowanymi po stronie klienta i optymistyczną kontrolę
współbieżności per rekord (kolumna `version`). Zachowujemy rozróżnienie prywatne/wspólne (`Subscription`
rozszerza dziś `SharedMeta` — `ownerId`/`visibility`, a modal ma aktywny selektor „Widoczność",
`SubscriptionsPage.tsx:530-541`). **UI/UX modułu pozostaje identyczne** — `src/pages/SubscriptionsPage.tsx`
zmienia tylko warstwę danych (import akcji ze store), nie layout ani modale.

### Czym Subskrypcje są PROSTSZE od Zdrowia/Zwierząt (istotne dla nakładu)

Zdrowie było już ściśle prostsze od Zwierząt/Auta; Subskrypcje są prostsze jeszcze o krok:

1. **Jedna kolekcja, nie trzy.** Jedna tabela `subscriptions` + jedna tabela idempotencji
   `subscription_mutations`. Trzy operacje CRUD (`create`/`update`/`delete`), jeden walidator create, jeden
   update, jeden delete-id.
2. **Brak relacji rodzic/dziecko** (jak Zdrowie) — żadnego FK między kolekcjami, żadnej kaskady, żadnego
   guardu sierot w migracji, żadnego `EXISTS`-scopingu. Każdy rekord filtruje po swoim wierszu
   (`visibility='household' OR owner_id=$user`).
3. **Brak kaskady i dziedziczenia widoczności** — nie ma dzieci ani rodzica; `subscription.update`
   zmieniające `visibility` dotyka tylko własnego wiersza.
4. **Brak pola agregującego / monotonicznego** — żadnego odpowiednika `Vehicle.mileage`/`balanceMinor`,
   żadnej mutacji `GREATEST` bez OCC. Wszystkie update-y używają OCC per rekord.
5. **Brak pól specjalnych** — żadnego free-form timestampu (`measuredAt`), żadnego prawdziwego toggla
   (`lastTakenOn`), żadnej zagnieżdżonej tablicy JSONB (`fishStock`/`travelers`). Same skalary + jedno
   opcjonalne pole tekstowe (`cancelUrl`).
6. **Brak dedykowanych akcji-toggli.** `renew` i `togglePause` (`SubscriptionsPage.tsx:216-230`) liczą
   **absolutne** nowe wartości lokalnie (`nextPayment`/`status`) i wołają zwykłe `updateSubscription` —
   to nie prawdziwe toggle jak `lastTakenOn` (nie ma hazardu podwójnego flipu), tylko `subscription.update`
   z policzoną zmianą.

## Wymagania

Funkcjonalne:

- Dane Subskrypcji (`subscriptions`) w znormalizowanej tabeli SQL, nie w JSONB. Jedna płaska kolekcja.
- Każda mutacja domenowa niesie **klucz idempotencji (UUID) generowany przez klienta**; serwer
  deduplikuje po kluczu (własna tabela `subscription_mutations`, retencja 30 dni — **nie** reużywamy
  `pet_mutations`/`health_mutations` itd.).
- **Optymistyczna współbieżność per rekord** (`version`); konflikt zwracany tylko dla konkretnego rekordu,
  reszta batcha przechodzi. **Wszystkie** update-y używają OCC (brak wyjątku — brak pola agregującego).
- **Zachowanie prywatności per rekord**: tabela ma `owner_id`/`visibility` (jak `pets`/`health_appointments`);
  `owner_id` zawsze **z sesji**, nigdy z payloadu. `visibility` jest **jawnie** wymagana na tworzeniu i
  **edytowalna** po utworzeniu (parytet z dzisiejszym `updateSubscription`, które przez modal edycji może
  zmienić widoczność).
- Jednorazowa migracja SQL przenosi istniejące dane Subskrypcji z JSONB (wspólne z `workspace_states`,
  prywatne z `user_workspace_states`) do nowej tabeli z zachowaniem `id`/`ownerId`/`visibility`/znaczników
  czasu i wartości pól, po czym **całkowicie usuwa** kolekcję z dokumentu JSONB i z generycznego sync (bez
  fallbacku). Rekordy prywatne migrują jako prywatne (bez ujawnienia — jak Health/Pets/Car/Finanse).
- **Powiadomienia push działają dalej** — worker czyta z nowej tabeli, z zachowaniem targetowania per
  widoczność (wspólna → wszyscy domownicy, prywatna → tylko właściciel):
  - **„Nadchodzi płatność: &lt;name&gt;"** o `09:00`, `reminderDays` dni przed `nextPayment`, dla
    `status <> 'cancelled'`, w oknie dostawy 7 dni (parytet 1:1 z dzisiejszą pętlą w `derivedReminders`).
  - Prefiks `subscription:` MUSI zostać identyczny (dedup w `notification_deliveries`).

Niefunkcjonalne:

- **Offline-first zachowany** — mutacje kolejkują się bez sieci i bezpiecznie odtwarzają (idempotencja),
  optymistyczny UI natychmiast pokazuje zmianę lokalnie.
- Widok Subskrypcji wygląda i działa tak samo, także na wąskim ekranie (PWA).
- Reużycie istniejących wzorców backendu i frontendu ze Zdrowia/Zwierząt (patrz „Pliki do zmiany").

## Zakres i Non-goals

**W zakresie:**

- Moduł Subskrypcje jako bounded context: tabela `subscriptions` + tabela idempotencji
  `subscription_mutations`. **Jedna kolekcja, jeden PR** (wiersz #6 trackera).
- Nowe endpointy REST `/api/v1/subscriptions` (snapshot), `/api/v1/subscriptions/mutations` (batch),
  `/api/v1/subscriptions/reset`.
- Nowy store frontendu (`useSubscriptionsStore`) + silnik synchronizacji (`useSubscriptionsSync` /
  `SubscriptionsSync`).
- **Migracja danych historycznych** z JSONB (wspólne + prywatne) do nowej tabeli, wycięcie z JSONB.
- Aktualizacja workera (dedykowana funkcja przypomnień czytająca z SQL + targetowanie per widoczność,
  prune `subscription_mutations`); usunięcie pętli `subscriptions` z `derivedReminders`.
- Wycięcie Subskrypcji z `workspace.mjs` (`META_COLLECTIONS`/`ADVANCED_COLLECTIONS`), `useAdvancedStore`,
  `WorkspaceSync.tsx`, `advancedDataSchema`, `advancedData.ts`, `advancedTypes.ts`, `AuthGate.tsx`,
  `SettingsPage.tsx`, `TodayPage.tsx`, `CommandPalette.tsx`.

**Non-goals (świadomie pomijamy — dopasowane do Subskrypcji):**

- **Ścisła migracja 1:1 — bez nowych funkcji, bez zmiany UX/zachowania.** Endpointy modelują dokładnie
  dzisiejszy zestaw mutacji `SubscriptionsPage.tsx`. Żadnych nowych pól ani ekranów.
- **Żaden inny moduł nie jest ruszany** (Finanse/Podróże/Meals/Auto/Zwierzęta/Zdrowie już zmigrowane;
  Life/`useLifeStore` zostaje na JSONB — patrz `docs/DATA_MODEL_MIGRATION.md`, wiersz #7). Nie budujemy
  generycznej „platformy sync"; **własna** tabela idempotencji `subscription_mutations`.
- **Zakres to wyłącznie `subscriptions`** (potwierdzone przez użytkownika) — bez rozszerzania o inne
  kolekcje advanced.
- **`FinanceTransaction.source` zostaje jak jest.** Pole `source: "…"|"subscription"|…`
  (`src/financeTypes.ts:35`, `src/lib/schema.ts:194`) to **wolnostojący string BEZ FK do `subscriptionId`**
  — inne moduły też tak mają dla `"trip"`/`"car"`. **Nie** projektujemy żadnej migracji/linkowania tego
  pola (potwierdzone).
- **Zachowujemy prywatność** — tabela z `owner_id`/`visibility`. Migracja **nie ujawnia** rekordów
  prywatnych (parytet z `011`/Health).
- **Bez redesignu UI.** Ten sam layout, te same modale i te same nazwy/sygnatury akcji store'u
  (`addSubscription`/`updateSubscription`/`deleteSubscription`) — żeby diff w `SubscriptionsPage.tsx`/
  `TodayPage.tsx`/`CommandPalette.tsx` był minimalny.
- **`renew`/`togglePause` reużywają zwykłego `subscription.update`** z policzoną lokalnie **absolutną**
  zmianą (`{ nextPayment, status }` / `{ status }`), jak `toggleAppointmentCompleted` w Zdrowiu. **Brak**
  dedykowanej mutacji i **brak** hazardu prawdziwego toggla (to sety absolutne, nie flip względem bazy).

## Podejście

### Decyzje ustalone z góry (twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe podjęto na podstawie ustaleń z użytkownikiem, parytetu ze
Zdrowiem/Zwierzętami i YAGNI — **rozstrzygnięte, nie otwarte**:

1. **Zakres: wyłącznie kolekcja `subscriptions`** (jeden plan, jedna migracja SQL, jeden PR), jedna tabela,
   bez dzieci, bez rozszerzania.
2. **Migracja: pełna migracja SQL + całkowite zastąpienie** (po migracji Subskrypcje znikają z JSONB, brak
   shimów).
3. **Idempotency keys: klient generuje UUID per mutacja**, osobna tabela `subscription_mutations`.
4. **Konflikty: optimistic concurrency per rekord** przez `version` (dla `subscription.update`/`.delete`).
   **Bez żadnego wyjątku** — brak pola agregującego.
5. **Prywatność zachowana** — tabela z `owner_id`/`visibility`; `owner_id` z sesji; `visibility` jawna na
   create, edytowalna na update. **Bez** dziedziczenia po rodzicu (nie ma rodzica) i **bez** kaskady na
   dzieci (nie ma dzieci).
6. **Worker: dedykowana funkcja `subscriptionReminders(householdId, nowKey)`** czytająca z SQL, z
   targetowaniem per widoczność (wzór `carDeadlineReminders`/`healthAppointmentReminders`); usunięcie pętli
   `subscriptions` z `derivedReminders`. Prefiks `subscription:` zachowany 1:1.

### Model tabeli (Postgres) — `server/migrations/012_subscriptions_normalized.sql`

Kolejny numer po `011_health_normalized.sql` (najwyższa istniejąca migracja). `id` typu `text` (zachowanie
legacy `id` 1:1 — `idSchema` dopuszcza stringi do 200 znaków). `updated_by uuid REFERENCES users(id)` jako
lekki audyt. Mapowanie typów jak w `health.mjs`/`car.mjs`: `date` przez `::text AS …` (uniknięcie
lokalno-strefowego parsowania node-postgres), `bigint` (kwota) przez `Number()`, `timestamptz` (`updated_at`)
przez `.toISOString()`. **Brak jakichkolwiek FK między tabelami** poza FK do `households`/`users`.

- **`subscriptions`** (model jak `pets`/`health_appointments`, z `owner_id`/`visibility`): `id text PK`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users(id)`,
  `visibility text NOT NULL CHECK (visibility IN ('private','household'))`,
  `name text NOT NULL`, `category text NOT NULL`,
  `amount_minor bigint NOT NULL CHECK (amount_minor >= 0)`,
  `currency text NOT NULL CHECK (currency IN ('PLN','EUR','USD','GBP'))`,
  `cycle text NOT NULL CHECK (cycle IN ('monthly','quarterly','yearly'))`,
  `next_payment date NOT NULL`, `payer text NOT NULL DEFAULT ''`,
  `status text NOT NULL CHECK (status IN ('active','trial','paused','cancelled'))`,
  `reminder_days integer NOT NULL DEFAULT 0 CHECK (reminder_days >= 0 AND reminder_days <= 365)`,
  `color text NOT NULL`, `cancel_url text` (nullable — `cancelUrl?`),
  `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(household_id, visibility)`, `(owner_id)`.
- **`subscription_mutations`** (idempotencja + lekki audyt, 1:1 jak `health_mutations`/`pet_mutations`):
  `idempotency_key uuid PRIMARY KEY`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `user_id uuid NOT NULL REFERENCES users(id)`, `op text NOT NULL`, `result jsonb NOT NULL`,
  `created_at timestamptz NOT NULL DEFAULT now()`. Indeks `(created_at)` do retencji.

### Ops mutacji (mapowanie 1:1 na dzisiejsze akcje UI z `SubscriptionsPage.tsx`/`useAdvancedStore.ts`)

```
subscription.create,  subscription.update,  subscription.delete
```

- `subscription.create` — dziś `addSubscription` (`SubscriptionsPage.tsx:210`, `useAdvancedStore.ts:56-60`).
  Payload: `id`, `name`, `category`, `amountMinor`, `currency`, `cycle`, `nextPayment`, `payer`, `status`,
  `reminderDays`, `color`, `cancelUrl?`, `visibility`. `ownerId` **z sesji** (`resolveOwnerId`, nigdy z
  payloadu — dziś UI dokleja `ownerId: currentOwnerId`, serwer to nadpisze). Wynik: `{ record }`.
- `subscription.update` — dziś `updateSubscription` (`useAdvancedStore.ts:61-66`), wołane z: edycji przez
  modal (`saveSubscription` gałąź `editing`, `:207`), `renew` (`:216-221` → `{ nextPayment, status }`),
  `togglePause` (`:223-230` → `{ status }`). `SUBSCRIPTION_UPDATE_KEYS = { name, category, amountMinor,
  currency, cycle, nextPayment, payer, status, reminderDays, color, cancelUrl, visibility }`. OCC przez
  `baseVersion`. `renew`/`togglePause` liczą **absolutne** nowe wartości lokalnie i wysyłają je jako
  `changes`. `cancelUrl` obsługiwany jako pole nullable (`hasOwnProperty`, wzór `species`/`notes`/`specialty`
  w `pets.mjs`/`health.mjs`) — `null`/pominięcie czyści kolumnę. Wynik: `{ record }`.
- `subscription.delete` — dziś `deleteSubscription` (`SubscriptionsPage.tsx:234`, `useAdvancedStore.ts:67-72`).
  OCC opcjonalne (`baseVersion?`). Usuwanie idempotentne (brak rekordu = `applied`, wzór
  `resolveConflictOrGone`).

Wersjonowanie (OCC) jak w Zdrowiu/Zwierzętach: `subscription.update`/`.delete` niosą `baseVersion`;
`UPDATE … SET …, version = version + 1 WHERE id=$ AND household_id=$ AND version=$baseVersion
AND (visibility='household' OR owner_id=$user)`; `rowCount=0` → dogrywający `SELECT` w tym samym scope'ie
→ `status:"conflict"` + `currentVersion` albo `status:"error", code:"NOT_FOUND"`. Usuwanie idempotentne.

**Bezpieczeństwo scope'u widoczności (jak `health.mjs`/`pets.mjs`):** każde zapytanie diagnostyczne
konfliktu niesie **ten sam** filtr `household_id` + `(visibility='household' OR owner_id=$user)` co write,
żeby konflikt nie wyciekł istnienia/treści prywatnego rekordu innego domownika. **Brak** wariantu `EXISTS`
(nie ma rodzica) i **brak** kaskady widoczności (nie ma dzieci).

### Snapshot read (GET /api/v1/subscriptions) — wspólne + własne prywatne (wzór `readHealthSnapshot`)

Jedno zapytanie: `subscriptions`: `WHERE household_id=$1 AND (visibility='household' OR owner_id=$2)
ORDER BY next_payment` (parytet z dzisiejszym sortem listy po `nextPayment`, `SubscriptionsPage.tsx:148`).
Odpowiedź `{ subscriptions[], serverAt }`, każdy rekord z `version` i `updatedAt`.

### Endpointy REST (wzorzec 1:1 ze Zdrowia/Zwierząt — `server/src/server.mjs:893-934`)

- **`GET /api/v1/subscriptions`** → snapshot. Wzór: `GET /api/v1/pets` + `readSubscriptionsSnapshot`
  (potrzebny `session.user_id` do filtra widoczności).
- **`POST /api/v1/subscriptions/mutations`** → body `{ mutations: Mutation[] }`,
  `Mutation = { idempotencyKey: uuid, op, payload, baseVersion? }`. Serwer: walidacja kształtu całego
  batcha z góry (`assertSubscriptionMutationShape`, wzór `assertPetsMutationShape`), potem sekwencyjnie każda
  mutacja w `transaction()`: claim klucza (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` → retry
  zwraca zapisany `result`), walidacja payloadu, SQL, zapis `result`. Odpowiedź `200`
  `{ results: [{ idempotencyKey, status, record?, currentVersion?, error?, code? }], serverAt }`. Globalne
  `400/413` tylko dla błędów całego żądania (zły kształt, przekroczony cap `MAX_SUBSCRIPTION_MUTATIONS`/
  bajtów). Wzór 1:1: blok `POST /api/v1/pets/mutations`.
- **`POST /api/v1/subscriptions/reset`** → `resetSubscriptionsForUser(client, householdId, userId)`: usuwa
  wspólne (`visibility='household'`) **plus WYŁĄCZNIE prywatne rekordy wywołującego** (`owner_id=userId`) —
  wzór `resetHealthForUser`/`resetPetsForUser`, **nie** bezwarunkowy reset gospodarstwa (bo Subskrypcje mają
  rekordy prywatne). Jeden `DELETE FROM subscriptions WHERE household_id=$1 AND (visibility='household' OR
  owner_id=$2)`. Prywatne rekordy innych domowników **zostają**.

Reużycie (wszystko już istnieje w `server.mjs`): `requireHousehold`, `transaction()`, `httpError`, cap
batcha (`MAX_SUBSCRIPTION_MUTATIONS_PER_BATCH`/`_BYTES` na wzór `MAX_PETS_MUTATIONS_*`), sekwencyjne
przetwarzanie mutacji, `session.user_id` w scope'ie. Nagłówki bezpieczeństwa/CSRF działają automatycznie
dla nowych tras.

### Backend — `server/src/subscriptions.mjs` (wzór 1:1 z `server/src/health.mjs`/`server/src/pets.mjs`)

Czyste, testowalne funkcje: walidatory payloadów per `op` (`validateSubscriptionCreatePayload`,
`validateSubscriptionUpdatePayload`, `validateDeleteIdPayload`), `resolveOwnerId`, `resolveVersionConflict`,
`normalizeRequiredVersion`/`normalizeOptionalVersion`, `normalizeOptionalText` (dla `cancelUrl`), maper
wiersz→DTO (`subscriptionRowToDto`), `readSubscriptionsSnapshot(client, householdId, userId)`,
`applySubscriptionMutation(client, ctx, mutation)`, `resetSubscriptionsForUser(client, householdId, userId)`,
`SUPPORTED_SUBSCRIPTION_OPS`, `assertSubscriptionMutationShape`, `MAX_SUBSCRIPTION_MUTATIONS_*`. Reużywa
wzorca `resolveConflictOrError`/`resolveConflictOrGone` (skopiowane z `health.mjs`), `query`/`transaction`
z `db.mjs`, prymitywów `isPlainObject`/`isId`/`isNonEmptyText`/`isOptionalText`/`isIsoDate`/`VISIBILITIES`/
`UUID_PATTERN` (wzór z `health.mjs`). **Bez importu z `src/`** (serwer nie ma builda TS/zod; walidatory
ręczne odzwierciedlają `subscriptionSchema` z `src/lib/schema.ts` + nowe `version`). **Bez**
`cascade*Visibility`, **bez** `resolve*Visibility` (dziedziczenia po rodzicu), **bez** sprawdzania istnienia
rodzica przy create — nie mają odpowiednika w płaskich Subskrypcjach.

Prymitywy specyficzne dla Subskrypcji (proste, ręcznie odzwierciedlają `subscriptionSchema`):
`isCurrency` (`['PLN','EUR','USD','GBP']`), `isCycle` (`['monthly','quarterly','yearly']`), `isStatus`
(`['active','trial','paused','cancelled']`), `isReminderDays` (int 0–365), `isCancelUrl` (opcjonalny
string URL, cap 2000 — walidacja jak `z.string().url()`, np. wymóg protokołu `http`/`https`),
`isSafeMoney`/`amountMinor` nonnegative (wzór z `car.mjs`/`finance.mjs`).

### Frontend — dedykowany store + silnik sync (offline-first)

- **`src/store/useSubscriptionsStore.ts` (nowy)** — wzór 1:1 z `src/store/useHealthStore.ts`/
  `usePetsStore.ts`: Zustand + `persist` (klucz `puls-subscriptions`), `safeLocalStorage`, `parseArrayField`,
  `merge` z guardem `persistedState === undefined` (unikamy fałszywego „niezgodny format" na czystej
  instalacji — luka #3 ze „Status po wdrożeniu" Finansów, poprawiona już w `useCarStore.ts`). Trzyma
  `subscriptions` (z `version`) + `pendingMutations[]` + `serverAt`/`hydrated`. Akcje **zachowują nazwy i
  sygnatury** dzisiejszych z `useAdvancedStore`, żeby diff w `SubscriptionsPage`/`TodayPage`/`CommandPalette`
  był minimalny: `addSubscription(subscription) => string`, `updateSubscription(id, changes)`,
  `deleteSubscription(id)` — **oraz** `hydrateFromSnapshot`, `applyMutationResults`, `resetSubscriptionsData`
  (wzór `useHealthStore`). Każda akcja: optymistyczna zmiana lokalna → `idempotencyKey = crypto.randomUUID()`
  (`generateId()`) → mutacja do `pendingMutations` z aktualnym `baseVersion` rekordu → flush. `.update`
  podlega cichemu rebase'owi przy konflikcie (wzór `isUpdateOp`/`upsertByUpdateOp` w `useCarStore.ts`) —
  reaplikuje deltę `changes` na świeży rekord. `renew`/`togglePause` w `SubscriptionsPage` wołają istniejące
  `updateSubscription(id, {...})` (bez zmian w page). Reużyj `parseArrayField`/`safeLocalStorage`/
  `quarantineRawValue`/`reportStorageWarning` (z `lib/safeStorage`) i `generateId` (z `lib/id`).
- **`src/hooks/useSubscriptionsSync.ts` + `src/server/SubscriptionsSync.tsx` (nowe)** — wzór 1:1 z
  `useHealthSync.ts` / `HealthSync.tsx`: montaż → `GET /api/v1/subscriptions` (hydratacja) → drenaż kolejki
  przez `POST /api/v1/subscriptions/mutations`; obsługa `applied`/`duplicate`/`conflict`/`error`;
  `MAX_FLUSH_ROUNDS`; nasłuch `online`/`focus`/`visibilitychange`; nieblokujący provider z własnym
  `sync-indicator` (`sync-indicator--subscriptions`, etykiety „Zapisuję subskrypcje" / „Subskrypcje czekają
  na sieć" / „Subskrypcje zsynchronizowane"). Reużywa `apiRequest`/`ApiError` z `src/server/api.ts`.
- **Montaż**: w `src/server/AuthGate.tsx` (`:373-378`) zagnieżdżony wewnątrz `<HealthSync>` (ten sam
  `key`/`onSessionExpired`): `…<HealthSync><SubscriptionsSync …>{children}</SubscriptionsSync></HealthSync>…`.
  Dorzuć `useSubscriptionsStore` do importów (`:27`), do `bindLocalStorageTo`/`clearLocalUserData` (reset
  `resetSubscriptionsData()` + `safeRemoveStorageItem("puls-subscriptions")`, `:68-112`) i do
  `hasUnsyncedChanges` (`useSubscriptionsStore.getState().pendingMutations.length > 0`, `:122-129`).

### Worker — dedykowana funkcja przypomnień z SQL, z targetowaniem per widoczność

`server/src/worker.mjs` czyta dziś subskrypcje z dokumentu JSONB wewnątrz `derivedReminders` (`:152-169`):
push „Nadchodzi płatność: &lt;name&gt;" o `09:00`, `reminderDays` dni przed `nextPayment`, gdy
`status !== 'cancelled'`, w oknie dostawy 7 dni (`withinDeliveryWindow(dueKey, nowKey)` z domyślnym
`days=7`; `dueKey = shiftLocalDateTime(nextPayment, "09:00", -reminderDays*24*60)`; `reminderDays` =
`Number.isFinite(...) ? Math.max(0, ...) : 1`). `deliverDerived` jest dziś wołane dla dokumentu wspólnego
(wszyscy domownicy) **i** per prywatny dokument (`targetUserId`) — co naturalnie targetuje rekordy prywatne
tylko do właściciela. Po migracji odtwarzamy to samo targetowanie odczytem z SQL — **dokładnie jak
`carDeadlineReminders`** (worker ma już ten wzorzec, `:206-230`), z `visibility`/`owner_id` per wiersz, bez
joina (Subskrypcje nie mają rodzica):

- Nowa `subscriptionReminders(householdId, nowKey)`:
  `SELECT id, name, next_payment::text AS next_payment, reminder_days, visibility, owner_id
   FROM subscriptions WHERE household_id = $1 AND status <> 'cancelled'`.
  Dla każdego wiersza: `days = Math.max(0, reminder_days)` (kolumna jest `NOT NULL`, zawsze skończona —
  fallback `1` z JSONB staje się zbędny, ale w migracji dbamy o defensywny default, patrz niżej);
  `dueKey = shiftLocalDateTime(next_payment, "09:00", -days*24*60)`; jeśli
  `withinDeliveryWindow(dueKey, nowKey)` (domyślne okno 7 dni — **nie** przekazujemy trzeciego argumentu,
  parytet 1:1) — `{ reminder: { id: "subscription:<id>", title: "Nadchodzi płatność: <name>",
  date: next_payment, time: "09:00" }, targetUserId: visibility === 'private' ? owner_id : null }`.
- W głównej pętli (`worker.mjs:411-438`, obok `healthAppointmentReminders`/`medicationReminders`): dla
  każdego wpisu `deliverReminder(workspace, reminder, targetUserId)` — `null` = wszyscy domownicy,
  `owner_id` = tylko właściciel prywatnej subskrypcji.
- **Usuń** pętlę `subscriptions` z `derivedReminders` (`worker.mjs:152-169`) — zostaje tam **tylko** pętla
  `events` (`life.events` nadal żyje w JSONB, nietknięte). `derivedReminders` przestaje dotykać `advanced`.
- Dorzuć prune retencji obok istniejących (`worker.mjs:359`):
  `DELETE FROM subscription_mutations WHERE created_at < now() - interval '30 days'`.
- **Prefiks `subscription:` i `time: "09:00"`/`date: next_payment` zachowane 1:1** — dedup w
  `notification_deliveries` (`occurrence = nextPayment T 09:00`) niezmieniony.

### Migracja danych historycznych (`012_subscriptions_normalized.sql`)

Wzór 1:1 z `011_health_normalized.sql` (defensywność wobec `NULL`/nieobecnych kolekcji, `ON CONFLICT (id)
DO NOTHING`, idempotentne; `owner_id` prywatnych z **kolumny `user_id` wiersza `user_workspace_states`**,
nigdy z JSON), i **prościej — jedna kolekcja, bez guardów sierot** (brak FK/dzieci):

1. `CREATE TABLE IF NOT EXISTS subscriptions` + `subscription_mutations` + indeksy.
2. **Subskrypcje wspólne**: `jsonb_array_elements(ws.data->'advanced'->'subscriptions')` → `subscriptions`
   (`household_id = ws.household_id`, `owner_id = COALESCE(hm.user_id, h.created_by)` z `LEFT JOIN
   household_members hm ON hm.user_id::text = rec->>'ownerId'`, `visibility` z clampem do
   `household`/`private` z fallbackiem `household`, `amount_minor = COALESCE((rec->>'amountMinor')::bigint, 0)`
   z clampem `>= 0`, `currency`/`cycle`/`status` z clampem do dozwolonych wartości — fallback
   `PLN`/`monthly`/`active`, `next_payment = (rec->>'nextPayment')::date`, `payer = COALESCE(rec->>'payer','')`,
   `reminder_days = LEAST(365, GREATEST(0, COALESCE((rec->>'reminderDays')::integer, 1)))` — **default 1**
   dla parytetu z dawnym fallbackiem workera, `color = COALESCE(NULLIF(rec->>'color',''),'#397763')`,
   `cancel_url = NULLIF(rec->>'cancelUrl','')`, `name`/`category` z fallbackiem non-empty). Wzór: „Leki:
   wspólne" w `011`.
3. **Subskrypcje prywatne**: `jsonb_array_elements(uws.data->'advanced'->'subscriptions')` z
   `household_id = uws.household_id`, `owner_id = uws.user_id`, `visibility='private'`. **Bez ujawnienia.**
4. **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data #- '{advanced,subscriptions}',
   revision = revision + 1 WHERE data->'advanced' ? 'subscriptions'` oraz analogicznie `user_workspace_states`
   (`updated_at = now()`; ta tabela nie ma `revision`). Bump `revision` wymusza czysty refetch u klientów
   (wzór `011`).

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/012_subscriptions_normalized.sql` (**nowy**) — kolejny numer po
  `011_health_normalized.sql`. `CREATE TABLE` dwóch tabel + indeksy + migracja danych (wspólne + prywatne,
  **bez** guardów sierot) + wycięcie z JSONB. Wzorzec: `server/migrations/011_health_normalized.sql`.
- `src/subscriptionsTypes.ts` (**nowy**) — przenieś interfejs `Subscription` z `src/advancedTypes.ts`
  (`:41-54`); **dodaj `version: number` i `updatedAt: string`**. Nadal rozszerza `SharedMeta` (zachowuje
  `ownerId`/`visibility` — jak `healthTypes.ts`). Importuje `Visibility`/`CurrencyCode`/`SharedMeta` z
  `./financeTypes`. Wspólne źródło prawdy backend/frontend (wzór `src/healthTypes.ts`).
- `src/advancedTypes.ts` — usuń interfejs `Subscription` (`:41-54`) i pole `subscriptions` z interfejsu
  `AdvancedData` (`:65`); dodaj re-eksport `export type { Subscription } from "./subscriptionsTypes"` (wzór
  linii `:13`/`:23`/`:28` dla trips/car/pets). Po wycięciu w `AdvancedData` zostają `householdMembers`/
  `householdName`/`hideAmounts`. `AdvancedDataWithHealth = AdvancedData` (`:73`) — zostaje jak jest (alias
  zgodności).
- `src/lib/schema.ts` — usuń `subscriptions` z `advancedDataSchema` (`:488`, zostanie
  `{ householdMembers, householdName, hideAmounts }`); przebuduj `subscriptionSchema` (`:280-293`) —
  **zachowaj `sharedMetaSchema`**, dodaj `version: recordVersion` + `updatedAt: timestamp` — do walidacji
  snapshotu i persystencji nowego store'u (wzór: `healthAppointmentSchema`/`petSchema` z `version`).
  Zaanotuj typem `z.ZodType<Subscription>` importowanym z `./subscriptionsTypes` (parytet z pozostałymi
  schematami modułów; dodaj import). **Uwaga na `backupEnvelopeV2Schema`** (`:494-503`): używa
  `advancedDataSchema` — po wycięciu Subskrypcji backupy przestają je zawierać (parytet z Finansami/…/
  Zdrowiem, które już wypadły z tego schematu).

### Backend (warstwa backend)

- `server/src/subscriptions.mjs` (**nowy**) — analogicznie do `server/src/health.mjs`: walidatory payloadów
  per `op`, `resolveOwnerId`, `resolveVersionConflict`, `normalizeRequired/OptionalVersion`,
  `normalizeOptionalText` (dla `cancelUrl`), prymitywy `isCurrency`/`isCycle`/`isStatus`/`isReminderDays`/
  `isCancelUrl`, maper wiersz→DTO, `readSubscriptionsSnapshot`, `applySubscriptionMutation`,
  `resetSubscriptionsForUser`, `SUPPORTED_SUBSCRIPTION_OPS`, `assertSubscriptionMutationShape`,
  `MAX_SUBSCRIPTION_MUTATIONS_*`. Reużywa `resolveConflictOrError`/`resolveConflictOrGone`/`resolveOwnerId`
  (wzorce z `health.mjs`), `query`/`transaction` z `db.mjs`. **Bez importu z `src/`**. **Bez**
  cascade/resolve-visibility/sprawdzania rodzica.
- `server/src/server.mjs` — dodaj importy z `./subscriptions.mjs` (obok `./health.mjs`, `:43-50`); dodaj
  `GET /api/v1/subscriptions`, `POST /api/v1/subscriptions/mutations`, `POST /api/v1/subscriptions/reset`
  (kopiuj strukturę bloków pets `:893-934` — używają `session.user_id` w scope'ie; te same reużycia
  `requireHousehold`/`transaction`/`httpError`/cap batcha).
- `server/src/workspace.mjs` — usuń `"subscriptions"` z `META_COLLECTIONS` (`:10`, zostanie **`[]`**) i z
  `ADVANCED_COLLECTIONS` (`:20`, zostanie `["householdMembers"]`) — to automatycznie wyłącza ją z
  `splitWorkspaceData`/`mergeWorkspaceData` i `workspaceDocumentIsValid`. `CHILD_RELATIONS` jest już pusty
  `{}` — bez zmian. Zaktualizuj komentarz nagłówka pliku (`:1-9`), dopisując Subskrypcje do listy modułów
  wyciętych z JSONB, i komentarz o pustym `META_COLLECTIONS` (patrz „Ryzyka" — pusta tablica degraduje pętle
  META do no-op, `householdMembers` dalej płynie jako metadana przez `mergeWorkspaceData` i `ADVANCED_COLLECTIONS`).
- `server/src/worker.mjs` — dodaj `subscriptionReminders(householdId, nowKey)` (odczyt z SQL, bez joina, z
  `visibility`/`owner_id`, `reminderDays`-owy offset i okno 7 dni) i wywołuj ją w głównej pętli obok
  `healthAppointmentReminders`/`medicationReminders` (`:411-438`) z targetowaniem `deliverReminder(workspace,
  reminder, targetUserId)`; usuń pętlę `subscriptions` z `derivedReminders` (`:152-169`); dodaj prune
  `subscription_mutations` (`:359`).

### Frontend (warstwa frontend)

- `src/store/useSubscriptionsStore.ts` (**nowy**) — dedykowany store z optymistycznymi mutacjami, kolejką
  `pendingMutations`, `version` per rekord, cichym rebase'em `.update`. Wzór: `useHealthStore.ts`/
  `usePetsStore.ts`. Reużyj `parseArrayField`/`safeLocalStorage`/`quarantineRawValue`/`reportStorageWarning`
  (z `lib/safeStorage`) i `generateId` (z `lib/id`).
- `src/hooks/useSubscriptionsSync.ts` + `src/server/SubscriptionsSync.tsx` (**nowe**) — silnik sync +
  nieblokujący provider. Wzór: `useHealthSync.ts` / `HealthSync.tsx` (+ `apiRequest`/`ApiError` z
  `src/server/api.ts`).
- `src/store/useAdvancedStore.ts` — usuń stan `subscriptions` (import typu `Subscription` `:13`, schematu
  `subscriptionSchema` `:11`), akcje `addSubscription`/`updateSubscription`/`deleteSubscription` (interfejs
  `:42-44`, impl `:56-72`), pole z `merge` (`:89,102,115-121`) i `partialize` (`:123-128`) oraz z
  `exportAdvancedData` (`:133-141`). Po wycięciu store trzyma już tylko `householdMembers`/`householdName`/
  `hideAmounts` + `toggleHideAmounts`/`replaceAdvancedData`/`resetAdvancedData`.
- `src/pages/SubscriptionsPage.tsx` — podmień importy akcji i selektora `subscriptions`
  (`useAdvancedStore` → `useSubscriptionsStore`, `:95,97-99`); `hideAmounts` (`:96`) **zostaje** w
  `useAdvancedStore`; `currentOwnerId` (`:94`) dalej z `useServerAuth`. Zmień import typu (`Subscription`,
  `CurrencyCode`, `Visibility`) — mogą dalej iść z `../advancedTypes` (re-eksport) albo wprost z
  `../subscriptionsTypes` (`Subscription`). **Bez zmian w JSX/layoutcie/modalach/`renew`/`togglePause`.**
- `src/pages/TodayPage.tsx` — podmień `subscriptions` (`:104`) z `useAdvancedStore` na
  `useSubscriptionsStore`; `nextSubscription` (`:201-203`) i kafelek „Subskrypcje"/„Najbliższe odnowienie"
  (`:547-559`) bez zmian logiki. `hideAmounts` (`:110`) zostaje w `useAdvancedStore`. UX niezmieniony.
- `src/components/CommandPalette.tsx` — podmień `subscriptions` (`:121`) z `useAdvancedStore` na
  `useSubscriptionsStore`; wpis nawigacyjny (`:78`), wyniki wyszukiwania (`:227-236`) i zależność `useMemo`
  (`:312`) bez zmian.
- `src/server/WorkspaceSync.tsx` — usuń `subscriptions: []` z `replaceWithEmptyWorkspace` (`:49`).
- `src/server/AuthGate.tsx` — zamontuj `<SubscriptionsSync>` wewnątrz `<HealthSync>` (`:373-378`); dodaj
  import `useSubscriptionsStore` (`:27`), reset w `bindLocalStorageTo`/`clearLocalUserData` (`:68-112`) +
  `safeRemoveStorageItem("puls-subscriptions")`, oraz `useSubscriptionsStore().pendingMutations` w
  `hasUnsyncedChanges` (`:122-129`).
- `src/pages/SettingsPage.tsx` — w „Wyczyść dane aplikacji" dodaj
  `await apiRequest("/api/v1/subscriptions/reset", { method: "POST", json: {} })` obok pets/health (`:190`)
  i `resetSubscriptionsData()` obok `resetHealthData()` (`:223`); usuń `subscriptions: []` z lokalnego
  `replaceAdvancedData` (`:212-217`, zostanie `{ householdName, hideAmounts, householdMembers }`). Dodaj
  import `useSubscriptionsStore` (obok `useHealthStore` `:56`).
- `src/data/advancedData.ts` — usuń seed `subscriptions` z `createAdvancedData()` (`:22-99`); serwer jest
  źródłem prawdy (domyślny stan offline = pusty), analogicznie do wycięcia seedu car/pets/health. Zostawia
  `householdName`/`hideAmounts`/`householdMembers`. Dopisz komentarz nagłówkowy (jak dla car/pets/health).

### Nawigacja/routing — BEZ zmian

`src/types.ts` (`ViewId` z `"subscriptions"`), `src/components/Layout.tsx` (wpis `navigation` + `titles`),
`src/App.tsx` (`lazy` import `SubscriptionsPage` `:24-25`, `viewIds` `:48`, render `:223`) — **nie ruszamy**,
trasa/zakładka „Subskrypcje" zostaje. Zmienia się wyłącznie warstwa danych pod stroną. (Weryfikacja: brak
odwołań do samego pola `subscriptions` w `Layout.tsx`/`App.tsx`/`types.ts` — tylko `ViewId`/routing.)

### Testy (aktualizacja + nowe)

- Aktualizacja: `src/store/useAdvancedStore.test.ts` (usuń przypadki Subscription CRUD — wyszukać
  `[Ss]ubscription`), `server/test/workspace.node.mjs` (`META_COLLECTIONS` = **puste**, `ADVANCED_COLLECTIONS`
  = `["householdMembers"]`; split/merge/`workspaceDocumentIsValid` bez `subscriptions`), `src/lib/schema.test.ts`
  (jeśli waliduje `advancedData` z subskrypcjami), `src/App.test.tsx`, `src/server/AuthGate.test.tsx` (liczba
  zagnieżdżonych providerów sync +1).
- Nowe: `src/store/useSubscriptionsStore.test.ts` (optymistyczne mutacje, wersje, kolejka; prywatność w
  payloadzie; idempotencja: retry z tym samym kluczem nie dubluje; `conflict` per rekord z cichym rebase'em;
  `renew`/`togglePause` jako absolutne update-y); `server/test/subscriptions.node.mjs` (walidatory w tym
  `isCurrency`/`isCycle`/`isStatus`/`isReminderDays`/`isCancelUrl`, `resolveVersionConflict`, `owner_id` z
  sesji niezależnie od payloadu, scope widoczności w konfliktach, idempotencja retry, reset per-user nie
  rusza prywatnych innych domowników, push targetowany per widoczność — okno 7 dni, offset `reminderDays`).

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do `subscriptions`
      w `AdvancedData`/`advancedDataSchema`/`useAdvancedStore`/`WorkspaceSync`.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane testy generyczne bez Subskrypcji; nowy
      `useSubscriptionsStore.test.ts` (optymistyczne mutacje, wersje, kolejka, idempotencja: retry z tym
      samym kluczem nie dubluje; `conflict` per rekord z cichym rebase'em).
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (puste
      `META_COLLECTIONS`, bez Subskrypcji w split/merge i `workspaceDocumentIsValid`); nowy
      `server/test/subscriptions.node.mjs` (opis wyżej).
- [ ] Migracja `012` na bazie z istniejącymi Subskrypcjami w JSONB (w tym prywatnymi): rekordy trafiają do
      tabeli z zachowanym `id`/`ownerId`/`visibility`/znacznikami czasu i wartościami pól (`amountMinor`,
      `nextPayment`, `reminderDays`, `cancelUrl`), `data->'advanced'` nie zawiera już `subscriptions`,
      dwukrotne uruchomienie nie duplikuje, prywatne pozostają prywatne (nie ujawnione).
- [ ] `npm run preview` (także wąski ekran, PWA): dodanie/edycja/„Oznacz odnowienie"/„Wstrzymaj"–„Wznów"/
      usunięcie subskrypcji; przełącznik „Tylko ja/Domownicy"; filtry statusu; kafelek „Subskrypcje" na
      „Dzisiaj"; wyszukiwarka (Command Palette) — działają identycznie jak przed zmianą.
- [ ] Offline → online: mutacje bez sieci kolejkują się i zapisują po powrocie; retry tej samej kolejki nie
      tworzy duplikatów.
- [ ] Dwa „urządzenia": równoległa edycja **różnych** rekordów przechodzi bez konfliktu; równoległa edycja
      **tego samego** rekordu ze starą wersją zwraca konflikt tylko dla niego (cichy rebase), reszta batcha
      przechodzi.
- [ ] Worker wysyła push z nowej tabeli: „Nadchodzi płatność: &lt;name&gt;" (`reminderDays` dni przed
      `nextPayment`, o `09:00`, `status <> 'cancelled'`, okno 7 dni) — dla rekordu wspólnego do wszystkich
      domowników, dla prywatnego tylko do właściciela; prefiks `subscription:` niezmieniony (brak kolizji
      dedup).
- [ ] Po wdrożeniu: aktualizacja tabeli priorytetów w `docs/DATA_MODEL_MIGRATION.md` — wiersz „Subskrypcje"
      status „Zaplanowane po Zdrowiu" → „✅ Zrobione (PR #NN)" z faktycznym numerem PR; ewentualna sekcja
      „Status po wdrożeniu" z lukami znalezionymi w E2E (jak w planach Finansów/Auta/Zdrowia).

## Ryzyka

- **Regresja pushu subskrypcji.** Wycięcie Subskrypcji z JSONB **psuje** przypomnienie, jeśli nie
  zaktualizujemy `worker.mjs`. Rekordy mają widoczność — błędne targetowanie ujawniłoby prywatną
  subskrypcję całemu gospodarstwu. Szczególna pułapka: okno dostawy jest 7-dniowe (`withinDeliveryWindow` bez
  trzeciego argumentu), a offset to **per-rekord `reminderDays`**, nie stała jak w Aucie (-14 dni) czy
  Zdrowiu (-24 h) — trzeba czytać `reminder_days` z wiersza i shiftować `-days*24*60`. Prefiks `subscription:`
  i `time: "09:00"`/`date: next_payment` muszą zostać 1:1 (dedup `occurrence`). Pokryć weryfikacją audytorium
  (wszyscy vs właściciel), offsetu i częstotliwości.
- **Pusty `META_COLLECTIONS` po wycięciu.** Subskrypcje są **ostatnią** pozycją w `META_COLLECTIONS` — po
  usunięciu staje się `[]`. `splitWorkspaceData`/`mergeWorkspaceData` iterują je przez pętle `for…of`, które
  degradują do no-op na pustej tablicy (parytet z pustym `CHILD_RELATIONS` po Zwierzętach). `householdMembers`
  dalej płynie jako **metadana** (jest w `ADVANCED_COLLECTIONS`, ustawiana w `mergeWorkspaceData` z kontekstu,
  usuwana z `sharedAdvanced` w `splitWorkspaceData`), więc dokument advanced dalej działa dla metadanych
  gospodarstwa. **Zweryfikować** `workspace.node.mjs`: dokument z samym `householdMembers`/`householdName`/
  `hideAmounts` (bez żadnej kolekcji użytkownika) przechodzi split→merge round-trip i `workspaceDocumentIsValid`.
  Nie usuwać machinerii advanced — jest wciąż potrzebna dla metadanych.
- **`visibility` edytowalne w UI (klasa regresji „goal visibility" z Finansów).** Modal edycji subskrypcji
  pozwala zmienić `visibility` po utworzeniu (`SubscriptionsPage.tsx:530-541`, `updateSubscription`). Jeśli
  pominiemy `visibility` w `SUBSCRIPTION_UPDATE_KEYS`, to **regresja** (luka #1 ze „Status po wdrożeniu"
  Finansów). Plan **włącza** `visibility` do kluczy edycji. Brak kaskady (nie ma dzieci) — zmiana dotyka
  tylko własnego wiersza.
- **Prywatność w konfliktach i snapshotcie.** Zapytania diagnostyczne konfliktów muszą nieść ten sam filtr
  `(visibility='household' OR owner_id=$user)` co write (inaczej wyciek prywatnego rekordu w odpowiedzi
  konfliktu). **Brak** wariantu `EXISTS`/kaskady — łatwo skopiować z `health.mjs` niepotrzebny kod
  rodzica/dziecka; Subskrypcje są płaskie, każdy rekord filtruje po swoim wierszu.
- **`reset` per-user, nie bezwarunkowy.** Subskrypcje mają rekordy prywatne — `resetSubscriptionsForUser`
  kasuje wspólne + wyłącznie prywatne wywołującego (wzór `resetHealthForUser`/`resetPetsForUser`).
  Skopiowanie bezwarunkowego resetu (jak trips/meals) nuknęłoby prywatne rekordy innych domowników.
- **`renew`/`togglePause` to update-y absolutne, nie prawdziwe toggle.** W odróżnieniu od
  `toggleMedicationTaken` (flip względem bazy) liczą **absolutne** wartości (`advancePayment` z bieżącego
  `nextPayment`, `status` z jawnego mapowania) i idą przez `subscription.update` z OCC. Cichy rebase konfliktu
  reaplikuje deltę `{ nextPayment, status }`/`{ status }` na świeży rekord — bezpieczne (sety absolutne, brak
  hazardu podwójnego flipu). Idempotencja klucza chroni retry. Nie modelować dedykowanej mutacji.
- **Backup/restore v2 przestaje zawierać Subskrypcje.** Usunięcie z `advancedDataSchema` sprawia, że
  `backupEnvelopeV2Schema` nie odtwarza już Subskrypcji ze starego backupu — parytet z Finansami/…/Zdrowiem
  (które już wypadły). Świadome; do odnotowania, nie do naprawy w tym PR.
- **Duży blast radius wycięcia** (`workspace.mjs`, `advancedTypes.ts`, `schema.ts`, `useAdvancedStore.ts`,
  `WorkspaceSync.tsx`, `advancedData.ts`, `AuthGate.tsx`, `SettingsPage.tsx`, `TodayPage.tsx`,
  `CommandPalette.tsx`, `worker.mjs` + testy) — łapane przez `tsc` (strict) i testy; robić atomowo
  dane → backend → frontend (`implement-layered`).
- **Spójność sync z resztą.** Usunięcie Subskrypcji z `ADVANCED_COLLECTIONS`/`workspaceDocumentIsValid` musi
  być zsynchronizowane z klientem (schemat + `replaceWithEmptyWorkspace`), inaczej `PUT /api/v1/workspace`
  zwróci `400 INVALID_WORKSPACE_SCHEMA`. Bump `revision` w migracji wymusza czysty refetch. Life (`useLifeStore`)
  zostaje nietknięte.
- **Ósmy wskaźnik `.sync-indicator`.** To będzie **ósmy** wskaźnik synchronizacji (workspace/finance/trips/
  meals/car/pets/health/subscriptions). Blokada kliknięć została już naprawiona `pointer-events: none` w
  `src/styles/server.css` (luka #2 ze „Status po wdrożeniu" Zdrowia) — nowy wskaźnik dziedziczy tę regułę,
  więc **nie** wymaga osobnej naprawy. Kosmetyczne wizualne nakładanie stosu na wąskim ekranie pozostaje
  (znane, poza zakresem — pełne rozwiązanie objęłoby wszystkie moduły).

## Pytania do doprecyzowania

Wszystko rozstrzygnięte w prompcie/ustaleniach z użytkownikiem (decyzje 1–4 z „Ustaleń") i przez parytet ze
Zdrowiem/Zwierzętami — **brak genuine otwartych pytań**. Kluczowe decyzje, które mogłyby wyglądać na otwarte,
są **rozstrzygnięte**:

- **Zakres: wyłącznie `subscriptions`, jedna tabela, bez dzieci, bez rozszerzania** — potwierdzone przez
  użytkownika. Rozstrzygnięte.
- **Worker: dedykowana `subscriptionReminders` z SQL, targetowana per widoczność** (wzór `carDeadlineReminders`),
  usunięcie pętli `subscriptions` z `derivedReminders`, prefiks `subscription:` i okno 7 dni / offset
  `reminderDays` zachowane 1:1. Rozstrzygnięte.
- **`FinanceTransaction.source = "subscription"` zostaje wolnostojącym stringiem bez FK** — żadnej
  migracji/linkowania (parytet z `"trip"`/`"car"`). Rozstrzygnięte.
- **`prywatność` z `owner_id`/`visibility`, `reset` per-user, `visibility` edytowalne w update** —
  rozstrzygnięte parytetem z Health/Pets.
- **Default `reminder_days` w migracji = 1** (defensywnie, dla rekordów bez pola — parytet z dawnym
  fallbackiem workera; kolumna i tak jest `NOT NULL`, a UI zawsze ustawia wartość). Rozstrzygnięte jako
  detal migracji, nie otwarte.

## Status po wdrożeniu

Zaimplementowano warstwami (dane → backend → frontend, `implement-layered`) + osobny etap testów.
Zweryfikowano end-to-end przeciw prawdziwemu Postgresowi (lokalny klaster, nie mocki):

- `npm run build`, `npm test` (192/192), `npm run test:server` — **z lokalnym Postgresem podpiętym**
  (216/216, w tym wszystkie 72 testy DB-backed w `subscriptions.node.mjs`/innych, które w środowisku
  bez bazy są pomijane) — zielone.
- Migracja `012` uruchomiona od zera (razem z `001`-`011`) na czystej bazie bez błędów.
- Pełny cykl CRUD ręcznie w przeglądarce (Playwright, prawdziwy backend + realna sesja): dodanie
  (widoczność „Domownicy") → weryfikacja wiersza w Postgresie (`amount_minor`, `visibility`, `version`)
  → „Oznacz odnowienie" → „Wstrzymaj"/"Wznów" → edycja (zmiana widoczności na „Tylko ja", stat
  „Współdzielone" poprawnie spada do 0) → usunięcie (z potwierdzeniem `window.confirm`) → wiersz
  faktycznie znika z tabeli. Każda mutacja: `200` na `POST /api/v1/subscriptions/mutations` + kolejny
  `GET` hydratujący, zero błędów w konsoli, zero requestów `4xx/5xx`.
  Kafelek „Subskrypcje" na stronie Dzisiaj i wynik w Command Palette (szukanie „Spotify") również
  potwierdzone na żywych danych z nowego store'u. Formularz dodawania sprawdzony też przy 375px
  (mobile/PWA) — poprawny układ jednokolumnowy.
- **Znalezisko poza zakresem tego PR-a (nie naprawione tutaj)**: `useAdvancedStore.ts`'s `merge()`
  ma fałszywie pozytywny toast „Zapis modułów miał niezgodny format" przy KAŻDYM zupełnie czystym
  `localStorage` (brak klucza `puls-advanced-dashboard`), bo guard `!persistedState` traktuje
  `undefined` (pierwsze uruchomienie) tak samo jak realnie uszkodzony JSON — brakuje osobnej gałęzi
  `persistedState === undefined` (wzór już zastosowany w innych store'ach, np. `useCarStore.ts`, wg
  własnego komentarza w kodzie). Potwierdzone jako **pre-existing na `main`** (`git show
  33e1932:src/store/useAdvancedStore.ts`), niezwiązane z migracją Subskrypcji — `useAdvancedStore` nie
  jest nawet częścią zakresu tego modułu. Zgłoszone użytkownikowi do osobnej naprawy.
- Bez nowych luk specyficznych dla Subskrypcji znalezionych podczas E2E (w odróżnieniu od planu
  Finansów, który znalazł trzy).
