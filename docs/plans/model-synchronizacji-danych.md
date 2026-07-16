# Model synchronizacji danych — znormalizowane Finanse

> Plan wygenerowany przez skill `/plan-feature`. Slug: `model-synchronizacji-danych`. Branch: `claude/data-sync-model-0llqse` (istniejący branch zadania — NIE `feature/model-synchronizacji-danych`).

## Kontekst / Problem

Dziś każdy moduł Puls 2.0 to fragment jednego dużego dokumentu JSONB w Postgresie:
`workspace_states` (wspólne gospodarstwa) i `user_workspace_states` (prywatne per użytkownik).
Cały dokument jest zapisywany jednym `PUT /api/v1/workspace` z oczekiwaną rewizją; niezgodna
rewizja zwraca globalne `409`, a klient scala trójstronnie po `updatedAt`
(`src/server/workspaceMerge.ts`, `server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`).

Model działa dobrze przy obecnej skali, ale ma dwie strukturalne wady przy wielu domownikach
edytujących równolegle:

1. **Konflikt jest globalny dla całego dokumentu.** Dwie osoby zmieniające zupełnie różne rzeczy
   (jedna transakcję, druga notatkę) i tak wpadają w tę samą rewizję i muszą przechodzić przez
   scalanie 3-way.
2. **Brak semantyki domenowej.** Salda kont są przechowywane jako pole, więc dwie równoległe
   transakcje na to samo konto to konflikt tego samego pola `balanceMinor`, mimo że operacja
   „dodaj kwotę do salda" jest z natury addytywna i przemienna.

`docs/ARCHITECTURE.md` (sekcje „Synchronizacja" i „Dalsza ewolucja") sam wskazuje docelowy kierunek:
*„Przy bardzo intensywnej edycji przez wiele osób docelową ewolucją są mutacje domenowe
i znormalizowane tabele z idempotency keys"* oraz pierwszym punktem roadmapy: *„Znormalizowane
finanse, import batches i reguły kategoryzacji"*. `docs/IMPROVEMENT_IDEAS.md` (sekcja „Co zmienić",
punkt 1) potwierdza Finanse jako najbardziej naturalnego pilota.

Efekt docelowy: moduł Finanse przestaje być częścią dokumentu JSONB. Zamiast tego ma znormalizowane
tabele SQL, mutacje domenowe z kluczami idempotencji generowanymi po stronie klienta oraz optymistyczną
kontrolę współbieżności per rekord (własna kolumna `version`). UI/UX Finansów pozostaje identyczne dla
użytkownika — to refaktor warstwy danych, nie redesign.

## Wymagania

Funkcjonalne:

- Dane finansowe (konta, transakcje, budżety, cele oszczędnościowe) przechowywane w znormalizowanych
  tabelach SQL, nie w JSONB `workspace_states`/`user_workspace_states`.
- Każda mutacja domenowa (dodanie/edycja/usunięcie/import) niesie **klucz idempotencji (UUID) generowany
  przez klienta**. Serwer trzyma tabelę wykonanych kluczy i przy retry z tym samym kluczem zwraca poprzedni
  wynik zamiast wykonać operację drugi raz.
- **Optymistyczna współbieżność per rekord**: każdy wiersz ma kolumnę `version`; mutacja z nieaktualną
  wersją dostaje konflikt **tylko dla tego rekordu**, inne równoległe zmiany innych rekordów przechodzą.
- Jednorazowa migracja SQL przenosi istniejące dane finansowe z JSONB do nowych tabel, zachowując `id`,
  właściciela prywatnych rekordów i znaczniki czasu, po czym **całkowicie usuwa** pola finance z dokumentu
  JSONB i z ogólnego mechanizmu sync (bez martwego fallbacku).
- Granica prywatne/wspólne zachowana: `visibility: private | household`, `owner_id` ustalany **z sesji**,
  nie z wartości klienta; transakcje dziedziczą prywatność konta (jak dziś w `CHILD_RELATIONS`).

Niefunkcjonalne:

- **Offline-first zachowany.** Mutacje muszą kolejkować się bez sieci i odtwarzać po powrocie online;
  klucze idempotencji sprawiają, że odtworzenie kolejki jest bezpieczne. Optymistyczny UI natychmiast
  pokazuje zmianę lokalnie.
- Widok Finansów wygląda i działa tak samo, także na wąskim ekranie (PWA).
- Reużycie istniejących wzorców: autoryzacja (`requireHousehold`), transakcje SQL (`transaction()`),
  handler błędów `23505 → 409`, `apiRequest`/`ApiError`, walidacja zod.

