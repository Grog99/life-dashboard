# Migracja modułu Life (Zadania/Kalendarz/Przypomnienia/Notatki/Nawyki) na znormalizowany model SQL

> Plan wygenerowany przez skill `/plan-feature`. Slug: `zadania-kalendarz-notatki-nawyki-sql`. Branch: `claude/data-model-migration-plan-blejhl`.
>
> Kontynuacja serii migracji z `docs/DATA_MODEL_MIGRATION.md` (moduł #7, **ostatni zaplanowany**). **To SIÓDMA
> migracja wg tego samego wzorca** — pilot Finansów (PR #11) ustalił kształt, po nim Podróże (PR #13), Lista
> zakupów/Meals (PR #14), Auto/Car (PR #15), Zwierzęta/Pets (PR #16), Zdrowie/Health (PR #17) i Subskrypcje
> (PR #18, NAJŚWIEŻSZY analog płaskiej kolekcji z `visibility`).
>
> **Świadoma decyzja, nie odkrycie luki.** Life **nie ma** dowodu (a) (pole agregujące read-modify-write) ani
> (b) (realna częsta kolizja edycji) z `docs/DATA_MODEL_MIGRATION.md`. Przeciwnie — tracker (wiersz #7 + sekcja
> „Moduły bez dowodu") wprost odnotowuje, że każdy rekord jest edytowany niezależnie po `id`, a dzisiejszy
> 3-way merge po `id` (`src/server/workspaceMerge.ts`) już dziś zachowuje niezależne zmiany różnych zadań/
> wydarzeń bez realnej kolizji. Migrujemy **wyłącznie** z decyzji użytkownika z 17.07.2026 o ujednoliceniu
> architektury (wszystkie moduły → SQL), jawnie uchylając YAGNI z punktu 4 „Zasad kontynuacji". To nota, nie
> uzasadnienie techniczne.
>
> **To NAJWIĘKSZY i architektonicznie ODMIENNY moduł serii.** W odróżnieniu od modułów „advanced"
> (Finance/Trips/Meals/Car/Pets/Health/Subscriptions), Life **nie żyje** w dokumencie `advanced`/
> `useAdvancedStore` — żyje w części `life` dokumentu JSONB, w osobnym store `src/store/useLifeStore.ts` (583
> linie), synchronizowanym przez `src/server/WorkspaceSync.tsx` (nie przez dedykowany silnik sync jak moduły
> advanced). Tracker wprost zaznaczył to jako **otwarte pytanie**: „plan powinien zweryfikować, czy wzorzec
> Finansów w ogóle przenosi się wprost". **Zweryfikowano w kodzie — przenosi się, ale z trzema istotnymi
> różnicami**, których żaden wcześniejszy moduł nie miał (patrz „Czym Life RÓŻNI SIĘ" niżej).
>
> **Wzorce referencyjne — siedem zmergowanych migracji:**
> - **Subskrypcje/Health (PR #18/#17, NAJBLIŻSZE analogi — płaskie kolekcje z `visibility` per rekord,
>   worker targetowany per widoczność, `owner_id`/`visibility` z sesji, `version` per rekord, cichy rebase
>   `*.update`)**: `docs/plans/subskrypcje-sql.md`, `docs/plans/zdrowie-sql.md`, `server/src/health.mjs`,
>   `server/src/subscriptions.mjs`, `server/migrations/011_health_normalized.sql`,
>   `server/migrations/012_subscriptions_normalized.sql`, `src/healthTypes.ts`, `src/store/useHealthStore.ts`,
>   `src/hooks/useHealthSync.ts`, `src/server/HealthSync.tsx`, `server/test/health.node.mjs`. **Struktura
>   backendu/frontendu/migracji przenosi się prawie 1:1**, tylko z 5 kolekcjami zamiast 3 i z trzema polami
>   specjalnymi (`recurrence`/`series_*`, `completed_dates`, `notified_at`).
> - **Auto/Car (PR #15, wzorzec workera per widoczność bez joina rodzica + cichy rebase `isUpdateOp`/
>   `upsertByUpdateOp` w `useCarStore.ts`)**: `docs/plans/auto-car.md`, `server/src/car.mjs`.
> - **Finanse (PR #11, model warstwy prywatne/wspólne)**: `server/src/finance.mjs` (`resolveOwnerId`,
>   `resetFinanceForUser`).
> - **Silnik powtarzalności (Wariant A)**: `docs/plans/zadania-wydarzenia-powtarzalne.md`,
>   `src/lib/recurrence.ts` (`expandSeries`, `occurrenceDate`, `buildSeriesOccurrence`, `SERIES_WINDOW`) —
>   ZOSTAJE po stronie klienta, patrz „Decyzje ustalone z góry" #6.

## Kontekst / Problem

Moduł Life to dziś część `life` dokumentu JSONB (`workspace_states` / `user_workspace_states`),
synchronizowana generycznym mechanizmem `PUT/GET /api/v1/workspace` (globalna rewizja + 3-way merge po `id`,
`server/src/workspace.mjs`, `src/server/WorkspaceSync.tsx`, `src/server/workspaceMerge.ts`). Kolekcje
(`LIFE_COLLECTIONS` w `server/src/workspace.mjs:25`): **`tasks`, `events`, `reminders`, `notes`, `habits` —
to PIĘĆ płaskich, niezależnych kolekcji** (tracker nazywa wiersz „Zadania/Kalendarz/Notatki/Nawyki", ale
kolekcji jest 5, nie 4 — `reminders` to osobna kolekcja bez własnej podstrony, powierzchowana w `TodayPage`/
`Layout`/`useReminderEngine`/`QuickAddModal`).

Teraz — z decyzji użytkownika o ujednoliceniu architektury (`docs/DATA_MODEL_MIGRATION.md`, aktualizacja
17.07.2026) — przenosimy **wszystkie 5 kolekcji razem, w jednym planie / jednej migracji SQL / jednym PR**
(potwierdzone przez użytkownika; największy dotychczasowy moduł) na znormalizowane tabele SQL: mutacje
domenowe z kluczami idempotencji generowanymi po stronie klienta i optymistyczną kontrolę współbieżności per
rekord (kolumna `version`). Zachowujemy rozróżnienie prywatne/wspólne — **każda z 5 kolekcji ma dziś
`visibility` + `ownerId`** (zweryfikowane, patrz „Model prywatności per kolekcja" niżej).

### KLUCZOWE: co ZOSTAJE w JSONB, a co odchodzi (weryfikacja z kodu)

`useLifeStore` trzyma **9 pól**: 5 kolekcji **+ 4 pola osobiste** (`scratchpad`, `intention`, `energy`,
`preferences`; `server/src/workspace.mjs:24` `PERSONAL_LIFE_KEYS`). **Pola osobiste NIE są kolekcjami** —
nie mają `id`, nie mają `version`, nie mają struktury rekordu, a ich synchronizacja opiera się w całości na
3-way merge dokumentu JSONB (nie mają per-pole `updatedAt`, więc nie da się ich przenieść na model rekordowy
bez osobnej strategii). Do tego dokument JSONB dalej niesie `advanced` (metadane gospodarstwa +
`hideAmounts`). **Wniosek: dokument JSONB workspace i `WorkspaceSync` ZOSTAJĄ** — dla 4 pól osobistych i
metadanych. To fundamentalna różnica względem modułów advanced, gdzie wycięcie kolekcji zbliżało dokument do
pustki. Tu wycinamy **tylko 5 kolekcji z `life`**; `life` dokumentu dalej istnieje z samymi skalarami.

Efekt docelowy: 5 kolekcji Life dostaje znormalizowane tabele SQL + dedykowany store (`useLifeRecordsStore`)
+ silnik sync (`useLifeRecordsSync`/`LifeRecordsSync`), dokładnie jak Zdrowie/Subskrypcje. `useLifeStore`
zostaje **odchudzony do 4 pól osobistych** (nadal na JSONB przez `WorkspaceSync`). **UI/UX wszystkich
podstron pozostaje identyczne** — zmienia się tylko warstwa danych (import akcji/selektorów z nowego store'u
zamiast z `useLifeStore`).

### Czym Life RÓŻNI SIĘ od Zdrowia/Subskrypcji (istotne dla nakładu — trzy komplikacje, których nikt wcześniej nie miał)

Struktura jest tym samym płaskim, wielokolekcyjnym wzorcem co Zdrowie (3 niezależne tabele → tu 5), z tymi
samymi prymitywami (`owner_id`/`visibility`/`version`, OCC per rekord, cichy rebase, worker per widoczność).
Nowe względem Zdrowia są **trzy pola/mechanizmy specjalne** (sekcja „Projekt pól specjalnych"):

1. **Powtarzalność (`recurrence`/`seriesId`/`seriesIndex`) na `tasks`/`events`.** Materializacja okna
   wystąpień zostaje **po stronie klienta** (`src/lib/recurrence.ts`, Wariant A — decyzja użytkownika).
   `recurrence` (obiekt z zagnieżdżoną tablicą `weekdays`) trafia do **kolumny `jsonb`**, a `series_id`/
   `series_index` do zwykłych kolumn — **NIE** projektujemy osobnej tabeli `recurring_series`. Wystąpienie
   ma **deterministyczne `id` = `` `${seriesId}#${seriesIndex}` ``** — to jedyny moduł, w którym `id`
   rekordu NIE jest losowym UUID-em; kolizja `id` między urządzeniami jest **zamierzona** (idempotencja
   materializacji przez PK, patrz „Idempotencja deterministycznych `id`").
2. **`habit.completedDates` — tablica dat.** Toggle nawyku przelicza **całą tablicę lokalnie** i wysyła ją
   jako **absolutny set** (`habit.update { completedDates }`), jak `renew`/`togglePause` w Subskrypcjach —
   nie prawdziwy flip. Kolumna `jsonb`.
3. **`reminder.notifiedAt` — pole PISANE PRZEZ WORKERA.** To pierwszy moduł serii, w którym **worker mutuje
   znormalizowaną tabelę** (dziś worker zapisuje `notifiedAt` do `workspace_states` z guardem rewizji,
   `worker.mjs:497-501`). Po migracji worker robi `UPDATE reminders SET notified_at = now() … WHERE
   notified_at IS NULL` (bez bumpowania `version`), a klient też edytuje to pole (`snoozeReminder` czyści,
   `markReminderNotified` ustawia). Współdzielone pisanie klient/worker — patrz „Projekt pól specjalnych" i
   „Ryzyka".

Do tego worker ma **dwa** derived-reminery Life zależne od tych kolekcji: „Za 30 min: &lt;event&gt;"
(z `events`) i przypomnienia ręczne (z `reminders`). **Oba MUSZĄ zmigrować razem** (patrz „Non-goals" —
worker jest w zakresie), inaczej wycięcie `events`/`reminders` z JSONB psuje push.

## Wymagania

Funkcjonalne:

- Dane 5 kolekcji Life (`tasks`, `events`, `reminders`, `notes`, `habits`) w znormalizowanych tabelach SQL,
  nie w JSONB. Pięć niezależnych, płaskich kolekcji bez FK między sobą.
- Każda mutacja domenowa niesie **klucz idempotencji (UUID) generowany przez klienta**; serwer deduplikuje po
  kluczu (własna tabela `life_mutations`, retencja 30 dni — **nie** reużywamy `health_mutations` itd.).
- **Optymistyczna współbieżność per rekord** (`version`); konflikt zwracany tylko dla konkretnego rekordu,
  reszta batcha przechodzi. **Wszystkie** `*.update` używają OCC (brak wyjątku — brak pola agregującego typu
  `balanceMinor`/`mileage`).
- **Zachowanie prywatności per rekord**: wszystkie 5 tabel mają `owner_id`/`visibility`; `owner_id` zawsze
  **z sesji**, nigdy z payloadu. `visibility` jawnie wymagana na tworzeniu i **edytowalna** po utworzeniu
  (parytet z dzisiejszym `updateTask`/`updateEvent`/… i z `splitWorkspaceData`).
- **Powtarzalność zachowana 1:1** — materializacja okna po stronie klienta (`src/lib/recurrence.ts`), pola
  `recurrence`/`seriesId`/`seriesIndex` jako kolumny; deterministyczne `id` wystąpień; `addRecurringTask`/
  `addRecurringEvent`/`updateSeries`/`updateEventSeries`/`deleteSeries`/`deleteEventSeries`/
  `expandRecurringSeries` działają identycznie, produkując batch mutacji `*.create`/`*.update`/`*.delete`
  zamiast zapisu dokumentu.
- **4 pola osobiste (`scratchpad`/`intention`/`energy`/`preferences`) ZOSTAJĄ w JSONB** przez odchudzony
  `useLifeStore` + `WorkspaceSync`. **Nie ruszamy ich modelu synchronizacji.**
- Jednorazowa migracja SQL przenosi istniejące dane 5 kolekcji z JSONB (wspólne z `workspace_states`,
  prywatne z `user_workspace_states`) do nowych tabel z zachowaniem `id`/`ownerId`/`visibility`/znaczników
  czasu, wartości pól ORAZ pól serii/powtarzalności/`completedDates`/`notifiedAt`, po czym **całkowicie
  usuwa** 5 kolekcji z `life` w dokumencie JSONB. Rekordy prywatne migrują jako prywatne (bez ujawnienia).
- **Powiadomienia push działają dalej** — worker czyta z nowych tabel, z targetowaniem per widoczność
  (wspólna → wszyscy domownicy, prywatna → tylko właściciel):
  - **„Za 30 min: &lt;title&gt;"** (30 min przed `date`+`startTime`, okno 1 dzień) dla `events`, id
    `event:<id>`.
  - **Przypomnienia ręczne** (`reminders`, `!done && !notifiedAt && due`), id = **surowe `reminder.id` bez
    prefiksu** (parytet 1:1 z dzisiejszym `dueReminders`); po dostawie worker ustawia `notified_at`.
  - `tasks`/`notes`/`habits` **nie** generują push (bez zmian).

Niefunkcjonalne:

- **Offline-first zachowany** — mutacje kolejkują się bez sieci i bezpiecznie odtwarzają (idempotencja),
  optymistyczny UI natychmiast pokazuje zmianę lokalnie.
- Wszystkie podstrony (`TasksPage`/`CalendarPage`/`NotesPage`/`HabitsPage`/`TodayPage`) i komponenty
  (`QuickAddModal`/`CommandPalette`/`TaskItem`/`Layout`) wyglądają i działają tak samo, także na wąskim
  ekranie (PWA).
- Reużycie istniejących wzorców backendu i frontendu ze Zdrowia/Subskrypcji (patrz „Pliki do zmiany").

## Zakres i Non-goals

**W zakresie:**

- Moduł Life jako bounded context: `tasks`, `events`, `reminders`, `notes`, `habits` + tabela idempotencji
  `life_mutations`. **Wszystkie 5 kolekcji razem, jeden PR** (wiersz #7 trackera; potwierdzone przez
  użytkownika, że nie dzielimy na kilka PR-ów — dozwolone podfazy WEWNĄTRZ jednego PR, patrz „Podejście —
  podfazy").
- Nowe endpointy REST `/api/v1/life` (snapshot 5 kolekcji), `/api/v1/life/mutations` (batch),
  `/api/v1/life/reset`.
- Nowy store frontendu (`useLifeRecordsStore`) + silnik synchronizacji (`useLifeRecordsSync` /
  `LifeRecordsSync`), z całą logiką powtarzalności (przeniesioną z `useLifeStore`).
- **Odchudzenie `useLifeStore`** do 4 pól osobistych (`scratchpad`/`intention`/`energy`/`preferences`); dalej
  na JSONB przez `WorkspaceSync`.
- **Migracja danych historycznych** z JSONB (wspólne + prywatne) do nowych tabel, wycięcie 5 kolekcji z
  `life`.
- Aktualizacja workera (dwa dedykowane reminery Life czytające z SQL + targetowanie per widoczność,
  writeback `notified_at`, prune `life_mutations`); usunięcie `derivedReminders`/`deliverDerived`/
  `dueReminders`-owej ścieżki JSONB.
- Wycięcie 5 kolekcji z `workspace.mjs` (`LIFE_COLLECTIONS`), `lifeDataSchema`, `WorkspaceSync`
  (`replaceWithEmptyWorkspace`, `applyData`, `localData`, ekran migracji), `sampleData.ts`; podmiana importów
  w podstronach/komponentach/hookach.

**Non-goals (świadomie pomijamy — dopasowane do Life):**

- **Ścisła migracja 1:1 — bez nowych funkcji, bez zmiany UX/zachowania.** Endpointy modelują dokładnie
  dzisiejszy zestaw akcji `useLifeStore`. Żadnych nowych pól ani ekranów. **Bez** pełnego RRULE, `until`,
  edycji pojedynczego wystąpienia serii itd. (te były non-goals już w
  `docs/plans/zadania-wydarzenia-powtarzalne.md` i zostają nimi).
- **Pola osobiste (`scratchpad`/`intention`/`energy`/`preferences`) NIE migrują na SQL.** Zostają w JSONB —
  nie mają struktury rekordu ani per-pole `updatedAt`; przenoszenie ich byłoby budową singletonowej tabeli
  z osobną strategią konfliktów, poza mandatem tego modułu (YAGNI). Dokument JSONB workspace **zostaje**.
- **Powtarzalność zostaje po stronie klienta (Wariant A).** **Nie** projektujemy tabeli `recurring_series`;
  `recurrence` to kolumna `jsonb`, materializacja okna zostaje w `src/lib/recurrence.ts` (decyzja
  użytkownika). Backend jest pasywny wobec logiki serii — waliduje tylko kształt `recurrence`/`series_*` i
  zapisuje 1:1.
- **`worker.mjs` JEST w zakresie (nie follow-up).** Uzasadnienie z kodu: `events` napędza push „Za 30 min"
  (`worker.mjs:142-157` `derivedReminders`), a `reminders` napędza przypomnienia ręczne (`worker.mjs:109-122`
  `dueReminders` + writeback `:491-501` + prywatna pętla `:511-542`). Wycięcie tych kolekcji z JSONB **psuje
  oba pushe**, jeśli worker nie zmigruje razem. Dlatego worker migruje w tym samym PR — inaczej regresja
  powiadomień. (`tasks`/`notes`/`habits` nie mają pushu — dla nich worker jest bez zmian, bo i tak ich nie
  czyta.)
- **Żaden inny moduł nie jest ruszany** (wszystkie advanced już zmigrowane; pola osobiste zostają na JSONB).
  Nie budujemy generycznej „platformy sync"; **własna** tabela idempotencji `life_mutations`.
- **Zachowujemy prywatność** — pięć tabel z `owner_id`/`visibility`. Migracja **nie ujawnia** rekordów
  prywatnych (parytet z `011`/Health).
- **Bez redesignu UI.** Ten sam layout, te same modale i te same nazwy/sygnatury akcji store'u — żeby diff
  w podstronach był ograniczony do zmiany źródła importu.
- **Backup/restore v2 przestaje zawierać 5 kolekcji Life.** Świadomy, ale **istotny** koszt (patrz „Ryzyka"
  i „Pytania") — parytet z modułami advanced, które już wypadły z `backupEnvelopeV2Schema`.

## Podejście

### Decyzje ustalone z góry (twarde wymagania planu)

Sesja planowania jest non-interactive; poniższe podjęto na podstawie ustaleń z użytkownikiem, parytetu ze
Zdrowiem/Subskrypcjami, weryfikacji kodu i YAGNI — **rozstrzygnięte, nie otwarte**:

1. **Zakres: wszystkie 5 kolekcji naraz** (jeden plan, jedna migracja SQL, jeden PR): `tasks` + `events` +
   `reminders` + `notes` + `habits`. Kolekcje płaskie, bez relacji rodzic/dziecko.
2. **Migracja: pełna migracja SQL + całkowite zastąpienie** (po migracji 5 kolekcji znika z `life` w JSONB,
   brak shimów). **Pola osobiste zostają w JSONB.**
3. **Idempotency keys: klient generuje UUID per mutacja**, osobna tabela `life_mutations`.
4. **Konflikty: optimistic concurrency per rekord** przez `version` (dla wszystkich `*.update`/`*.delete`).
   **Bez żadnego wyjątku** — brak pola agregującego.
5. **Prywatność zachowana** — pięć tabel z `owner_id`/`visibility`; `owner_id` z sesji; `visibility` jawna na
   create, edytowalna na update. **Bez** dziedziczenia po rodzicu i **bez** kaskady (brak rodzica/dzieci).
6. **Powtarzalność zostaje po stronie klienta (Wariant A), przeniesiona do nowego store'u.** `recurrence`
   jako kolumna `jsonb`; `series_id`/`series_index` jako kolumny; deterministyczne `id` = `seriesId#index`.
   Materializacja okna (`expandSeries` itd.) bez zmian w `src/lib/recurrence.ts` — zmienia się tylko to, że
   store zamiast mutować dokument JSONB kolejkuje mutacje `*.create`/`*.update`/`*.delete`.
7. **`useLifeStore` odchudzony do 4 pól osobistych; nowy `useLifeRecordsStore` dla 5 kolekcji.** `WorkspaceSync`
   zostaje zamontowany (dla pól osobistych + `advanced`); `LifeRecordsSync` montowany obok (jak `HealthSync`).
8. **Worker w zakresie**: dwa reminery Life z SQL (`eventReminders`, `manualReminders`) + writeback
   `notified_at`; usunięcie ścieżki JSONB (`derivedReminders`/`deliverDerived`/`dueReminders`/pętla
   prywatna). Prefiks `event:` i **brak prefiksu** dla przypomnień ręcznych zachowane 1:1.

### Podfazy WEWNĄTRZ jednego PR (zarządzanie ryzykiem, `implement-layered`)

Jeden PR, ale implementacja warstwami z jawnym handoffem (skill `implement-layered`), a wewnątrz — kolejność
kolekcji od najprostszych do najbardziej „specjalnych", żeby wcześnie ustabilizować wzorzec:

- **Faza A — dane**: `src/types.ts` (+`version`), `src/lib/schema.ts` (schematy +`version`, trim
  `lifeDataSchema`), `server/migrations/013_life_normalized.sql` (5 tabel + `life_mutations` + migracja
  danych + wycięcie z JSONB).
- **Faza B — backend**: `server/src/life.mjs` (walidatory + `applyLifeMutation` + snapshot + reset), endpointy
  w `server/src/server.mjs`, wycięcie z `workspace.mjs`, worker.
- **Faza C — frontend**: `useLifeRecordsStore` (+ przeniesiona logika serii), `useLifeRecordsSync`/
  `LifeRecordsSync`, montaż w `AuthGate`, trim `useLifeStore`, podmiana importów w podstronach/komponentach,
  `WorkspaceSync`/`sampleData`.
- **Faza D — testy**: nowe `server/test/life.node.mjs`, `src/store/useLifeRecordsStore.test.ts`; aktualizacja
  istniejących (patrz „Testy").

Wewnątrz faz B/C sugerowana kolejność kolekcji: `notes` (najprostsza, brak pól specjalnych) → `habits`
(`completedDates`) → `reminders` (`notifiedAt` + worker) → `events` (recurrence + worker push) → `tasks`
(recurrence + najwięcej toggli). Nie jest to podział na PR-y — całość ląduje w jednym PR.

### Model prywatności per kolekcja (weryfikacja z kodu — nie założone z góry)

Użytkownik oddał to do zbadania. Zweryfikowano w `src/types.ts:52-116` i `src/store/useLifeStore.ts`:

- **`Task`** (`types.ts:52-53`): `ownerId?`, `visibility?`. `addTask` domyślnie `visibility:"private"`,
  `ownerId:"me"` (`useLifeStore.ts:117-118`). **Ma prywatność.**
- **`CalendarEvent`** (`types.ts:74-75`): `ownerId?`, `visibility?`. `addEvent` domyślnie `private`/`me`
  (`:269-270`). **Ma prywatność.**
- **`Reminder`** (`types.ts:89-90`): `ownerId?`, `visibility?`. `addReminder` domyślnie `private`/`me`
  (`:371-372`). **Ma prywatność** (potwierdza to prywatna pętla workera `:511-542` i targetowanie
  `targetUserId=user_id`).
- **`Note`** (`types.ts:103-104`): `ownerId?`, `visibility?`. `addNote` domyślnie `private`/`me` (`:429-430`).
  **Ma prywatność.**
- **`Habit`** (`types.ts:114-115`): `ownerId?`, `visibility?`. `addHabit` domyślnie `private`/`me` (`:470-471`).
  **Ma prywatność.**

**Wniosek: wszystkie 5 kolekcji mają `visibility`+`ownerId` per rekord** (dokładnie jak Health/Subscriptions).
Wszystkie 5 tabel dostają `owner_id`/`visibility`; snapshot filtruje `visibility='household' OR
owner_id=$user`; reset per-user (wspólne + własne prywatne). `splitWorkspaceData` (`workspace.mjs:137-145`)
już dziś dzieli te kolekcje po `visibility==='private'` i ustawia `ownerId` z sesji — model przenosi się 1:1.

### Model tabel (Postgres) — `server/migrations/013_life_normalized.sql`

Kolejny numer po `012_subscriptions_normalized.sql` (najwyższa istniejąca migracja). `id` typu `text` (PK) —
**wymagane** dla deterministycznych `id` wystąpień serii (`` `${seriesId}#${index}` `` zawiera `#`; `idSchema`
i serwerowy `isId` dopuszczają dowolny string 1–200 znaków). `updated_by uuid REFERENCES users(id)` jako
lekki audyt. Mapowanie typów jak w `health.mjs`: `date` przez `::text AS …` (uniknięcie strefowego
parsowania node-postgres), `timestamptz` (`updated_at`, `completed_at`, `notified_at`) przez `.toISOString()`
z `null → undefined` w DTO, `jsonb` (`recurrence`, `completed_dates`) czytane wprost. **Brak jakichkolwiek FK
między tabelami Life** — tylko FK do `households`/`users`.

Wszystkie 5 tabel: `id text PK`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`,
`owner_id uuid NOT NULL REFERENCES users(id)`, `visibility text NOT NULL CHECK (visibility IN
('private','household'))`, `version integer NOT NULL DEFAULT 1`, `created_at timestamptz NOT NULL DEFAULT
now()`, `updated_at timestamptz NOT NULL DEFAULT now()`, `updated_by uuid REFERENCES users(id)`. Indeksy na
każdej: `(household_id)`, `(household_id, visibility)`, `(owner_id)`.

- **`tasks`** (+ pola z `Task`): `title text NOT NULL`, `description text` (nullable),
  `status text NOT NULL CHECK (status IN ('todo','done'))`,
  `priority text NOT NULL CHECK (priority IN ('low','medium','high'))`, `date date` (nullable — `date?`),
  `time text` (nullable — clockTime `HH:MM`, `text` nie `time` dla parytetu i uniknięcia strefy),
  `estimated_minutes integer` (nullable, `> 0`), `category text NOT NULL`, `is_focus boolean NOT NULL`,
  `energy text NOT NULL CHECK (energy IN ('low','medium','high'))`, `completed_at timestamptz` (nullable),
  **`series_id text`** (nullable), **`series_index integer`** (nullable, `>= 0`),
  **`recurrence jsonb`** (nullable). Dodatkowy indeks `(household_id, series_id)` (dla `deleteSeries`/
  `updateSeries` po serii).
- **`events`** (+ pola z `CalendarEvent`): `title text NOT NULL`, `date date NOT NULL`,
  `start_time text NOT NULL`, `end_time text NOT NULL` (clockTime), `kind text NOT NULL CHECK (kind IN
  ('meeting','focus','personal'))`, `location text` (nullable), `notes text` (nullable),
  `source text CHECK (source IN ('manual','google'))` (nullable), `external_id text` (nullable),
  `external_updated_at text` (nullable — timestamp free-form, `text` z tej samej racji co `measuredAt` w
  Health: `z.string().refine(Date.parse)`, nie `isoDate`), **`series_id text`**, **`series_index integer`**,
  **`recurrence jsonb`** (wszystkie nullable). Dodatkowy indeks `(household_id, series_id)`.
- **`reminders`** (+ pola z `Reminder`): `title text NOT NULL`, `date date NOT NULL`, `time text NOT NULL`
  (clockTime), `done boolean NOT NULL DEFAULT false`, **`notified_at timestamptz`** (nullable —
  **pisane przez workera**, patrz „Projekt pól specjalnych"). Dodatkowy indeks częściowy do workera:
  `(household_id) WHERE done = false AND notified_at IS NULL`.
- **`notes`** (+ pola z `Note`): `title text NOT NULL`, `content text NOT NULL DEFAULT ''` (cap 100 000 w
  walidatorze, jak `noteSchema`), `color text NOT NULL CHECK (color IN ('cream','mint','sky','lilac'))`,
  `pinned boolean NOT NULL`.
- **`habits`** (+ pola z `Habit`): `name text NOT NULL`,
  `icon text NOT NULL CHECK (icon IN ('water','walk','read','stretch','meditate'))`,
  `target_label text NOT NULL`, **`completed_dates jsonb NOT NULL DEFAULT '[]'::jsonb`** (tablica iso-dat).
- **`life_mutations`** (idempotencja + lekki audyt, 1:1 jak `health_mutations`): `idempotency_key uuid
  PRIMARY KEY`, `household_id uuid NOT NULL REFERENCES households ON DELETE CASCADE`, `user_id uuid NOT NULL
  REFERENCES users(id)`, `op text NOT NULL`, `result jsonb NOT NULL`, `created_at timestamptz NOT NULL
  DEFAULT now()`. Indeks `(created_at)` do retencji.

> **Uwaga o nazwach tabel.** `tasks`/`events`/`reminders`/`notes`/`habits` to generyczne nazwy — zweryfikować
> w `server/migrations/`, że żadna wcześniejsza migracja ich nie zajęła (dziś to kolekcje JSONB, nie tabele,
> więc powinny być wolne). Gdyby kolidowały, prefiksować `life_` (`life_tasks` itd.) i zmapować w
> `SELECT`-ach — ale domyślnie zostają bez prefiksu (czytelniejsze, brak kolizji oczekiwany).

### Projekt pól specjalnych

- **`recurrence` → kolumna `jsonb` (nullable) na `tasks`/`events`; `series_id`/`series_index` → kolumny.**
  `Recurrence` to `{ freq, interval, weekdays?, count?, anchorDate, anchorTime? }` (`types.ts:28-35`) — obiekt
  z zagnieżdżoną tablicą `weekdays`, więc `jsonb` jest jedynym 1:1 mapowaniem (precedens: `pets.fishStock`
  jako `jsonb`). Walidator serwerowy `validateRecurrence` odzwierciedla `recurrenceSchema`
  (`src/lib/schema.ts:49-56`): `freq ∈ {daily,weekly,monthly}`, `interval` int `>= 1`, `weekdays?` tablica
  int 1–7 (min 1, tylko dla weekly), `count?` int `>= 1`, `anchorDate` isoDate, `anchorTime?` clockTime.
  Backend zapisuje `recurrence`/`series_id`/`series_index` **1:1 bez interpretacji** (materializacja jest po
  stronie klienta) — waliduje tylko kształt. `series_index` `>= 0` (`seriesIndexSchema`
  `z.number().int().min(0)`).
- **Idempotencja deterministycznych `id` (`` `${seriesId}#${index}` ``).** To jedyny moduł, w którym dwa
  urządzenia policzą **ten sam `id`** dla tego samego logicznego wystąpienia (`src/lib/recurrence.ts:104`,
  `buildSeriesOccurrence`). W modelu JSONB deduplikował to 3-way merge po `id`. W modelu SQL deduplikuje
  **PRIMARY KEY**: gdy drugie urządzenie wyśle `task.create` z już istniejącym `id`, `INSERT` rzuci `23505`
  → `resolveConflictOrError` zwróci `{ status:"conflict", record, currentVersion }` (kod `ID_TAKEN`).
  **Store traktuje `conflict` na `*.create` jak `applied`** — adoptuje zwrócony rekord serwera (wzór
  `reconcileTerminal` w `useHealthStore.ts:565-567`: „conflict na `*.create` (kolizja id) — zaadoptuj
  zwrócony rekord tak samo jak przy sukcesie"). Efekt: materializacja okna na dwóch urządzeniach zbiega się
  do tego samego zbioru wierszy, bez duplikatów — dokładnie parytet z dzisiejszym merge-po-`id`. **To
  krytyczny punkt do pokrycia testem** (dwa urządzenia rozwijają to samo okno → brak duplikatów).
- **`habit.completedDates` → kolumna `jsonb` (tablica iso-dat), toggle jako ABSOLUTNY set.**
  `toggleHabit(id, date)` (`useLifeStore.ts:447-460`) przelicza całą tablicę lokalnie (dodaje/usuwa datę) i
  wysyła `habit.update { completedDates: <cała tablica> }`. To **nie** prawdziwy flip (jak `lastTakenOn` w
  Health), tylko policzony lokalnie **set absolutny** (jak `renew`/`togglePause` w Subskrypcjach) — bezpieczny
  z OCC, bez hazardu podwójnego flipu. Walidator: tablica isoDate, cap długości (np. 5000 wpisów).
- **`reminder.notifiedAt` → kolumna `notified_at timestamptz` (nullable), PISANA PRZEZ WORKERA I KLIENTA.**
  Dziś: worker zapisuje `notifiedAt` do `workspace_states` z guardem rewizji **tylko dla wspólnych** rekordów
  (`worker.mjs:491-501`); dla prywatnych **świadomie NIE zapisuje** (`user_workspace_states` nie ma kolumny
  `revision`, `worker.mjs:532-534`). Klient też edytuje to pole: `snoozeReminder` czyści (`notifiedAt:
  undefined`, `:387-402`), `markReminderNotified` ustawia (`:407-418`, wołane z `useReminderEngine.ts` dla
  lokalnych powiadomień). **Model docelowy (prostszy i jednolity):** kolumna `notified_at` w `reminders`;
  worker po udanej dostawie robi `UPDATE reminders SET notified_at = now() WHERE id = $1 AND household_id =
  $2 AND notified_at IS NULL` — **bez bumpowania `version`** (pole jest workerowo-derywowane, nie należy do
  OCC-owanego zestawu kluczy edycji użytkownika; parytet z tym, że dziś prywatne w ogóle nie dostają
  writebacku). Klient trzyma `notified_at` w zestawie kluczy `reminder.update` (nullable, czyszczone przez
  snooze). **Wyścig klient↔worker** jest łagodny (dedup dostawy gwarantuje `notification_deliveries`; pole
  to głównie wskazówka UI) — patrz „Ryzyka". **To pierwszy raz, gdy worker mutuje znormalizowaną tabelę tej
  serii** — dotąd worker tylko czytał (Trips/Car/Pets/Health/Subscriptions).
- **`task.completedAt`/`event.externalUpdatedAt` → timestampy.** `completed_at` jako `timestamptz` (ustawiane
  przez toggle lokalnie, jak dziś). `external_updated_at` jako `text` (free-form timestamp z Google Calendar,
  `z.string().refine(Date.parse)` w `eventSchema:91` — **nie** `isoDate`, więc `text` bez rzutowania, dokładnie
  jak `measuredAt` w Health). `task.time`/`event.start_time`/`event.end_time`/`reminder.time` → `text`
  (clockTime) z tej samej racji co `pet_visits.time`.

### Ops mutacji (mapowanie 1:1 na dzisiejsze akcje `useLifeStore`)

Piętnaście ops (5 kolekcji × CRUD). Wszystkie toggle/recurrence/move akcje mapują się na `*.create`/
`*.update`/`*.delete` z policzonymi lokalnie wartościami (parytet z Health, gdzie `toggleAppointmentCompleted`
→ `appointment.update{status}`):

```
task.create,     task.update,     task.delete
event.create,    event.update,    event.delete
reminder.create, reminder.update, reminder.delete
note.create,     note.update,     note.delete
habit.create,    habit.update,    habit.delete
```

Mapowanie akcji → ops (wszystkie liczą wartości lokalnie i wysyłają przez zwykły `*.update`/`*.create`/
`*.delete`; OCC `baseVersion` z bieżącego rekordu):

- **`tasks`**: `addTask` → `task.create`; `updateTask` → `task.update`; `toggleTask` (`:133-154`) →
  `task.update { status, completedAt?, isFocus? }` (policzone lokalnie); `toggleFocus` (`:155-174`) →
  `task.update { isFocus }`; `moveTaskToTomorrow` (`:177-188`) → `task.update { date }`; `deleteTask` →
  `task.delete`. `TASK_UPDATE_KEYS = { title, description, status, priority, date, time, estimatedMinutes,
  category, isFocus, energy, completedAt, visibility, seriesId, seriesIndex, recurrence }`.
  **Recurrence**: `addRecurringTask` (`:189-216`) → N × `task.create` (każde wystąpienie z `id=seriesId#idx`,
  `seriesId`, `seriesIndex`, `recurrence`); `updateSeries` (`:220-257`) → M × `task.update` dla przyszłych
  wystąpień (przeliczone `date`/`time` + `visibility` propagowana na przeszłe) **+** ewentualne `task.create`
  (dosunięcie okna) **+** ewentualne `task.delete` (przycięcie `count`); `deleteSeries` (`:258-259`) →
  M × `task.delete` (po wszystkich lokalnych `id` serii); `expandRecurringSeries` (`:487-494`) → `task.create`
  dla nowych wystąpień frontier.
- **`events`**: analogicznie — `addEvent`/`updateEvent`/`deleteEvent`; `addRecurringEvent` (`:288-316`) →
  N × `event.create` (z zachowaniem czasu trwania `endTime-startTime`); `updateEventSeries` (`:319-359`);
  `deleteEventSeries` (`:360-361`). `EVENT_UPDATE_KEYS = { title, date, startTime, endTime, kind, location,
  notes, source, externalId, externalUpdatedAt, visibility, seriesId, seriesIndex, recurrence }`.
- **`reminders`**: `addReminder` → `reminder.create`; `toggleReminder` (`:379-386`) → `reminder.update
  { done }`; `snoozeReminder` (`:387-402`) → `reminder.update { date, time, notifiedAt: null }`;
  `markReminderNotified` (`:407-418`) → `reminder.update { notifiedAt }`; `deleteReminder` →
  `reminder.delete`. `REMINDER_UPDATE_KEYS = { title, date, time, done, notifiedAt, visibility }`.
- **`notes`**: `addNote` → `note.create`; `updateNote` → `note.update`; `deleteNote` → `note.delete`.
  `NOTE_UPDATE_KEYS = { title, content, color, pinned, visibility }`.
- **`habits`**: `addHabit` → `habit.create`; `toggleHabit` (`:447-460`) → `habit.update { completedDates }`
  (absolutny set); `deleteHabit` → `habit.delete`. `HABIT_UPDATE_KEYS = { name, icon, targetLabel,
  completedDates, visibility }`.

`*.create` payload niesie `id` + wszystkie pola tworzenia + `visibility` (`ownerId` **z sesji**,
`resolveOwnerId` — nawet jeśli UI dokleja `ownerId:"me"`, serwer nadpisze). `*.update` niesie `{ id, changes }`
+ `baseVersion`; pola nullable (`description`/`location`/`notes`/`recurrence`/`seriesId`/`completedAt`/
`notifiedAt`/…) obsługiwane wzorem `hasOwnProperty` (jak `specialty`/`lastTakenOn` w `health.mjs:327-333,
482-489`) — `null`/pominięcie czyści kolumnę. `*.delete` niesie `{ id }` + `baseVersion?` (OCC opcjonalne,
usuwanie idempotentne — brak rekordu = `applied`, wzór `resolveConflictOrGone`).

Wersjonowanie (OCC) jak w Zdrowiu: `UPDATE … SET …, version = version + 1 WHERE id=$ AND household_id=$ AND
version=$baseVersion AND (visibility='household' OR owner_id=$user)`; `rowCount=0` → dogrywający `SELECT` w
tym samym scope'ie → `status:"conflict"` + `currentVersion` albo `status:"error", code:"NOT_FOUND"`.

**Bezpieczeństwo scope'u widoczności (jak `health.mjs`/`subscriptions.mjs`):** każde zapytanie diagnostyczne
konfliktu niesie **ten sam** filtr `household_id` + `(visibility='household' OR owner_id=$user)` co write,
żeby nie wyciekła istnienia/treści prywatnego rekordu innego domownika. **Brak** wariantu `EXISTS`
(nie ma rodzica) i **brak** kaskady (nie ma dzieci).

### Snapshot read (GET /api/v1/life) — wspólne + własne prywatne (wzór `readHealthSnapshot`)

Sekwencyjnie (jeden `client`, node-postgres = jedno zapytanie in-flight), pięć `SELECT`-ów z filtrem
`WHERE household_id=$1 AND (visibility='household' OR owner_id=$2)`, każdy sort odzwierciedla dzisiejszy
insertion/render order:
- `tasks` `ORDER BY created_at` (dziś `addTask` prependuje; UI i tak sortuje po swojemu),
- `events` `ORDER BY date, start_time`,
- `reminders` `ORDER BY date, time`,
- `notes` `ORDER BY pinned DESC, created_at DESC` (dziś `addNote` prependuje, przypięte na górze),
- `habits` `ORDER BY created_at`.

Odpowiedź `{ tasks[], events[], reminders[], notes[], habits[], serverAt }`, każdy rekord z `version` i
`updatedAt` (+ `seriesId`/`seriesIndex`/`recurrence` dla tasks/events, `completedDates` dla habits,
`notifiedAt` dla reminders).

### Endpointy REST (wzorzec 1:1 ze Zdrowia — `server/src/server.mjs:950-996`)

- **`GET /api/v1/life`** → snapshot. Wzór: `GET /api/v1/health` + `readLifeSnapshot` (potrzebny
  `session.user_id` do filtra widoczności).
- **`POST /api/v1/life/mutations`** → body `{ mutations: Mutation[] }`, `Mutation = { idempotencyKey: uuid,
  op, payload, baseVersion? }`. Serwer: walidacja kształtu całego batcha z góry (`assertLifeMutationShape`,
  wzór `assertHealthMutationShape`), potem sekwencyjnie każda mutacja w `transaction()`: claim klucza
  (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING` → retry zwraca zapisany `result`), walidacja payloadu,
  SQL, zapis `result`. Odpowiedź `200` `{ results: [{ idempotencyKey, status, record?, currentVersion?,
  error?, code? }], serverAt }`. Globalne `400/413` tylko dla błędów całego żądania (zły kształt, przekroczony
  cap `MAX_LIFE_MUTATIONS`/bajtów). **Sekwencyjne przetwarzanie jest tu szczególnie ważne** — materializacja
  serii wysyła wiele `*.create` naraz, a toggle-e liczą stan z poprzedniej mutacji. Wzór 1:1: blok
  `POST /api/v1/health/mutations` (`server.mjs:956-986`).
  - **Podnieś domyślny cap batcha** względem Health: `MAX_LIFE_MUTATIONS ?? 1000` (materializacja serii
    bezterminowych + `updateSeries` mogą wygenerować kilkadziesiąt mutacji naraz; `SERIES_WINDOW=10` × kilka
    serii + edycje). Cap bajtów jak w Health (`2_000_000`).
- **`POST /api/v1/life/reset`** → `resetLifeForUser(client, householdId, userId)`: dla każdej z 5 tabel
  `DELETE … WHERE household_id=$1 AND (visibility='household' OR owner_id=$2)` — wzór `resetHealthForUser`
  (**per-user**, nie bezwarunkowy reset gospodarstwa, bo Life ma rekordy prywatne). Prywatne rekordy innych
  domowników **zostają**.

Reużycie (wszystko już w `server.mjs`): `requireHousehold`, `transaction()`, `httpError`, cap batcha,
sekwencyjne przetwarzanie, `session.user_id` w scope'ie. Nagłówki bezpieczeństwa/CSRF działają automatycznie
dla nowych tras.

### Backend — `server/src/life.mjs` (wzór 1:1 z `server/src/health.mjs`)

Czyste, testowalne funkcje: walidatory payloadów per `op` (`validateTaskCreate/UpdatePayload`,
`validateEventCreate/UpdatePayload`, `validateReminderCreate/UpdatePayload`, `validateNoteCreate/UpdatePayload`,
`validateHabitCreate/UpdatePayload`, `validateDeleteIdPayload`), `validateRecurrence` (nowy),
`resolveOwnerId`, `resolveVersionConflict`, `normalizeRequired/OptionalVersion`, `normalizeOptionalText`,
mapery wiersz→DTO (`taskRowToDto`/`eventRowToDto`/`reminderRowToDto`/`noteRowToDto`/`habitRowToDto`),
`readLifeSnapshot(client, householdId, userId)`, `applyLifeMutation(client, ctx, mutation)`,
`resetLifeForUser(client, householdId, userId)`, `SUPPORTED_LIFE_OPS`, `assertLifeMutationShape`,
`MAX_LIFE_MUTATIONS_*`. Reużywa wzorca `resolveConflictOrError`/`resolveConflictOrGone`/`resolveOwnerId`
(skopiowane z `health.mjs`), `query`/`transaction` z `db.mjs`, prymitywów `isPlainObject`/`isId`/
`isNonEmptyText`/`isOptionalText`/`isIsoDate`/`isClockTime`/`isParsableTimestamp` (dla `externalUpdatedAt`)/
`VISIBILITIES`/`UUID_PATTERN` (wzór z `health.mjs`). **Bez importu z `src/`** (serwer nie ma builda TS/zod;
walidatory ręczne odzwierciedlają `taskSchema`/`eventSchema`/`reminderSchema`/`noteSchema`/`habitSchema` +
`recurrenceSchema` z `src/lib/schema.ts` + nowe `version`). **Bez** `cascade*Visibility`, **bez**
`resolve*Visibility`, **bez** sprawdzania rodzica — nie mają odpowiednika w płaskim Life.

Nowe prymitywy względem `health.mjs`:
- `validateRecurrence(value)` — waliduje kształt obiektu `recurrence` (odzwierciedla `recurrenceSchema`):
  `freq`, `interval` (int>=1), `weekdays?` (tablica int 1–7, min 1, tylko weekly), `count?` (int>=1),
  `anchorDate` (isoDate), `anchorTime?` (clockTime). Zapisywany do `jsonb` przez `JSON.stringify`.
- `isSeriesIndex(value)` — int `>= 0`.
- `validateCompletedDates(value)` — tablica isoDate, cap długości (np. 5000). Absolutny set (zastępuje całą
  kolumnę `completed_dates`).
- `isNoteContent(value)` — string cap 100 000 (dopuszcza pusty, wzór `content` w `noteSchema:115`).

`task.create`/`event.create` walidują opcjonalne `seriesId`/`seriesIndex`/`recurrence` **razem** (albo
wszystkie trzy obecne — wystąpienie serii — albo żadne — rekord jednorazowy); walidator odrzuca połowiczny
zestaw. Zapis 1:1 do kolumn `series_id`/`series_index`/`recurrence`.

### Frontend — dedykowany store + silnik sync (offline-first) + przeniesiona logika serii

- **`src/store/useLifeRecordsStore.ts` (nowy)** — wzór 1:1 z `src/store/useHealthStore.ts`: Zustand +
  `persist` (klucz `puls-life-records`), `safeLocalStorage`, `parseArrayField`, `merge` z guardem
  `persistedState === undefined` (unikamy fałszywego „niezgodny format" na czystej instalacji — luka #3
  Finansów, już poprawiona w `useHealthStore.ts:589-601`). Trzyma `tasks`/`events`/`reminders`/`notes`/
  `habits` (każdy z `version`) + `pendingMutations[]` + `serverAt`/`hydrated`. Akcje **zachowują nazwy i
  sygnatury** dzisiejszych z `useLifeStore`, żeby diff w podstronach był ograniczony do zmiany importu:
  `addTask`, `updateTask`, `toggleTask`, `toggleFocus`, `deleteTask`, `moveTaskToTomorrow`, `addRecurringTask`,
  `updateSeries`, `deleteSeries`, `addEvent`, `updateEvent`, `deleteEvent`, `addRecurringEvent`,
  `updateEventSeries`, `deleteEventSeries`, `expandRecurringSeries`, `addReminder`, `toggleReminder`,
  `snoozeReminder`, `deleteReminder`, `markReminderNotified`, `addNote`, `updateNote`, `deleteNote`,
  `toggleHabit`, `addHabit`, `deleteHabit` — **oraz** `hydrateFromSnapshot`, `applyMutationResults`,
  `resetLifeRecordsData` (wzór `useHealthStore`). Każda akcja: optymistyczna zmiana lokalna →
  `idempotencyKey = crypto.randomUUID()` (`generateId()`) → mutacja do `pendingMutations` z aktualnym
  `baseVersion` rekordu → flush. **Toggle-e liczą nowy stan lokalnie z bieżącego rekordu** (jak w Health):
  `toggleTask`/`toggleFocus`/`moveTaskToTomorrow` → `task.update`; `toggleReminder`/`snoozeReminder`/
  `markReminderNotified` → `reminder.update`; `toggleHabit` → `habit.update{ completedDates }`. `*.update`
  podlega cichemu rebase'owi przy konflikcie (`isUpdateOp`/`upsertByUpdateOp`, wzór `useHealthStore.ts:117-163,
  544-563`) — reaplikuje deltę na świeży rekord. `*.create` na `conflict`/`ID_TAKEN` adoptuje rekord serwera
  (`reconcileTerminal`, wzór `useHealthStore.ts:565-567`) — **to obsługuje deterministyczne `id` serii**.
  Reużyj `parseArrayField`/`safeLocalStorage`/`quarantineRawValue`/`reportStorageWarning` (z `lib/safeStorage`),
  `generateId` (z `lib/id`), oraz **`expandSeries`/`occurrenceDate`/`SERIES_WINDOW`/`buildSeriesOccurrence` z
  `src/lib/recurrence.ts`** (przeniesienie logiki serii bez zmian w samym `recurrence.ts` — patrz niżej).
  - **Logika serii przenoszona z `useLifeStore` do tego store'u**: `addRecurringTask`/`addRecurringEvent`/
    `updateSeries`/`updateEventSeries`/`deleteSeries`/`deleteEventSeries`/`expandRecurringSeries`
    (`useLifeStore.ts:189-361, 487-494`) kopiowane niemal 1:1, z jedyną różnicą: zamiast `set((state) =>
    ({ tasks: … }))` produkują też **mutacje do kolejki**. Rekomendacja: te akcje wywołują wewnętrznie
    prywatne helpery `enqueueCreate/Update/Delete`, żeby każde utworzone/zmienione/usunięte wystąpienie
    dostało własną mutację z `baseVersion`. `expandSeries` nadal zwraca tę samą referencję przy braku zmian
    (no-op) → `expandRecurringSeries` nie kolejkuje nic, gdy okno pełne (unikamy pętli mutacji, parytet z
    dzisiejszym guardem przeciw pętli zapisu, `useLifeStore.ts:485-486`).
- **`src/hooks/useLifeRecordsSync.ts` + `src/server/LifeRecordsSync.tsx` (nowe)** — wzór 1:1 z
  `useHealthSync.ts` / `HealthSync.tsx`: montaż → `GET /api/v1/life` (hydratacja) → drenaż kolejki przez
  `POST /api/v1/life/mutations`; obsługa `applied`/`duplicate`/`conflict`/`error`; `MAX_FLUSH_ROUNDS`;
  nasłuch `online`/`focus`/`visibilitychange`; nieblokujący provider z własnym `sync-indicator`
  (`sync-indicator--life`, etykiety „Zapisuję Puls" / „Puls czeka na sieć" / „Puls zsynchronizowany" — dobrać
  nazwę niekolidującą z globalnym `WorkspaceSync`). Reużywa `apiRequest`/`ApiError` z `src/server/api.ts`.
  Provider jest **nieblokujący** (renderuje dzieci od razu — podstrony czytają gotowość ze stanu store'u,
  puste tablice do czasu hydratacji), jak `HealthSync`.
- **Montaż**: w `src/server/AuthGate.tsx` (`:353-397`) zagnieżdżony **wewnątrz `<WorkspaceSync>`, obok
  pozostałych dedykowanych sync-ów** (najlepiej najgłębiej, wewnątrz `<SubscriptionsSync>`, ten sam `key`/
  `onSessionExpired`): `…<SubscriptionsSync><LifeRecordsSync …>{children}</LifeRecordsSync></SubscriptionsSync>…`.
  Dorzuć `useLifeRecordsStore` do importów (`:21` obok `useLifeStore`), do `bindLocalStorageTo`/
  `clearLocalUserData` (reset `resetLifeRecordsData()` + `safeRemoveStorageItem("puls-life-records")`,
  `:70-118`) i do `hasUnsyncedChanges` (`useLifeRecordsStore.getState().pendingMutations.length > 0`,
  `:120-137`). **`WorkspaceSync` zostaje** — dalej pod nim żyją pola osobiste + `advanced`.

### Odchudzenie `useLifeStore` (pozostaje na JSONB dla pól osobistych)

`src/store/useLifeStore.ts` traci 5 kolekcji + wszystkie ich akcje + logikę serii; zostaje: `scratchpad`,
`intention`, `energy`, `preferences` + akcje `setScratchpad`/`setIntention`/`setEnergy`/`updatePreferences`/
`replaceData`/`resetData`. `LifeData` (`types.ts:125-135`) przestaje zawierać 5 tablic (albo powstaje nowy typ
`LifePersonalData` — do decyzji implementacyjnej; rekomendacja: zawęzić `LifeData` do skalarów i zaktualizować
`exportData`/`replaceData`/`WorkspaceSync`). `merge`/`partialize`/`exportData` (`:500-582`) tracą 5 kolekcji.
`createSampleData` (`src/data/sampleData.ts`) traci seed 5 kolekcji (serwer/SQL to źródło prawdy, offline =
pusto — parytet z wycięciem seedów car/pets/health z `advancedData.ts`); zostawia skalary.

> **Uwaga o determinizmie `preferences.theme`.** `App.tsx:67` czyta `preferences.theme` bardzo wcześnie.
> Ponieważ `preferences` **zostaje** w `useLifeStore` (bez zmian ścieżki), ten odczyt jest niezmieniony —
> żadnego ryzyka regresji „ciemny motyw miga na starcie".

### Worker — dwa reminery Life z SQL + writeback `notified_at`; usunięcie ścieżki JSONB

`server/src/worker.mjs` czyta dziś oba reminery Life z dokumentu JSONB:
- **event** (`derivedReminders:142-157`, wołane przez `deliverDerived` dla wspólnego i prywatnego dokumentu):
  „Za 30 min: &lt;title&gt;" 30 min przed `date`+`startTime`, okno 1 dzień, id `event:<id>`;
- **przypomnienie ręczne** (`dueReminders:109-122` + główna pętla `:476-506` z writebackiem `notifiedAt` do
  `workspace_states` + prywatna pętla `:511-542`): id = **surowe `reminder.id`**, `occurrence = date T time`,
  filtr `!done && !notifiedAt && due`.

Po migracji odtwarzamy to samo odczytem z SQL — **dokładnie jak `healthAppointmentReminders`/
`medicationReminders`** (`worker.mjs:255-312`), z `visibility`/`owner_id` per wiersz, bez joina:

- Nowa **`eventReminders(householdId, nowKey)`**:
  `SELECT id, title, date::text AS date, start_time, visibility, owner_id FROM events WHERE household_id=$1`.
  Dla każdego wiersza: `dueKey = shiftLocalDateTime(date, start_time, -30)`; jeśli `withinDeliveryWindow(dueKey,
  nowKey, 1)` — `{ reminder: { id: "event:<id>", title: "Za 30 min: <title>", date, time: start_time },
  targetUserId: visibility==='private' ? owner_id : null }`. Deterministyczne `id` wystąpień serii
  (`event:seriesId#index`) daje unikalny klucz dedup per wystąpienie (parytet z
  `docs/plans/zadania-wydarzenia-powtarzalne.md`).
- Nowa **`manualReminders(householdId, nowKey)`**:
  `SELECT id, title, date::text AS date, time, visibility, owner_id FROM reminders WHERE household_id=$1 AND
  done=false AND notified_at IS NULL`. Dla każdego wiersza, gdy `` `${date} ${time}` <= nowKey `` (parytet z
  `dueReminders`) — `{ reminder: { id: "<id>", title, date, time }, targetUserId: visibility==='private' ?
  owner_id : null }`. **Bez prefiksu** id (parytet 1:1 — dziś przypomnienia ręczne używają surowego `id`).
- W głównej pętli (`worker.mjs:391-475`, obok `healthAppointmentReminders`/`medicationReminders`/
  `subscriptionReminders`): dla każdego wpisu `deliverReminder(workspace, reminder, targetUserId)`. Po
  **udanej** dostawie przypomnienia ręcznego (`deliverReminder` zwraca `true`) — writeback:
  `UPDATE reminders SET notified_at = now() WHERE id = $1 AND household_id = $2 AND notified_at IS NULL`
  (**bez** bumpu `version`; idempotentne przez `notified_at IS NULL`). To zastępuje dzisiejszy revision-guarded
  `UPDATE workspace_states` (`:497-501`) i **jednocześnie** obsługuje rekordy prywatne (dziś świadomie
  pomijane, `:532-534`) — jednolicie, bo prywatne żyją w tej samej tabeli.
- **Usuń**: `derivedReminders` (`:142-157`), `deliverDerived` (`:350-363`) i jego wywołania (`:393, :517`),
  `dueReminders` (`:109-122`) + główny blok writebacku (`:476-506`), **całą prywatną pętlę**
  `for (workspace of privateWorkspaces.rows)` (`:511-542`) — po migracji `user_workspace_states` nie niesie
  już nic push-worthy (tylko pola osobiste + prywatne kolekcje przeniesione do SQL). Enumeracja gospodarstw
  zostaje z `workspace_states JOIN households` (`:387-390`) — dalej istnieje dla metadanych/pól osobistych.
  **Weryfikacja**: po wycięciu głównej pętli zostaje enumeracja gospodarstw + wywołania
  trip/car/pet/health/subscription/**event**/**manual** reminderów.
- Dorzuć prune retencji obok istniejących (`worker.mjs:382`): `DELETE FROM life_mutations WHERE created_at <
  now() - interval '30 days'`.
- **Prefiks `event:` i surowe `id` przypomnień ręcznych zachowane 1:1** — dedup w `notification_deliveries`
  (`occurrence`) niezmieniony.

### Migracja danych historycznych (`013_life_normalized.sql`)

Wzór 1:1 z `011_health_normalized.sql`/`012_subscriptions_normalized.sql` (defensywność wobec `NULL`/
nieobecnych kolekcji, `ON CONFLICT (id) DO NOTHING`, idempotentne; `owner_id` prywatnych z **kolumny
`user_id` wiersza `user_workspace_states`**, nigdy z JSON), **bez guardów sierot** (kolekcje niezależne):

1. `CREATE TABLE IF NOT EXISTS` dla 5 tabel + `life_mutations` + indeksy.
2. Dla każdej z 5 kolekcji — **wspólne**: `jsonb_array_elements(ws.data->'life'-><collection>)` z
   `household_id = ws.household_id`, `owner_id = COALESCE(hm.user_id, h.created_by)` z `LEFT JOIN
   household_members hm ON hm.user_id::text = rec->>'ownerId'`, `visibility` z clampem `household`/`private`
   (rekordy wspólne dostają `visibility` = `household` gdy `rec->>'visibility'` ≠ `private`), plus **prywatne**:
   `jsonb_array_elements(uws.data->'life'-><collection>)` z `owner_id = uws.user_id`, `visibility='private'`.
   Pola:
   - `tasks`: `date = NULLIF(rec->>'date','')::date`, `time = NULLIF(rec->>'time','')`, `estimated_minutes =
     NULLIF(rec->>'estimatedMinutes','')::integer`, `is_focus = COALESCE((rec->>'isFocus')::boolean, false)`,
     `status`/`priority`/`energy` z clampem, `completed_at = NULLIF(rec->>'completedAt','')::timestamptz`,
     `series_id = NULLIF(rec->>'seriesId','')`, `series_index = NULLIF(rec->>'seriesIndex','')::integer`,
     `recurrence = rec->'recurrence'` (jsonb 1:1, `NULL` gdy brak), `category`/`title` z fallbackiem non-empty.
   - `events`: `date = (rec->>'date')::date`, `start_time`/`end_time = COALESCE(NULLIF(rec->>'…',''),'00:00')`,
     `kind`/`source` z clampem, `external_updated_at = NULLIF(rec->>'externalUpdatedAt','')` (**text 1:1**,
     bez rzutowania), `series_*`/`recurrence` jak w tasks.
   - `reminders`: `date = (rec->>'date')::date`, `time = COALESCE(NULLIF(rec->>'time',''),'00:00')`,
     `done = COALESCE((rec->>'done')::boolean, false)`, `notified_at = NULLIF(rec->>'notifiedAt','')::timestamptz`.
   - `notes`: `content = COALESCE(rec->>'content','')`, `color` z clampem (fallback `cream`),
     `pinned = COALESCE((rec->>'pinned')::boolean, false)`.
   - `habits`: `icon` z clampem (fallback `water`), `target_label`/`name` non-empty,
     `completed_dates = COALESCE(rec->'completedDates','[]'::jsonb)` (jsonb 1:1).
3. **Wycięcie z JSONB**: `UPDATE workspace_states SET data = data #- '{life,tasks}' #- '{life,events}'
   #- '{life,reminders}' #- '{life,notes}' #- '{life,habits}', revision = revision + 1
   WHERE data->'life' ?| array['tasks','events','reminders','notes','habits']` oraz analogicznie
   `user_workspace_states` (`updated_at = now()`; ta tabela nie ma `revision`). **Pola osobiste
   (`scratchpad`/`intention`/`energy`/`preferences`) i `advanced` ZOSTAJĄ nietknięte.** Bump `revision`
   wymusza czysty refetch u klientów.

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/013_life_normalized.sql` (**nowy**) — kolejny numer po `012_subscriptions_normalized.sql`.
  `CREATE TABLE` 5 tabel (`tasks`/`events`/`reminders`/`notes`/`habits`) + `life_mutations` + indeksy (w tym
  `(household_id, series_id)` na tasks/events i indeks częściowy do workera na reminders) + migracja danych
  (wspólne + prywatne, **bez** guardów sierot; `recurrence`/`completed_dates` jako `jsonb`, `external_updated_at`
  jako `text`) + wycięcie **tylko 5 kolekcji** z `life` w JSONB. Wzorzec:
  `server/migrations/011_health_normalized.sql`.
- `src/types.ts` — dodaj `version: number` do `Task`/`CalendarEvent`/`Reminder`/`Note`/`Habit` (`:37-116`).
  Zawęź `LifeData` (`:125-135`) do pól osobistych (`scratchpad`/`intention`/`energy`/`preferences`) — 5 tablic
  odchodzi do nowego store'u (ewentualnie wprowadź `LifeRecordsData` dla snapshotu, ale typy rekordów
  współdzielone z backendem/frontendem zostają w `types.ts`). `Recurrence`/`RecurrenceFreq` (`:26-35`) bez
  zmian (współdzielone przez `recurrence.ts` i nowy store).
- `src/lib/schema.ts` — dodaj `version: recordVersion` (`:169`) do `taskSchema`/`eventSchema`/`reminderSchema`/
  `noteSchema`/`habitSchema` (`:58-133`) — do walidacji snapshotu i persystencji nowego store'u. **Zawęź
  `lifeDataSchema`** (`:142-152`) do 4 pól osobistych (usuń `tasks`/`events`/`reminders`/`notes`/`habits`) —
  po wycięciu `life` w JSONB niesie tylko skalary. `recurrenceSchema` (`:49-56`) bez zmian. **Uwaga na
  `backupEnvelopeV2Schema`** (`:504-513`) i `backupEnvelopeSchema` (`:156-162`, v1): oba używają
  `lifeDataSchema` — po zawężeniu backupy przestają zawierać 5 kolekcji Life (patrz „Ryzyka"/„Pytania"). Dodaj
  osobny (opcjonalny) `lifeRecordsSnapshotSchema` albo waliduj snapshot per-kolekcja w store (wzór
  `useHealthStore` używa `z.array(healthAppointmentSchema)` itd. — analogicznie tu).

### Backend (warstwa backend)

- `server/src/life.mjs` (**nowy**) — analogicznie do `server/src/health.mjs`: walidatory payloadów per `op`
  (5 kolekcji × create/update + wspólny delete-id), `validateRecurrence`/`isSeriesIndex`/
  `validateCompletedDates`/`isNoteContent` (nowe), `resolveOwnerId`, `resolveVersionConflict`,
  `normalizeRequired/OptionalVersion`, `normalizeOptionalText`, `isParsableTimestamp` (dla
  `externalUpdatedAt`), mapery wiersz→DTO, `readLifeSnapshot`, `applyLifeMutation`, `resetLifeForUser`,
  `SUPPORTED_LIFE_OPS`, `assertLifeMutationShape`, `MAX_LIFE_MUTATIONS_*`. Reużywa wzorca
  `resolveConflictOrError`/`resolveConflictOrGone`/`resolveOwnerId` (skopiowane z `health.mjs`),
  `query`/`transaction` z `db.mjs`. **Bez importu z `src/`**. **Bez** cascade/resolve-visibility/sprawdzania
  rodzica. **`series_id`/`series_index`/`recurrence` zapisywane 1:1 bez interpretacji** (materializacja po
  stronie klienta).
- `server/src/server.mjs` — dodaj importy z `./life.mjs` (obok `./subscriptions.mjs`/`./health.mjs`, ~`:43-52`);
  dodaj `GET /api/v1/life`, `POST /api/v1/life/mutations`, `POST /api/v1/life/reset` (kopiuj strukturę bloków
  health `:950-996` — używają `session.user_id` w scope'ie; te same reużycia `requireHousehold`/`transaction`/
  `httpError`/cap batcha; `MAX_LIFE_MUTATIONS` domyślnie wyższy — patrz „Endpointy").
- `server/src/workspace.mjs` — opróżnij `LIFE_COLLECTIONS` (`:25`, zostanie **`[]`**) — to automatycznie
  wyłącza 5 kolekcji z `splitWorkspaceData`/`mergeWorkspaceData` (pętle `for…of` degradują do no-op na pustej
  tablicy, parytet z pustym `META_COLLECTIONS`/`CHILD_RELATIONS`) i z `workspaceDocumentIsValid` (pętla
  `:42-44` pominięta; finalny warunek `typeof life.preferences === "object"` zostaje). **`PERSONAL_LIFE_KEYS`
  (`:24`) BEZ ZMIAN** — `life` dokumentu dalej niesie `scratchpad`/`intention`/`energy`/`preferences`. Dopisz
  komentarz nagłówka pliku (`:1-30`): Life-collections wycięte z JSONB (analogicznie do modułów advanced), ale
  `life` dokument zostaje dla pól osobistych. `ADVANCED_COLLECTIONS`/`CHILD_RELATIONS`/`META_COLLECTIONS` bez
  zmian.
- `server/src/worker.mjs` — dodaj `eventReminders(householdId, nowKey)` i `manualReminders(householdId, nowKey)`
  (odczyt z SQL, bez joina, z `visibility`/`owner_id`; event -30 min / okno 1 dzień; manual bez prefiksu id,
  `due` filtr) i wywołuj obie w głównej pętli obok pozostałych reminderów z targetowaniem
  `deliverReminder(workspace, reminder, targetUserId)`; po udanej dostawie manual → writeback `notified_at`
  (bez bumpu `version`). **Usuń** `derivedReminders`/`deliverDerived`/`dueReminders`, główny blok writebacku
  do `workspace_states` i całą prywatną pętlę `privateWorkspaces` (`:109-122, 142-157, 350-363, 476-542`).
  Dodaj prune `life_mutations` (`:382`).

### Frontend (warstwa frontend)

- `src/store/useLifeRecordsStore.ts` (**nowy**) — dedykowany store z optymistycznymi mutacjami, kolejką
  `pendingMutations`, `version` per rekord, cichym rebase'em `*.update`, adopcją `conflict` na `*.create`
  (deterministyczne `id` serii) **oraz przeniesioną logiką serii** (`addRecurringTask`/`addRecurringEvent`/
  `updateSeries`/`updateEventSeries`/`deleteSeries`/`deleteEventSeries`/`expandRecurringSeries`). Wzór:
  `useHealthStore.ts` (+ akcje serii z `useLifeStore.ts:189-361, 487-494`). Reużyj `parseArrayField`/
  `safeLocalStorage`/`quarantineRawValue`/`reportStorageWarning` (z `lib/safeStorage`), `generateId` (z
  `lib/id`), `expandSeries`/`occurrenceDate`/`SERIES_WINDOW`/`buildSeriesOccurrence` (z `lib/recurrence`),
  `addMinutesToTime`/`dateKey`/`durationMinutes` (z `lib/date`).
- `src/hooks/useLifeRecordsSync.ts` + `src/server/LifeRecordsSync.tsx` (**nowe**) — silnik sync +
  nieblokujący provider. Wzór: `useHealthSync.ts` / `HealthSync.tsx` (+ `apiRequest`/`ApiError` z
  `src/server/api.ts`).
- `src/store/useLifeStore.ts` — **odchudź do 4 pól osobistych**: usuń 5 kolekcji ze stanu, wszystkie ich akcje
  (`:56-96` interfejs, `:106-494` impl) i logikę serii; zostaw `scratchpad`/`intention`/`energy`/`preferences`
  + `setScratchpad`/`setIntention`/`setEnergy`/`updatePreferences`/`replaceData`/`resetData`; usuń 5 kolekcji
  z `merge`/`partialize`/`exportData` (`:500-582`); usuń importy schematów kolekcji/`recurrence`
  (`:6-18`). Store dalej synchronizowany przez `WorkspaceSync`.
- `src/data/sampleData.ts` — usuń seed 5 kolekcji z `createSampleData()`; zostaw skalary
  (`scratchpad`/`intention`/`energy`/`preferences`). Serwer/SQL to źródło prawdy (offline = pusto), parytet z
  wycięciem seedów advanced.
- `src/pages/TasksPage.tsx` — podmień import 5-kolekcyjnych selektorów/akcji z `useLifeStore` na
  `useLifeRecordsStore` (`:25, :45-49`: `tasks`, `updateTask`, `deleteTask`, `updateSeries`, `deleteSeries`).
  **Bez zmian w JSX/layoutcie/modalach.**
- `src/pages/CalendarPage.tsx` — podmień `events`/`tasks`/akcje serii/CRUD z `useLifeStore` na
  `useLifeRecordsStore` (`:22, :34-45, :93`); **`preferences` (`weekStartsOnMonday`) ZOSTAJE** w `useLifeStore`
  → strona importuje z **obu** store'ów (parytet z tym, jak TodayPage już importuje z wielu store'ów).
- `src/pages/NotesPage.tsx` — podmień `notes`/`updateNote`/`deleteNote`/`addTask` z `useLifeStore` na
  `useLifeRecordsStore` (`:18, :27-30`) — w tym `addTask` (konwersja notatki→zadanie, cross-kolekcja w tym
  samym nowym store'ze).
- `src/pages/HabitsPage.tsx` — podmień `habits`/`toggleHabit`/`addHabit`/`deleteHabit` z `useLifeStore` na
  `useLifeRecordsStore` (`:19, :33-36`).
- `src/pages/TodayPage.tsx` — podmień 5-kolekcyjne (`tasks`/`events`/`reminders`/`habits` + `toggleReminder`/
  `snoozeReminder`/`toggleHabit`/`addTask`, `:48, :86-100`) na `useLifeRecordsStore`; **`scratchpad`/
  `intention`/`energy`/`preferences.name` + `setScratchpad`/`setIntention`/`setEnergy` ZOSTAJĄ** w
  `useLifeStore` → strona importuje z **obu**.
- `src/components/QuickAddModal.tsx` — podmień `addTask`/`addEvent`/`addReminder`/`addNote`/`addRecurringTask`/
  `addRecurringEvent` z `useLifeStore` na `useLifeRecordsStore` (`:19, :44-49`). **Bez zmian w UI.**
- `src/components/TaskItem.tsx` — podmień `toggleTask`/`toggleFocus`/`moveTaskToTomorrow`/`deleteTask`
  (`:14, :45-48`) na `useLifeRecordsStore`.
- `src/components/CommandPalette.tsx` — podmień `tasks`/`notes`/`events` (`:21, :116-118`) na
  `useLifeRecordsStore`; nawigacja/quick-add przez propsy bez zmian.
- `src/components/Layout.tsx` — podmień `reminders` (`:88`) na `useLifeRecordsStore`; **`preferences.theme`/
  `preferences.name`/`updatePreferences` (`:85-88`) ZOSTAJĄ** w `useLifeStore` → import z **obu**.
- `src/hooks/useReminderEngine.ts` — podmień `reminders`/`markReminderNotified` (`:2, :8-10`) na
  `useLifeRecordsStore`; **`preferences.notificationsEnabled` ZOSTAJE** w `useLifeStore` → import z **obu**.
- `src/pages/MealsPage.tsx` — **bez zmian** (używa tylko `preferences`, `:66, :25` — zostaje w `useLifeStore`).
- `src/App.tsx` — `expandRecurringSeries()` (`:179, :181`, mount + focus/visibilitychange) woła teraz
  `useLifeRecordsStore.getState().expandRecurringSeries()`; `useLifeStore.persist.rehydrate()` (`:168`)
  zostaje (dla skalarów) + dodaj `useLifeRecordsStore.persist.rehydrate()` jeśli potrzebny cross-tab dla
  nowego store'u; `preferences.theme` (`:67`) bez zmian. Routing/`ViewId` bez zmian.
- `src/server/WorkspaceSync.tsx` — usuń 5 kolekcji z `replaceWithEmptyWorkspace` (`:32-42`, zostaną skalary
  + preserwacja `preferences`), z `localData`/`exportData` (`:24-28` — po zawężeniu `exportData` zwraca tylko
  skalary), z `applyData` (`:84-99` — `lifeDataSchema.parse` dalej działa na zawężonym schemacie). **Ekran
  „Migracja Puls 1.0"** (`:357-398`) liczy `useLifeStore.getState().tasks/events/notes.length` (`:372/375/378`)
  — po odchudzeniu te pola znikają; zaktualizować liczniki (czytać z `useLifeRecordsStore`) **lub** uprościć
  ekran (patrz „Ryzyka — legacy import Puls 1.0"). **`WorkspaceSync` pozostaje zamontowany** — dalej
  synchronizuje pola osobiste + `advanced`.
- `src/server/AuthGate.tsx` — zamontuj `<LifeRecordsSync>` najgłębiej w drzewie sync (wewnątrz
  `<SubscriptionsSync>`, `:384-389`); dodaj import `useLifeRecordsStore` (`:21`), reset w `bindLocalStorageTo`/
  `clearLocalUserData` (`:70-118`) + `safeRemoveStorageItem("puls-life-records")`, oraz
  `useLifeRecordsStore().pendingMutations` w `hasUnsyncedChanges` (`:120-137`). `useLifeStore.resetData()`
  (`:74, :97`) zostaje (skalary).
- `src/pages/SettingsPage.tsx` — w „Wyczyść dane aplikacji" dodaj `await apiRequest("/api/v1/life/reset",
  { method: "POST", json: {} })` obok pozostałych resetów i `resetLifeRecordsData()` obok pozostałych; w
  eksporcie/imporcie backupu (`:135` `exportData()`, `replaceData`) — patrz „Ryzyka — backup"; `preferences`/
  `updatePreferences`/`replaceData` (`:44-48`) zostają w `useLifeStore`. `tasks`/`events` (`:44-48`, jeśli
  używane w statystykach eksportu) → `useLifeRecordsStore`. Dodaj import `useLifeRecordsStore`.

### Nawigacja/routing — BEZ zmian

`src/types.ts` (`ViewId` z `today`/`tasks`/`calendar`/`notes`/`habits`), `src/components/Layout.tsx` (wpisy
`navigation`), `src/App.tsx` (statyczne importy podstron Life `:8-13`, `viewIds` `:40-54`, render `:208-220`)
— **nie ruszamy** tras/zakładek. Zmienia się wyłącznie warstwa danych pod stronami.

### Testy (aktualizacja + nowe)

- Aktualizacja:
  - `src/store/useLifeStore.test.ts` — usuń przypadki 5 kolekcji + serii (przenoszone do nowego store'u);
    zostaw testy skalarów/`preferences` (jeśli są). Sekcja „serie powtarzalne w store" (`:~ do 245`) przenosi
    się do `useLifeRecordsStore.test.ts`.
  - `src/server/workspaceMerge.test.ts` — dziś zawiera „dwa urządzenia rozwijające serię → brak duplikatów"
    (merge po `id` dla `tasks`/`events`). Po migracji ten scenariusz przenosi się do modelu SQL (adopcja
    `conflict`/`ID_TAKEN` na `*.create`) — przenieś/przeadresuj do `useLifeRecordsStore.test.ts` +
    `server/test/life.node.mjs`. Pozostałe testy 3-way merge dot. 5 kolekcji usuń (kolekcje nie są już w
    dokumencie); testy dot. pól osobistych (jeśli są) zostają.
  - `src/lib/schema.test.ts` — `lifeDataSchema` waliduje teraz tylko skalary; dodaj `version` do testów
    schematów rekordów; recurrence bez zmian.
  - `server/test/workspace.node.mjs` — `LIFE_COLLECTIONS` = **puste**; split/merge/`workspaceDocumentIsValid`
    bez 5 kolekcji (dokument z samymi polami osobistymi + `advanced` przechodzi round-trip).
  - `src/App.test.tsx`, `src/server/WorkspaceSync.test.tsx`, `src/server/AuthGate.test.tsx`,
    `src/components/QuickAddModal.test.tsx` — dostosuj do nowego store'u + liczby providerów sync (+1) +
    zmienionego ekranu migracji.
  - `src/lib/recurrence.test.ts` — **bez zmian** (czysta logika `recurrence.ts` nietknięta).
- Nowe:
  - `src/store/useLifeRecordsStore.test.ts` — optymistyczne mutacje, wersje, kolejka; prywatność w payloadzie;
    idempotencja (retry z tym samym kluczem nie dubluje); `conflict` per rekord z cichym rebase'em (`*.update`)
    **oraz** adopcja `conflict`/`ID_TAKEN` na `*.create` (deterministyczne `id` serii — dwa urządzenia
    rozwijające to samo okno → brak duplikatów); serie (`addRecurringTask` okno/deterministyczne id, `count`
    limit, `updateSeries` future-only + trim, `deleteSeries`, `expandRecurringSeries` no-op-when-full);
    `toggleHabit` jako absolutny set; `toggleTask`/`toggleFocus`/`snoozeReminder`/`markReminderNotified`.
  - `server/test/life.node.mjs` — walidatory (w tym `validateRecurrence`, `validateCompletedDates`,
    `isParsableTimestamp` dla `externalUpdatedAt`), `resolveVersionConflict`, `owner_id` z sesji niezależnie
    od payloadu, scope widoczności w konfliktach, idempotencja retry, `ID_TAKEN` na kolizji `id` serii, reset
    per-user nie rusza prywatnych innych domowników, oba pushe Life targetowane per widoczność (event -30 min,
    manual bez prefiksu + writeback `notified_at`).

## Kryteria akceptacji

- [ ] `npm run build` (`tsc -b && vite build`) przechodzi — brak martwych referencji do 5 kolekcji w
      `LifeData`/`lifeDataSchema`/`useLifeStore`/`WorkspaceSync`/podstronach.
- [ ] `npm test` (Vitest) przechodzi — zaktualizowane testy generyczne bez 5 kolekcji w `useLifeStore`; nowy
      `useLifeRecordsStore.test.ts` (mutacje, wersje, kolejka, idempotencja, cichy rebase, adopcja `ID_TAKEN`
      serii, serie, `toggleHabit` absolutny set); `recurrence.test.ts` zielony bez zmian.
- [ ] `npm run test:server` (`node --test`) przechodzi — zaktualizowany `workspace.node.mjs` (puste
      `LIFE_COLLECTIONS`, dokument z samymi polami osobistymi + `advanced` przechodzi split/merge/valid); nowy
      `server/test/life.node.mjs` (opis wyżej).
- [ ] Migracja `013` na bazie z istniejącymi 5 kolekcjami w JSONB (w tym prywatnymi i **seriami
      powtarzalnymi**): rekordy trafiają do tabel z zachowanym `id` (w tym deterministyczne `seriesId#index`)/
      `ownerId`/`visibility`/znacznikami czasu, `recurrence`/`seriesId`/`seriesIndex` zachowane w `jsonb`/
      kolumnach, `completedDates`/`notifiedAt`/`completedAt` zachowane, `data->'life'` nie zawiera już 5
      kolekcji ale **dalej zawiera** `scratchpad`/`intention`/`energy`/`preferences`, dwukrotne uruchomienie
      nie duplikuje, prywatne pozostają prywatne.
- [ ] `npm run preview` (także wąski ekran, PWA): dodanie/edycja/toggle/usunięcie zadania (w tym focus,
      „na jutro", ukończenie); dodanie/edycja/usunięcie wydarzenia; **utworzenie serii powtarzalnej** (dzień/
      tydzień z dniami/miesiąc + limit) — wystąpienia widoczne w TasksPage/CalendarPage, edycja/usunięcie całej
      serii; dodanie/toggle/snooze/usunięcie przypomnienia; dodanie/edycja/usunięcie notatki; toggle/dodanie/
      usunięcie nawyku; przełącznik „Tylko ja/Domownicy" na każdej kolekcji; scratchpad/intencja/energia na
      „Dzisiaj" (skalary — nadal działają przez WorkspaceSync); Command Palette (wyszukiwanie zadań/notatek/
      wydarzeń) — wszystko identycznie jak przed zmianą.
- [ ] Offline → online: mutacje bez sieci (w tym materializacja serii) kolejkują się i zapisują po powrocie;
      retry tej samej kolejki nie tworzy duplikatów.
- [ ] Dwa „urządzenia": (a) równoległa edycja **różnych** rekordów przechodzi bez konfliktu; (b) równoległa
      edycja **tego samego** rekordu ze starą wersją zwraca konflikt tylko dla niego (cichy rebase), reszta
      batcha przechodzi; (c) **dwa urządzenia niezależnie rozwijające to samo okno serii → brak duplikatów**
      (adopcja `ID_TAKEN` na `*.create`).
- [ ] Worker wysyła push z nowych tabel: „Za 30 min: &lt;title&gt;" (30 min przed, okno 1 dzień) dla `events`
      oraz przypomnienia ręczne (`!done && !notifiedAt && due`) dla `reminders` — dla rekordu wspólnego do
      wszystkich domowników, dla prywatnego tylko do właściciela; po dostawie manual ustawia `notified_at` i
      **nie przychodzi ponownie**; prefiks `event:` i surowe `id` przypomnień niezmienione (brak kolizji
      dedup); `tasks`/`notes`/`habits` nie generują push.
- [ ] Po wdrożeniu: aktualizacja tabeli priorytetów w `docs/DATA_MODEL_MIGRATION.md` — wiersz #7 status
      „Zaplanowane po Subskrypcjach" → „✅ Zrobione (PR #NN)"; ewentualna sekcja „Status po wdrożeniu" z lukami
      z E2E.

## Ryzyka

- **Regresja OBU pushów Life.** Wycięcie `events`/`reminders` z JSONB **psuje** oba reminery, jeśli worker nie
  zmigruje. Rekordy mają widoczność — błędne targetowanie ujawniłoby prywatne wydarzenie/przypomnienie całemu
  gospodarstwu. Pułapki: (1) przypomnienia ręczne używają **surowego `id` bez prefiksu** — nie dokładać
  prefiksu (złamałoby dedup `occurrence`); (2) event -30 min ma okno **1 dzień** (`withinDeliveryWindow(…, 1)`),
  nie domyślne 7; (3) `notified_at` writeback musi być idempotentny (`WHERE notified_at IS NULL`) i **bez**
  bumpu `version`. Pokryć weryfikacją audytorium i częstotliwości.
- **Worker mutuje znormalizowaną tabelę (nowość w serii) + wyścig klient↔worker o `notified_at`.** Dotąd worker
  tylko czytał znormalizowane tabele. Tu **pisze** `reminders.notified_at`. Jednocześnie klient edytuje to pole
  (`snooze` czyści, `markReminderNotified` ustawia). Ryzyko: klient snooze'uje (czyści `notified_at`, zmienia
  `date`/`time`, bump `version`) dokładnie gdy worker pisze `notified_at`. Łagodzenie: worker pisze **bez**
  bumpu `version` i tylko `WHERE notified_at IS NULL` (nie nadpisze świeżo wyczyszczonego, jeśli klient już
  ustawił nowy termin bez notyfikacji); realna korektność dostawy (nie duplikować/nie gubić) jest gwarantowana
  przez `notification_deliveries` (occurrence po `date T time`), więc `notified_at` to głównie wskazówka UI.
  Pokryć testem: snooze po dostawie → nowy termin, brak podwójnego push (nowe `occurrence`).
- **Deterministyczne `id` serii vs losowe UUID.** To jedyny moduł, gdzie kolizja `id` na `*.create` jest
  **zamierzona** (dwa urządzenia liczą `seriesId#index`). `useLifeRecordsStore` MUSI traktować `conflict`/
  `ID_TAKEN` na `*.create` jak `applied` (adopcja rekordu serwera), inaczej okno serii duplikowałoby się/
  wisiało w kolejce. Nie mylić z `conflict` na `*.update` (cichy rebase delty). Pokryć testem store'u i
  serwera.
- **Materializacja serii = wiele mutacji naraz → cap batcha i kolejność.** `addRecurringTask` (10 wystąpień)
  i `updateSeries` (edycja + dosunięcie + trim) generują kilkanaście–kilkadziesiąt mutacji. Podnieść
  `MAX_LIFE_MUTATIONS` (domyślnie 1000). Przetwarzanie **sekwencyjne** (parytet z Health) — istotne, bo toggle
  liczy stan z poprzedniej mutacji, a `expandRecurringSeries` musi być no-op przy pełnym oknie (unikać pętli
  mutacji, jak dziś unikamy pętli zapisu). Pokryć testem idempotencji `expandRecurringSeries`.
- **`visibility` edytowalne w UI (klasa regresji „goal visibility" z Finansów).** Modale edycji pozwalają
  zmienić `visibility` po utworzeniu (wszystkie 5 kolekcji). Pominięcie `visibility` w `*_UPDATE_KEYS` to
  regresja. Plan **włącza** `visibility` do kluczy edycji wszystkich 5. Dodatkowo: **`updateSeries`/
  `updateEventSeries` propagują `visibility` na CAŁĄ serię** (w tym przeszłe wystąpienia, `useLifeStore.ts:
  228-234, 327-332`) — inaczej seria rozszczepiłaby się między dokument wspólny i prywatny. W SQL to nadal
  ważne: rekordy serii o różnej `visibility` trafiają do różnych zakresów snapshotu (`household` vs własny
  prywatny), więc niespójna widoczność serii złamałaby spójność listy. Zachować propagację w nowym store'ie.
- **Backup/restore v2 przestaje zawierać 5 kolekcji Life (WYSOKIE stawki, potwierdzone z użytkownikiem
  18.07.2026).** Usunięcie z `lifeDataSchema` sprawia, że `backupEnvelopeV2Schema` (i `backupEnvelopeSchema`
  v1) nie odtwarza już zadań/wydarzeń/przypomnień/notatek/nawyków ze starego backupu. Parytet z modułami
  advanced, ale tu stawki są większe (to rdzeń aplikacji). **Zaakceptowane świadomie** — eksport per-moduł z
  SQL do backupu pozostaje poza zakresem, przyszły temat.
- **Legacy import „Puls 1.0" (`WorkspaceSync` migrationChoice) nie przeniesie 5 kolekcji (potwierdzone z
  użytkownikiem 18.07.2026 — uprościć ekran, bez mostu).** Ekran „Znaleźliśmy lokalne dane / Przenieś moje
  dane" (`WorkspaceSync.tsx:357-398`) uploaduje `localData().life` przez PUT workspace — po odchudzeniu `life`
  nie niesie już kolekcji, więc legacy lokalne zadania/wydarzenia/notatki z Puls 1.0 **nie zostaną
  przeniesione** tą ścieżką na serwer. Nikt już nie startuje ze świeżego, niezmigrowanego localStorage Puls
  1.0 — ekran migracji dostaje liczniki z `useLifeRecordsStore` zamiast mostu importu; brak przenoszenia
  legacy kolekcji jest udokumentowanym, świadomym ograniczeniem.
- **Duży blast radius** (5 kolekcji × wiele podstron/komponentów/hooków + worker + odchudzenie `useLifeStore`
  + `WorkspaceSync` + testy) — największy w serii. Łapane przez `tsc` (strict) i testy; robić atomowo
  dane → backend → frontend (`implement-layered`), kolekcja po kolekcji wg „Podfaz".
- **`WorkspaceSync` ZOSTAJE — nie usuwać dokumentu JSONB.** Łatwa pomyłka: „wszystkie moduły zmigrowane, więc
  usuwamy WorkspaceSync". **Nie** — pola osobiste (`scratchpad`/`intention`/`energy`/`preferences`) i
  `advanced` (metadane gospodarstwa) dalej żyją w JSONB przez `WorkspaceSync`. Usunięcie go zepsułoby te pola.
  `LIFE_COLLECTIONS=[]` i `lifeDataSchema` zawężony do skalarów — ale dokument i sync **istnieją**.
- **Spójność sync z resztą.** Usunięcie 5 kolekcji z `lifeDataSchema`/`workspaceDocumentIsValid` musi być
  zsynchronizowane z klientem (`replaceWithEmptyWorkspace`, `applyData`, `localData`), inaczej `PUT
  /api/v1/workspace` zwróci `400 INVALID_WORKSPACE_SCHEMA` albo `applyData` rzuci na `lifeDataSchema.parse`.
  Bump `revision` w migracji wymusza czysty refetch.
- **`.sync-indicator` — dziewiąty (i ostatni) wskaźnik.** To będzie **dziewiąty** wskaźnik synchronizacji
  (workspace/finance/trips/meals/car/pets/health/subscriptions/life). Blokada kliknięć naprawiona globalnie
  `pointer-events: none` w `src/styles/server.css` (luka #2 Zdrowia) — nowy wskaźnik dziedziczy regułę.
  Kosmetyczne nakładanie stosu na wąskim ekranie pozostaje znane (poza zakresem — pełne rozwiązanie objęłoby
  wszystkie moduły).
- **`preferences.notificationsEnabled` device-local — bez zmian.** `splitWorkspaceData` (`:126-132`) i
  `applyData` (`WorkspaceSync:87-92`) traktują je specjalnie (per-urządzenie). `preferences` zostaje w
  `useLifeStore`/JSONB, więc ta logika jest nietknięta — **nie** przenosić `preferences` do nowego store'u.

## Pytania do doprecyzowania

Wszystkie otwarte pytania rozstrzygnięte z użytkownikiem 18.07.2026 — sekcja pusta, brak odłożonych kwestii.

- **Backup/restore v2**: **akceptujemy utratę** 5 kolekcji Life z `backupEnvelopeV2Schema`/`backupEnvelopeSchema`
  w tym PR (zgoda z rekomendacją). SQL + reset/snapshot to źródło prawdy; eksport per-modułu z SQL do backupu
  to osobny, przyszły temat — nie w zakresie.
- **Legacy import „Puls 1.0"**: **uproszczenie ekranu**, bez mostu importu (zgoda z rekomendacją). Nikt już nie
  startuje ze świeżego, niezmigrowanego localStorage Puls 1.0. Ekran migracji (`WorkspaceSync.tsx:357-398`)
  dostaje liczniki z `useLifeRecordsStore` zamiast z odchudzonego `useLifeStore`; brak przenoszenia 5 kolekcji
  legacy tą ścieżką jest udokumentowanym, świadomym ograniczeniem.
- **Kolejność podfaz wewnątrz PR**: potwierdzona `notes → habits → reminders → events → tasks`.
- **Detale domyślne**: potwierdzone bez zmian — `recurrence`/`completed_dates` jako kolumny `jsonb`;
  `notified_at` pisane przez workera **bez** bumpu `version`; `MAX_LIFE_MUTATIONS` domyślnie **1000**; nazwy
  tabel **bez** prefiksu `life_`; `worker.mjs` w zakresie tego PR.