## Zakres i Non-goals

**W zakresie:**

- **Wyłącznie moduł Finanse** jako pilot: `finance_accounts`, `finance_transactions`, `finance_budgets`,
  `finance_goals` (cele oszczędnościowe) + tabela idempotencji `finance_mutations`.
- Nowe endpointy REST `/api/v1/finance/*`, nowy store frontendu i silnik synchronizacji finansów.
- Migracja danych i wycięcie finance z `workspace.mjs`/`advancedDataSchema`/`useAdvancedStore`.

**Non-goals (świadomie pomijamy):**

- **Żaden inny moduł nie jest ruszany.** Zadania, Kalendarz, Notatki, Rytuały, Podróże, Subskrypcje,
  Posiłki, Auto, Zdrowie, Zwierzęta zostają na modelu JSONB `workspace_states` / generyczny sync.
  Nie budujemy generycznej „platformy sync" na wyrost — kod idempotencji/wersjonowania piszemy czytelnie,
  ale w kontekście Finansów (YAGNI).
- **Bez redesignu UI Finansów.** Ten sam layout, te same modale, te same komunikaty. Zmienia się tylko
  warstwa danych pod spodem.
- **Bez zmiany logiki biznesowej Finansów** poza tym, co wymusza normalizacja: reguła unikalności nazwy
  budżetu ignorująca walutę (`docs/KNOWN_ISSUES.md`, IMPROVEMENT_IDEAS punkt 4) **zostaje jak jest** —
  to osobny pomysł, nie mieszamy.
- **`hideAmounts` zostaje w `useAdvancedStore`** i dalej synchronizuje się przez `user_workspace_states`
  jako osobista preferencja UI — to nie jest rekord domenowy Finansów, nie przenosimy go do tabel.
- **Brak nowych funkcji Finansów** (edycja/usuwanie konta, edycja transakcji itd. — dziś ich nie ma
  w UI, więc endpointy modelują dokładnie obecny zestaw mutacji; miejsce na rozszerzenie zostawiamy
  w projekcie, ale go nie implementujemy).
- **Brak „reguł cyklicznych" w Finansach** — w obecnym module ich nie ma (subskrypcje to osobny moduł
  poza zakresem). Zakres domeny Finanse = konta + transakcje + budżety + cele.

## Podejście

### Decyzje zakresu (podjęte z góry — twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe cztery decyzje podjął główny agent na podstawie best
practice i YAGNI i traktujemy je jako ustalone:

1. **Zakres: tylko Finanse (pilot).** Bez spekulatywnej ogólności dla przyszłych modułów.
2. **Migracja: pełna migracja SQL + całkowite zastąpienie.** Po migracji finance znika z JSONB; brak
   zamrożonego fallbacku (repo nie trzyma shimów wstecznej kompatybilności).
3. **Idempotency keys: klient generuje UUID per mutacja.** Serwer deduplikuje po kluczu z retencją.
4. **Konflikty: optimistic concurrency per rekord** przez kolumnę `version`; konflikt zwracany tylko dla
   konkretnego rekordu.

### Model tabel (Postgres)

Kolumna `id` jest typu `text` (nie `uuid`), żeby migracja zachowała istniejące identyfikatory 1:1
(klient generuje je przez `crypto.randomUUID()`, ale schemat dopuszcza legacy stringi do 200 znaków —
patrz `idSchema` w `src/lib/schema.ts`). Nowe rekordy tworzy klient z UUID; serwer waliduje unikalność.

`owner_id uuid REFERENCES users(id)` przechowuje przypisanego właściciela (dla prywatnych — użytkownik
z sesji; dla wspólnych — twórca). Salda kont zmieniamy **przyrostowo** (delta), nie read-modify-write.

- **`finance_accounts`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users`, `visibility text NOT NULL CHECK (visibility IN ('private','household'))`,
  `name text NOT NULL`, `type text NOT NULL CHECK (type IN ('checking','savings','cash','credit'))`,
  `balance_minor bigint NOT NULL DEFAULT 0`, `currency char(3) NOT NULL`, `color text NOT NULL`,
  `archived boolean NOT NULL DEFAULT false`, `version integer NOT NULL DEFAULT 1`,
  `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`,
  `updated_by uuid REFERENCES users(id)`.
  Indeksy: `(household_id)`, `(household_id, visibility)`, `(owner_id)`.
- **`finance_transactions`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `account_id text NOT NULL REFERENCES finance_accounts(id) ON DELETE CASCADE`, `owner_id uuid NOT NULL REFERENCES users`,
  `visibility text NOT NULL CHECK (...)`, `booked_on date NOT NULL`, `amount_minor bigint NOT NULL`,
  `currency char(3) NOT NULL`, `merchant text NOT NULL DEFAULT ''`, `title text NOT NULL`,
  `category text NOT NULL`, `source text NOT NULL CHECK (source IN ('manual','csv','subscription','trip','car'))`,
  `fingerprint text`, `notes text`, `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  Indeksy: `(household_id)`, `(account_id)`, `(household_id, booked_on DESC)`.
  **Dedup importu CSV** przez częściowy indeks unikalny: `UNIQUE (household_id, fingerprint) WHERE fingerprint IS NOT NULL`.
  (Fingerprint już zawiera `accountId` — patrz `src/lib/csvImport.ts:222` — więc zakres household odpowiada
  obecnej globalnej deduplikacji po wartości fingerprintu w `importTransactions`.)
- **`finance_budgets`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `category text NOT NULL`, `limit_minor bigint NOT NULL CHECK (limit_minor >= 0)`, `currency char(3) NOT NULL`,
  `color text NOT NULL`, `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
  **Bez `owner_id`/`visibility`** — `FinanceBudget` nie ma `SharedMeta`, budżety są zawsze wspólne.
  **Nie** dodajemy uniq na `category` — unikalność (ignorująca walutę) zostaje po stronie endpointu, żeby
  nie zmieniać obecnego zachowania (KNOWN_ISSUES #4 jest poza zakresem).
- **`finance_goals`**: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
  `owner_id uuid NOT NULL REFERENCES users`, `visibility text NOT NULL CHECK (...)`, `name text NOT NULL`,
  `target_minor bigint NOT NULL CHECK (target_minor >= 0)`, `saved_minor bigint NOT NULL CHECK (saved_minor >= 0)`,
  `currency char(3) NOT NULL`, `deadline date`, `version integer NOT NULL DEFAULT 1`, `created_at`, `updated_at`, `updated_by`.
- **`finance_mutations`** (idempotencja + lekki audyt): `idempotency_key uuid PRIMARY KEY`,
  `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`, `user_id uuid NOT NULL REFERENCES users`,
  `op text NOT NULL`, `result jsonb NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`.
  Indeks `(created_at)` do retencji. **Retencja**: rekordy starsze niż 30 dni usuwane okresowo
  (dołączamy prune do pętli workera — patrz niżej). Klucz jest `PRIMARY KEY`, więc `INSERT ... ON CONFLICT
  (idempotency_key) DO NOTHING` naturalnie wykrywa retry.

### Wersjonowanie i saldo (klucz projektu)

- `version` odzwierciedla **tylko edycje własnych pól opisowych** rekordu (rename konta, zmiana limitu
  budżetu, edycja celu). Update robimy: `UPDATE ... SET ..., version = version + 1 WHERE id=$ AND household_id=$
  AND version=$baseVersion RETURNING *`. `rowCount = 0` → konflikt: zwracamy aktualny rekord + jego `version`.
- **Zmiana salda konta z tytułu transakcji to delta, nie konsumuje tokenu OCC konta.** `transaction.create`
  robi w jednej transakcji SQL: `INSERT` transakcji **oraz** `UPDATE finance_accounts SET balance_minor =
  balance_minor + $amount, updated_at = now() WHERE id=$account` (bez zmiany `version` konta, bez `baseVersion`).
  Dzięki temu dwie równoległe transakcje na to samo wspólne konto **obie przechodzą** (addytywność) —
  to główny zysk normalizacji wskazany w ARCHITECTURE.md. `transaction.delete` odwraca saldo
  (`- amount_minor`) **z wyjątkiem `source = 'csv'`** (import nie modyfikował salda — parytet z obecnym
  `deleteTransaction`). `transaction.import` (CSV) nie rusza salda w ogóle.

### Endpointy REST — jeden batch mutacji + snapshot

Rozważane alternatywy: (a) osobny endpoint REST per encja/akcja, (b) jeden batch endpoint mutacji.
Wybieramy **(b)** bo mapuje się 1:1 na offline queue klienta (drenaż kolejki = jeden request),
daje jednolitą obsługę idempotencji i pozwala zwrócić konflikt **per pojedyncza mutacja** zamiast jednego
globalnego `409` (wymóg #4). To wciąż kod specyficzny dla Finansów (nazwy `op` są finansowe), nie
generyczna platforma.

- **`GET /api/v1/finance`** → snapshot widoczny dla użytkownika: `{ accounts[], transactions[], budgets[],
  goals[] }`, każdy rekord z polem `version`. Serwer filtruje po widoczności: wspólne całego gospodarstwa
  + prywatne, których `owner_id = session.user_id`. (Analogicznie do `mergeWorkspaceData`, ale z SQL WHERE.)
- **`POST /api/v1/finance/mutations`** → body `{ mutations: Mutation[] }`, uporządkowana lista.
  `Mutation = { idempotencyKey: uuid, op, payload, baseVersion? }`. Wspierane `op`:
  `account.create`, `account.update`, `transaction.create`, `transaction.import`, `transaction.delete`,
  `budget.create`, `budget.update`, `budget.delete`, `goal.create`, `goal.update`, `goal.delete`.
  Serwer przetwarza mutacje po kolei, każdą w `transaction()`:
  1. `INSERT INTO finance_mutations ... ON CONFLICT (idempotency_key) DO NOTHING`. Jeśli klucz istniał →
     zwróć zapisany `result` (`status: "duplicate"`), nie wykonuj operacji.
  2. Waliduj payload (współdzielony walidator, patrz `finance.mjs`). `owner_id`/`household_id` **z sesji**,
     nigdy z klienta. Dla `transaction.create` dziedzicz `visibility` z konta, jeśli klient nie ustawił inaczej.
  3. Wykonaj SQL (create/update-z-OCC/delete-z-OCC/import-z-dedup + delta salda).
  4. Zapisz `result` do `finance_mutations` i zwróć.
  Odpowiedź: **HTTP 200** z `{ results: [{ idempotencyKey, status: "applied" | "duplicate" | "conflict",
  record?, currentVersion? }], serverAt }`. `status: "conflict"` niesie aktualny rekord+wersję dla
  danej mutacji; reszta mutacji w batchu wykonuje się normalnie. (Globalny `409` rezerwujemy tylko dla
  błędów całego żądania: brak sesji, przekroczony limit rozmiaru.)
  Limit rozmiaru body: własny, rozsądny cap (np. `MAX_FINANCE_MUTATIONS` sztuk / bajtów), niezależny od
  `MAX_WORKSPACE_BYTES`.

### Frontend — dedykowany store + silnik sync (offline-first)

- **`src/store/useFinanceStore.ts` (nowy)** — Zustand + `persist` (localStorage, klucz np. `puls-finance`),
  reużywa `safeLocalStorage`/wzorca `merge`/`parseArrayField` z `useAdvancedStore.ts`. Trzyma:
  `accounts/transactions/budgets/goals` (każdy z `version`) + kolejkę wychodzących mutacji
  `pendingMutations[]` (z `idempotencyKey`, `op`, `payload`, `baseVersion`). Akcje zachowują **te same
  nazwy i sygnatury** co dziś (`addAccount`, `addTransaction`, `importTransactions`, `deleteTransaction`,
  `addBudget`, `updateBudget`, `deleteBudget`, `addSavingsGoal`, `updateSavingsGoal`, `deleteSavingsGoal`),
  żeby `FinancePage.tsx` zmienił się minimalnie. Każda akcja: (1) optymistycznie modyfikuje stan lokalny
  (w tym deltę salda dla transakcji — logika przenoszona 1:1 z obecnego store), (2) generuje
  `idempotencyKey = crypto.randomUUID()` (`generateId()`), dokłada mutację do `pendingMutations` z aktualnym
  `baseVersion` rekordu, (3) wyzwala flush.
- **`src/hooks/useFinanceSync.ts` + `src/server/FinanceSync.tsx` (nowe)** — silnik wzorowany na
  `WorkspaceSync.tsx`: przy montażu `GET /api/v1/finance` (hydratacja store), potem drenaż `pendingMutations`
  przez `POST /api/v1/finance/mutations`. Obsługa wyników: `applied`/`duplicate` → zdejmij z kolejki,
  wczytaj autorytatywny rekord+wersję; `conflict` → wczytaj aktualny rekord z odpowiedzi, zrebase lokalnej
  zmiany (dla update: reaplikuj zmianę na świeżej wersji albo pokaż stan „scalono"; dla delete: jeśli rekord
  już zniknął, potraktuj jako sukces). Nasłuch `online`/`focus`/`visibilitychange` do wznowienia
  (reużyj wzorca z `WorkspaceSync`). Wskaźnik stanu jak `sync-indicator`. **Provider jest nieblokujący** —
  renderuje dzieci od razu, a `FinancePage` czyta gotowość ze store (finanse to jedna podstrona, nie
  blokujemy całej apki).
- **Montaż**: w `src/server/AuthGate.tsx` obok `WorkspaceSync` (ten sam `key`/`scope`), np.
  `<WorkspaceSync ...><FinanceSync ...>{children}</FinanceSync></WorkspaceSync>`.

### Odróżnianie prywatne/wspólne bez `workspace_states`

Serwer nie polega już na `splitWorkspaceData`/`mergeWorkspaceData` dla finansów. Zamiast tego:
`owner_id` i `visibility` są kolumnami; `owner_id` zawsze ustawiany z `session.user_id` przy tworzeniu
prywatnego rekordu (klient nie może go podmienić). Snapshot filtruje: `WHERE household_id = $1 AND
(visibility = 'household' OR owner_id = $2)`. Transakcje prywatnego konta: przy `account.update` na
`visibility='private'` można kaskadowo domknąć widoczność dzieci (opcjonalnie), ale prościej i zgodnie
z obecnym modelem — transakcja niesie własne `visibility`/`owner_id` ustawiane przy tworzeniu (dziś UI
dziedziczy je z konta w formularzu). Zachowujemy to: `transaction.create` bez jawnego `visibility`
dziedziczy z konta.

### Decyzje z rundy doprecyzowania (sesja non-interactive)

Jak w decyzjach zakresu powyżej — brak żywego użytkownika do zadania tych pytań, więc rozstrzygnięto
je zasadą parytetu z obecnym zachowaniem i YAGNI (do weryfikacji w review PR):

1. **Retencja kluczy idempotencji: 30 dni, bez zmian.** `finance_mutations` to okno deduplikacji retry,
   nie log audytowy — nic w repo (KNOWN_ISSUES, ARCHITECTURE) nie wskazuje wymogu dłuższego audytu
   operacji finansowych. Jeśli taka potrzeba się pojawi, to osobny feature (audit log), nie ten refaktor.
2. **Konflikt edycji tego samego rekordu: cichy rebase, bez modala.** Dzisiejszy generyczny sync scala
   3-way po cichu, bez informowania użytkownika o scaleniu — Non-goals wymaga braku redesignu UX, więc
   nowy silnik robi to samo: `conflict` → pobierz świeży rekord, reaplikuj lokalną zmianę pola na świeżej
   wersji, wyślij ponownie z nowym `baseVersion`. Bez toastów/dialogów o konflikcie.
3. **Brak seeda demo dla nowego gospodarstwa.** Serwer jest źródłem prawdy (ryzyko w planie już to
   zaznacza) — nowe gospodarstwo startuje z pustymi Finansami, tak jak dziś realnie startuje pusta baza
   (`createAdvancedData()` to tylko lokalny fallback offline, nie ma odpowiednika w DB). Dodanie trybu
   prezentacyjnego to osobny, nie zamawiany feature.

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/006_finance_normalized.sql` (**nowy**) — kolejny numer po `005_push_retry.sql`.
  (1) `CREATE TABLE` dla `finance_accounts`, `finance_transactions`, `finance_budgets`, `finance_goals`,
  `finance_mutations` + indeksy (styl `IF NOT EXISTS` jak w `001_initial.sql`). (2) **Migracja danych**:
  dla każdego gospodarstwa przenieś `data->'advanced'->'financeAccounts'|'financeTransactions'|'savingsGoals'`
  z `workspace_states` (wspólne) i z `user_workspace_states` (prywatne, `owner_id = user_id` tej tabeli),
  oraz `financeBudgets` tylko z `workspace_states`, przez `jsonb_array_elements` + `->>` do kolumn.
  `owner_id` rozwiązuj bezpiecznie: `LEFT JOIN household_members hm ON hm.user_id::text = rec->>'ownerId'`,
  `COALESCE(hm.user_id, h.created_by)` (legacy `ownerId` typu `"me"`/`"anna"`/stale → fallback na twórcę
  gospodarstwa). `version` startuje na 1, `updated_at` z `rec->>'updatedAt'` (fallback `now()`),
  `created_at` = `updated_at`. (3) **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data
  #- '{advanced,financeAccounts}' #- '{advanced,financeTransactions}' #- '{advanced,financeBudgets}'
  #- '{advanced,savingsGoals}', revision = revision + 1` oraz analogicznie `user_workspace_states`
  (bez budżetów). Bump `revision` wymusza refetch u podłączonych klientów. Migracja jednorazowa,
  idempotentna dzięki `schema_migrations` (runner `server/src/migrate.mjs`).
- `src/advancedTypes.ts` — usuń `financeAccounts/financeTransactions/financeBudgets/savingsGoals`
  z interfejsu `AdvancedData`. Przenieś typy `FinanceAccount`, `FinanceTransaction`, `FinanceBudget`,
  `SavingsGoal`, `Visibility`, `CurrencyCode`, `SharedMeta` do nowego `src/financeTypes.ts` (albo zostaw
  w miejscu i tylko re-eksportuj) i **dodaj `version: number`** do każdego z czterech typów finansowych.
- `src/lib/schema.ts` — usuń finance z `advancedDataSchema` (`financeAccounts`, `financeTransactions`,
  `financeBudgets`, `savingsGoals`). Zachowaj/przenieś zod-schematy finansowe (z dodanym `version`) do
  walidacji snapshotu i persystencji nowego store'u.

### Backend (warstwa backend)

- `server/src/finance.mjs` (**nowy**) — analogicznie do `workspace.mjs`: **czyste, testowalne** funkcje
  (walidatory payloadów per `op`, `resolveVersionConflict(baseVersion, currentVersion)`, mapowanie
  wiersz→DTO, wymuszenie `owner_id` z sesji, dziedziczenie widoczności transakcji z konta) **oraz** funkcje
  wykonujące SQL na przekazanym `client` (`readFinanceSnapshot(client, householdId, userId)`,
  `applyFinanceMutation(client, ctx, mutation)`). Reużywa `query`/`transaction` z `db.mjs`.
- `server/src/server.mjs` — nowe route handlery: `GET /api/v1/finance` i `POST /api/v1/finance/mutations`.
  Reużyj `requireHousehold(request)`, `transaction()`, `audit()`, handler `23505 → 409` (już jest),
  `httpError`. Dodaj walidator id typu `text` (analog `assertUuidParam`, ale dla `idSchema`: string 1..200,
  bezpieczny charset) oraz cap rozmiaru batcha. Nagłówki bezpieczeństwa/CSRF (`onRequest` origin check)
  działają automatycznie dla nowych endpointów.
- `server/src/workspace.mjs` — usuń finance z `META_COLLECTIONS` (`financeAccounts`, `financeTransactions`,
  `savingsGoals`), z `CHILD_RELATIONS` (`financeTransactions`) i z `ADVANCED_COLLECTIONS`
  (`financeAccounts`, `financeTransactions`, `financeBudgets`, `savingsGoals`). Zaktualizuj
  `workspaceDocumentIsValid`, żeby nie wymagał już tych kolekcji. **Weryfikacja**: worker
  (`server/src/worker.mjs`) czyta z `data.advanced` tylko `subscriptions/trips/vehicleDeadlines/
  healthAppointments/petVisits/medications` — finansów **nie** dotyka, więc wycięcie ich jest bezpieczne
  dla powiadomień (potwierdzone).
- `server/src/worker.mjs` — dodaj do istniejącej pętli okresowy prune retencji:
  `DELETE FROM finance_mutations WHERE created_at < now() - interval '30 days'` (lekki, opcjonalny;
  worker i tak ma interwał).

### Frontend (warstwa frontend)

- `src/store/useFinanceStore.ts` (**nowy**) — dedykowany store finansów z optymistycznymi mutacjami,
  kolejką `pendingMutations` (klucze idempotencji) i `version` per rekord (opis w „Podejście").
- `src/hooks/useFinanceSync.ts` + `src/server/FinanceSync.tsx` (**nowe**) — silnik synchronizacji
  (hydratacja snapshotem, drenaż kolejki, obsługa `applied`/`duplicate`/`conflict`, offline/online,
  wskaźnik stanu). Reużyj wzorców z `src/server/WorkspaceSync.tsx` i `apiRequest`/`ApiError` z
  `src/server/api.ts`.
- `src/store/useAdvancedStore.ts` — usuń finance ze stanu, akcji (`addAccount`, `addTransaction`,
  `importTransactions`, `deleteTransaction`, `addBudget`, `updateBudget`, `deleteBudget`, `addSavingsGoal`,
  `updateSavingsGoal`, `deleteSavingsGoal`), z `partialize`, `merge` i `exportAdvancedData`.
  **Zostaw `hideAmounts` i `toggleHideAmounts`** (osobista preferencja, dalej przez workspace).
- `src/pages/FinancePage.tsx` — podmień import finansów z `useAdvancedStore` na `useFinanceStore`
  (nazwy akcji bez zmian → diff minimalny). `hideAmounts`/`toggleHideAmounts` dalej z `useAdvancedStore`.
  `currentOwnerId` dalej z `useServerAuth().snapshot`. Bez zmian w JSX/layoutcie.
- `src/server/WorkspaceSync.tsx` — usuń finance z `localData()` i z `replaceWithEmptyWorkspace()`.
- `src/server/AuthGate.tsx` — zamontuj `<FinanceSync>` obok `WorkspaceSync` (ten sam `scope`).
- `src/data/advancedData.ts` — usuń seed finance z `createAdvancedData()` (serwer jest źródłem prawdy;
  domyślny stan offline finansów = pusty). Ewentualny seed demo można przenieść do defaultu finance store,
  ale nie jest wymagany.

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do finance
      w `AdvancedData`/`advancedDataSchema`/`useAdvancedStore`.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane: `useAdvancedStore.test.ts` (bez finance),
      `workspaceMerge.test.ts`, `schema.test.ts`, `App.test.tsx`, `WorkspaceSync.test.tsx`;
      nowe: `useFinanceStore.test.ts` (optymistyczne mutacje, delta salda, wersje, kolejka),
      `useFinanceSync` (idempotencja: retry z tym samym kluczem nie dubluje; `conflict` per rekord).
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (bez finance
      w split/merge i liście `workspaceDocumentIsValid`); nowy `server/test/finance.node.mjs`: walidatory,
      `resolveVersionConflict`, `owner_id` z sesji (klient nie może podmienić), dziedziczenie widoczności
      transakcji, kształt wyniku idempotencji, addytywność salda (dwie transakcje na to samo konto nie
      konfliktują).
- [ ] Migracja `006` uruchamia się na bazie z istniejącymi danymi finance w JSONB i po niej: rekordy są
      w tabelach z zachowanym `id`/`owner_id`/kwotami, a `data->'advanced'` nie zawiera już pól finance;
      uruchomienie migracji dwa razy nie duplikuje (idempotencja runnera).
- [ ] Manualnie w `npm run preview` (także na wąskim ekranie, PWA): dodanie transakcji aktualizuje saldo,
      edycja/usunięcie budżetu, dodanie/edycja celu, import CSV z deduplikacją, przełącznik „Ukryj kwoty"
      działają identycznie jak przed zmianą.
- [ ] Offline → online: mutacje wykonane bez sieci kolejkują się i po powrocie online zapisują się na
      serwerze; ponowne wysłanie tej samej kolejki (retry) nie tworzy duplikatów (klucze idempotencji).
- [ ] Dwa „urządzenia": równoległa edycja **różnych** rekordów przechodzi bez konfliktu; edycja **tego
      samego** rekordu ze starą wersją zwraca konflikt tylko dla niego, reszta batcha przechodzi.

## Ryzyka

- **Duży rozmiar zmiany / powierzchnia.** Wycięcie finance dotyka `workspace.mjs`, `advancedTypes.ts`,
  `schema.ts`, `useAdvancedStore.ts`, `WorkspaceSync.tsx`, `advancedData.ts` + wiele testów. Ryzyko
  martwych referencji łapane przez `tsc` (strict) i testy — rób zmianę atomowo (typy → backend → frontend).
- **Migracja danych produkcyjnych.** Seed `createAdvancedData()` jest **tylko po stronie klienta**
  (localStorage), nie w bazie — DB `workspace_states` startuje jako `{}` (bootstrap). Realne dane finance
  trafiają do DB dopiero gdy klient zsynchronizuje swój dokument. Migracja musi być defensywna: kolekcje
  mogą być `NULL`/nieobecne, a `owner_id` może być legacy stringiem (`"me"`) → `COALESCE` na twórcę
  gospodarstwa. Przetestować na kopii danych (`pg_dump`) przed wdrożeniem.
- **Granica prywatne/wspólne.** `owner_id` musi pochodzić z sesji (nie z klienta) — inaczej można by
  przypisać prywatny rekord innej osobie. Egzekwować w `finance.mjs` i pokryć testem (jak
  `workspace.node.mjs` robi dla merge/split dziś).
- **Wersjonowanie salda.** Kluczowa subtelność: delta salda z transakcji **nie** może konsumować OCC konta,
  inaczej równoległe transakcje na wspólne konto fałszywie konfliktują. Utrzymać `version` tylko dla edycji
  pól opisowych konta. Pokryć testem addytywności.
- **Spójność z resztą sync.** Usunięcie finance z `workspaceDocumentIsValid`/`ADVANCED_COLLECTIONS` musi być
  zsynchronizowane z klientem (schemat + `localData()`), inaczej `PUT /api/v1/workspace` zacznie zwracać
  `400 INVALID_WORKSPACE_SCHEMA` albo klient wyśle nieoczekiwane pola. Bump `revision` w migracji wymusza
  czysty refetch. Reszta modułów (Zadania, Podróże, ...) zostaje nietknięta w tym samym dokumencie.
- **Unikalność budżetu (KNOWN_ISSUES #4).** Świadomie **nie** dodajemy DB-owego uniq na `category` i nie
  zmieniamy walidacji — zachowujemy obecne (ignorujące walutę) zachowanie, żeby nie mieszać z osobnym
  pomysłem poprawkowym.
- **Kolejność drenażu offline.** Mutacje zależne (np. `transaction.create` po `account.create` tego samego
  konta) muszą zachować kolejność w kolejce; batch wysyłamy uporządkowany, serwer przetwarza sekwencyjnie.

## Pytania do doprecyzowania

Brak otwartych pytań — patrz „Podejście → Decyzje z rundy doprecyzowania (sesja non-interactive)"
wyżej. Trzy pytania biznesowe rozstrzygnięto zasadą parytetu z obecnym zachowaniem; do ewentualnej
korekty w review PR.

## Status po wdrożeniu

Zaimplementowano zgodnie z planem (dane → backend → frontend), zweryfikowano end-to-end przez
Playwright na realnym Postgresie (bootstrap, dodanie konta/transakcji, saldo, persystencja po
reloadzie z wyczyszczonym `localStorage`). Podczas weryfikacji znaleziono i naprawiono trzy luki,
których ten plan nie przewidział:

1. **Edycja widoczności celu oszczędnościowego.** Plan założył (Non-goals), że endpointy modelują
   dokładnie dzisiejszy zestaw mutacji UI — ale przeoczył, że `FinancePage.tsx`'s modal edycji celu
   POZWALA zmienić `visibility` istniejącego celu, i to działało w modelu JSONB. `GOAL_UPDATE_KEYS`
   w `finance.mjs` (i odpowiednik w `useFinanceStore.ts`) rozszerzono o `visibility` — to nie jest
   nowa funkcja, tylko naprawa regresji względem dzisiejszego zachowania.
2. **`POST /api/v1/finance/reset`** (nowy endpoint, nieprzewidziany w planie). "Wyczyść dane
   aplikacji" w Ustawieniach dziś czyści cały dokument JSONB jednym `PUT /api/v1/workspace` — po
   normalizacji nie ma już czym nadpisać finansów. Dodano dedykowany endpoint usuwający rekordy
   wspólne + wyłącznie prywatne rekordy wywołującego (nigdy prywatne rekordy innych domowników),
   analogicznie do dotychczasowego zakresu. Pokryty testem DB (`finance.node.mjs`).
3. **Fałszywe ostrzeżenie "niezgodny format" na czystej instalacji** w `useFinanceStore.ts`: zustand
   wywołuje `merge()` bezwarunkowo nawet gdy dany klucz nigdy nie istniał w `localStorage`
   (pierwsze uruchomienie), co bez poprawki pokazywało użytkownikowi mylący komunikat o uszkodzonych
   danych finansowych zaraz po założeniu konta. Naprawiono w `useFinanceStore.ts`.

**Odkryto też (poza zakresem tego PR):** identyczny wzorzec błędu #3 istnieje już dziś w
`useAdvancedStore.ts` i `useLifeStore.ts` (`merge(undefined, ...)` na czystej instalacji też tam
pokazuje fałszywe "niezgodny format"/"dane miały niezgodny format"). To pre-existing bug niezwiązany
z modelem synchronizacji Finansów — wart osobnego zgłoszenia, nie naprawiany w tym PR.
