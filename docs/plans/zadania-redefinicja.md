# Redefinicja zadań: bez dat, z wolnymi tagami i grupowaniem listy

> Plan wygenerowany przez skill `/plan-feature`. Slug: `zadania-redefinicja`. Branch: `claude/tasks-assumptions-display-955yxj`.

## Kontekst / Problem

Dziś `Task` jest niemal kopią `CalendarEvent`: ma `date`, `time`, `estimatedMinutes`, sztywną
`category` (Praca/Prywatne/Dom/Zdrowie/Finanse) oraz pełną powtarzalność (`recurrence`/`seriesId`/
`seriesIndex`). Efekt: zadanie „coś do zrobienia" myli się z wydarzeniem „coś na 14:00", lista
zadań jest kalendarzem (widoki Dzisiaj/Nadchodzące oparte na dacie), a zadania dublują funkcję
kalendarza i przypomnień.

Chcemy przywrócić zadaniu jego istotę: **rzecz do zrobienia, bez przypisanej godziny**. Rzeczy z
konkretnym terminem to wydarzenie (kalendarz) albo przypomnienie. Zadania grupujemy po **wolnych
tagach** i po **ważności** (`priority`), a lista dostaje **przełącznik grupowania** zamiast
kalendarzowych widoków dat.

## Wymagania

Funkcjonalne:
- `Task` traci całkowicie `date`, `time`, `estimatedMinutes` — na poziomie typu, walidacji, UI, API
  i kolumn SQL.
- `Task` traci powtarzalność: `recurrence`, `seriesId`, `seriesIndex` znikają z zadań (cykle
  obsługują nawyki i wydarzenia). Istniejące serie zadań stają się zwykłymi, pojedynczymi zadaniami.
- Sztywna `category` znika; zamiast niej `Task` ma **wolne tagi** (`tags: string[]`) — użytkownik
  wpisuje własne, zadanie może mieć ich kilka.
- `priority` (`low`/`medium`/`high` = Może poczekać/Normalne/Ważne) ZOSTAJE jako niezależny wymiar
  „ważności".
- Lista zadań (`TasksPage`) dostaje przełącznik grupowania: **wg ważności / wg tagu / bez
  grupowania**. Usuwamy kalendarzowe widoki `today`/`inbox`/`upcoming`.
- „Dzisiaj" (`TodayPage`) przestaje wybierać zadania po dacie — zadanie trafia „na dziś" wyłącznie
  przez `isFocus` (ręczny wybór priorytetu dnia), odpięty od daty.
- Kalendarz (`CalendarPage`) przestaje pokazywać i edytować zadania (nie mają już dat/godzin).
- Szybkie dodawanie (`QuickAddModal`) i modal edycji zadania tracą pola Data/Godzina/Czas/
  Powtarzalność; zyskują pole tagów.

Niefunkcjonalne:
- Utrzymać granicę danych prywatnych/wspólnych: `visibility` (household/private) i `ownerId`
  ustalany z sesji, nie z klienta (`docs/ARCHITECTURE.md` „Dane wspólne i prywatne",
  `resolveOwnerId` w `server/src/life.mjs`). Tagi respektują tę granicę — są zwykłym polem rekordu.
- Migracja SQL numer **014** (013 jest ostatnia) migruje istniejące wiersze: stara `category` →
  tag, kolumny dat i serii odcięte.
- `npm run build`, `npm test`, `npm run test:server` przechodzą; PWA działa na wąskim ekranie.
- Kompatybilność wsteczna przy odczycie starych danych z localStorage (persist zustand) — stare
  zadania z `date`/`category` nie mogą wywalać hydratacji.

## Zakres i Non-goals

**W zakresie:**
- Zmiana typu `Task` (`src/types.ts`) i walidacji (`src/lib/schema.ts`, `server/src/life.mjs`).
- Migracja SQL 014: dodanie kolumny `tags`, przeniesienie `category`→tag, odcięcie kolumn dat/serii.
- Przeprojektowanie `TasksPage` (grupowanie zamiast filtrów dat) i modala edycji zadania.
- Przeprojektowanie formularza zadania w `QuickAddModal` (tagi zamiast dat/czasu; recurrence tylko
  dla wydarzeń).
- Aktualizacja `TaskItem` (tagi zamiast daty/overdue/czasu/category; usunięcie „Przenieś na jutro").
- Odpięcie zadań od `TodayPage` (agenda/postęp/„jutro") i od `CalendarPage`.
- Aktualizacja `useLifeRecordsStore` (usunięcie serii zadań/`moveTaskToTomorrow`, obsługa tagów) i
  jego testów.

**Non-goals (świadomie pomijamy):**
- Powtarzalność wydarzeń — `Recurrence`, `RecurrenceFields`, `src/lib/recurrence.ts`, seria
  wydarzeń w store i `CalendarPage`/`QuickAddModal` ZOSTAJĄ nietknięte. Odłączamy recurrence tylko
  od zadań.
- Przypomnienia, notatki, nawyki, kalendarz jako takie — bez zmian modelu (poza usunięciem zadań z
  widoku kalendarza).
- Autouzupełnianie/„słownik" istniejących tagów, kolorowanie tagów per-tag, tag jako encja z ID —
  tagi to zwykłe stringi (patrz „Podejście").
- Zmiana modelu synchronizacji/rewizji, worker Web Push (zadania nigdy nie były w silniku push/
  przypomnień — patrz Ryzyka).

## Podejście

**To Fastify + PostgreSQL (nie Next.js).** Zadania żyją w znormalizowanej tabeli `tasks`
(migracja `013_life_normalized.sql`), obsługiwanej przez `server/src/life.mjs` (walidatory +
exec\* + mapper DTO), z GET `/api/v1/life` i batchem mutacji `/api/v1/life/mutations`. Frontend
trzyma stan w `useLifeRecordsStore` (optymistyczne mutacje + kolejka), sync w
`src/hooks/useLifeRecordsSync.ts`. Zmieniamy WYŁĄCZNIE kształt zadań — reszta pięciu kolekcji Life
(events/reminders/notes/habits) i cała infrastruktura mutacji/OCC/idempotencji zostają.

**Reprezentacja tagów: kolumna `tags jsonb NOT NULL DEFAULT '[]'::jsonb` na tabeli `tasks`** (NIE
tabela pomocnicza `task_tags`). Uzasadnienie:
- Dokładny precedens w tym samym repo: `recipes.tags` (`server/migrations/008_meals_normalized.sql`
  linia 22: `tags jsonb NOT NULL DEFAULT '[]'`), z walidatorem `isStringArray(...)` i mapperem
  `Array.isArray(row.tags) ? row.tags : []` w `server/src/meals.mjs`. Reużywamy ten wzorzec 1:1.
- Moduł Life z założenia NIE ma FK między swoimi tabelami ani relacji rodzic/dziecko (nagłówek
  `013_life_normalized.sql`: „żadnego FK między nimi… żadnej kaskady widoczności"). Tabela
  `task_tags` łamałaby ten wzorzec i wymuszała kaskadę widoczności/ownera na dzieciach.
- Tag to absolutny set nadpisywany w całości przy edycji (jak `habits.completed_dates` /
  `pets.fish_stock` / `recipes.tags`) — pasuje do istniejącego modelu mutacji „klient liczy całą
  tablicę lokalnie, serwer zapisuje 1:1".
- Alternatywę `text[]` odrzucamy dla spójności z resztą repo (wszędzie tablice trzymane jako
  `jsonb`, node-postgres zwraca je gotowe do DTO bez rzutowania).

**Odcięcie dat/serii = migracja, nie tylko kod.** Migracja 014 najpierw przenosi `category` do
`tags`, potem **usuwa** (DROP COLUMN) kolumny `date`, `time`, `estimated_minutes`, `category`,
`series_id`, `series_index`, `recurrence` z tabeli `tasks` oraz indeks `tasks_household_series_idx`.
Wersja alternatywna (zostawić kolumny jako NULL) jest niżej-ryzykowna, ale zostawia martwe pola —
patrz „Pytania". Tabela `events` zostaje z pełnym kompletem kolumn serii/dat.

**„Dzisiaj" przez `isFocus`.** `focusTasks` w `TodayPage` już dziś opiera się głównie na `isFocus`
(z dodatkowym warunkiem daty) — po zmianie zostaje sam `isFocus && status==='todo'`. Limit „3
priorytety dnia" przenosimy z logiki per-dzień (dziś liczonej po `task.date`) na globalny licznik
`isFocus` (patrz `toggleFocus`/`toggleTask` w store).

**Grupowanie na liście = czysta logika widoku.** `TasksPage` liczy `groupBy` (`priority` | `tag` |
`none`) i buduje sekcje lokalnie z `tasks`, bez nowych zapytań. Sekcje: dla `priority` — Ważne/
Normalne/Może poczekać; dla `tag` — jedna sekcja na tag + „Bez tagu" (zadanie z N tagami pojawia
się w N sekcjach); dla `none` — płaska lista. Reużywamy `TaskItem` i `EmptyState`.

## Pliki do zmiany

**Baza (warstwa danych):**

- `server/migrations/014_tasks_redefinition.sql` — NOWA migracja. Kolejność (wszystko idempotentne/
  bezpieczne do ponownego uruchomienia z `IF EXISTS`/`IF NOT EXISTS`):
  1. `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;`
  2. `UPDATE tasks SET tags = jsonb_build_array(category) WHERE tags = '[]'::jsonb AND category IS NOT NULL AND btrim(category) <> '';`
     — stara `category` → pojedynczy tag (patrz „Pytania" re mapowanie 1:1 / pomijanie 'Ogólne').
  3. `DROP INDEX IF EXISTS tasks_household_series_idx;` (indeks po `series_id`).
  4. `ALTER TABLE tasks DROP COLUMN IF EXISTS date, DROP COLUMN IF EXISTS time,
     DROP COLUMN IF EXISTS estimated_minutes, DROP COLUMN IF EXISTS category,
     DROP COLUMN IF EXISTS series_id, DROP COLUMN IF EXISTS series_index,
     DROP COLUMN IF EXISTS recurrence;`
  5. (Opcjonalnie, pod grupowanie/filtr tagów) `CREATE INDEX IF NOT EXISTS tasks_tags_idx ON tasks USING gin (tags);`
  UWAGA: nie ruszamy tabeli `events` — zostaje z `date`/`series_id`/`series_index`/`recurrence`.
  Wzorzec nagłówka/komentarzy: `013_life_normalized.sql` i `008_meals_normalized.sql`.
- `src/types.ts` — `interface Task`: usunąć `date`, `time`, `estimatedMinutes`, `seriesId`,
  `seriesIndex`, `recurrence`, `category`; dodać `tags: string[]`. Zachować `priority`, `isFocus`,
  `energy`, `status`, `description`, `completedAt`, `visibility`, `ownerId`, `version`, `createdAt`,
  `updatedAt`. `Recurrence`/`RecurrenceFreq` ZOSTAJĄ (używa ich `CalendarEvent`). `QuickAddType`
  bez zmian.

**Backend (warstwa backend):** `server/src/life.mjs` (route handlery w `server/src/server.mjs`
montują tylko GET/mutations/reset — bez zmian; worker bez zmian).

- `server/src/life.mjs` — sekcja zadań (reużyj istniejących helperów `isStringArray`-odpowiednika z
  `meals.mjs` jako wzoru — tu trzeba dodać lokalny `isStringArray`/`MAX_TASK_TAGS`, bo `life.mjs`
  nie importuje z `meals.mjs`):
  - `TASK_SELECT_COLUMNS` — usunąć `date::text AS date, time, estimated_minutes, category,
    series_id, series_index, recurrence`; dodać `tags`.
  - `taskRowToDto` — usunąć mapowanie `date/time/estimatedMinutes/category/seriesId/seriesIndex/
    recurrence`; dodać `tags: Array.isArray(row.tags) ? row.tags : []`.
  - `validateTaskCreatePayload` — usunąć walidacje `date/time/estimatedMinutes/category` i wywołanie
    `validateSeriesFields`; dodać walidację `tags` (tablica stringów, cap długości i liczby, wzór
    `recipes.tags`). `visibility`/`isFocus`/`energy`/`priority`/`status`/`description`/`completedAt`
    zostają.
  - `TASK_UPDATE_KEYS` + `validateTaskUpdatePayload` — usunąć `date/time/estimatedMinutes/category/
    seriesId/seriesIndex/recurrence`; dodać `tags` (absolutny set jak `completedDates`).
  - `execTaskCreate` — INSERT bez kolumn dat/serii/category, z `tags` (`$n::jsonb`,
    `JSON.stringify(data.tags)`); można uprościć/zostawić `SAVEPOINT life_create` + obsługę 23505
    (deterministycznych id serii już nie ma, ale guard na kolizję zwykłego id jest nieszkodliwy).
  - `execTaskUpdate` — UPDATE bez pól dat/serii/category; dodać `tags = COALESCE($n::jsonb, tags)`.
  - `validateSeriesFields`/`isSeriesIndex`/`validateRecurrence` ZOSTAJĄ (używa ich `event.*`).
  - `SUPPORTED_LIFE_OPS` bez zmian (`task.create/update/delete` zostają).

**Frontend (warstwa frontend):**

- `src/lib/schema.ts` — `taskSchema`: usunąć `date/time/estimatedMinutes/category/seriesId/
  seriesIndex/recurrence`; dodać `tags: z.array(z.string().trim().max(50)).max(20).catch([])` (albo
  `.default([])`) — kompatybilność wsteczna: zod `.object` domyślnie odrzuca nadmiarowe klucze
  starych rekordów (date/category znikają cicho), a `tags` z domyślną `[]` nie wywala hydratacji
  starych zadań bez tagów. `recurrenceSchema`/`eventSchema` ZOSTAJĄ.
- `src/store/useLifeRecordsStore.ts`:
  - `TASK_UPDATE_KEYS` (tablica klienta) — zsynchronizować z backendem: usunąć date/time/
    estimatedMinutes/category/series/recurrence, dodać `tags`.
  - `taskCreatePayload` — usunąć pola dat/serii/category, dodać `tags`.
  - `addTask` — bez zmian strukturalnie (przyjmuje `Omit<Task,...>`), tylko nowy kształt `Task`.
  - `updateTask` — bez zmian (generyczne `pickChanges` po `TASK_UPDATE_KEYS`); obsłuży `tags`.
  - `toggleTask`/`toggleFocus` — usunąć logikę `focusDay`/`task.date` (limit 3 liczony globalnie po
    `isFocus && status!=='done'`, bez grupowania po dacie).
  - USUNĄĆ: `moveTaskToTomorrow`, `addRecurringTask`, `updateSeries`, `deleteSeries` (akcje serii
    zadań) — wraz z wpisami w interfejsie `LifeRecordsActions`. `expandRecurringSeries` zawęzić do
    samych wydarzeń (dziś rozszerza `tasks` i `events`; zostawić tylko `events`).
  - `addRecurringEvent`/`updateEventSeries`/`deleteEventSeries`/`expandRecurringSeries` (część
    eventowa) ZOSTAJĄ.
  - Import `occurrenceDate`/`expandSeries`/`SERIES_WINDOW` z `src/lib/recurrence.ts` — zostaje dla
    wydarzeń (nie usuwać).
- `src/store/useLifeRecordsStore.test.ts` — usunąć/zaktualizować testy zadań: `addRecurringTask`,
  `updateSeries` (limit count, przeszłe wystąpienia), `deleteSeries` dla zadań; zamienić `category`
  na `tags` w fixture'ach tworzenia zadań; usunąć `date`/`estimatedMinutes` z fixture'ów. Testy
  serii WYDARZEŃ (`addRecurringEvent`/`updateEventSeries`) zostają.
- `src/pages/TasksPage.tsx` — przeprojektowanie:
  - Usunąć typ `TaskFilter` oparte na dacie i tablicę `filters` (today/inbox/upcoming). Wprowadzić
    `statusFilter: "active" | "done"` + `groupBy: "priority" | "tag" | "none"` (+ opcjonalny filtr
    po wybranym tagu). Zachować `query` (szukać po `title` i `tags`, nie po `category`) i ewentualnie
    filtr energii (patrz „Pytania").
  - `counts`/`task-stats`: usunąć `overdueCount`/`isOverdue` i „do przeplanowania"; `focusCount`
    liczyć bez warunku daty; zostawić „ukończone łącznie". „X/3 priorytety dnia" — patrz „Pytania".
  - `visibleTasks` → budowanie sekcji: pomocnicza funkcja grupująca (priority→3 sekcje; tag→sekcje
    per tag + „Bez tagu"; none→jedna sekcja). Sort wewnątrz: `isFocus` najpierw, potem stabilnie
    (createdAt/title — patrz „Pytania"). Renderować `TaskItem` w każdej sekcji, `EmptyState` gdy
    pusto.
  - `TaskEditModal` (w tym pliku): usunąć pola Data/Godzina/Czas/Obszar(category)/Recurrence i całą
    obsługę `onSaveSeries`/`onDeleteSeries`/`repeat`/`RecurrenceFields`; dodać pole tagów (input
    zamieniający tekst na `string[]`, np. rozdzielany przecinkami/enterem). Zostają: Nazwa, Notatka,
    Ważność, Energia, Widoczność, Usuń. `eyebrow` modala bez „Termin".
  - Usunąć nieużywane importy (`isAfter`/`parseISO`/`isOverdue`/`RecurrenceFields`/`Repeat`/ikony
    kalendarzowe).
- `src/components/TaskItem.tsx` — usunąć render `task.date`/overdue (`isOverdue`, `relativeDay`,
  `CalendarClock`), `task.estimatedMinutes` (`formatMinutes`, `Clock3`), `category-tag` po
  `task.category`, ikonę serii (`task.seriesId`, `Repeat`) oraz pozycję menu „Przenieś na jutro"
  (`moveTaskToTomorrow`, `CalendarClock`). Dodać render `task.tags` (np. lista chipów). Zostają:
  checkbox, tytuł, opis, `private-badge`, `focus-label`, `priority-high`.
- `src/components/QuickAddModal.tsx` — formularz zadania:
  - Usunąć dla `type==='task'`: sekcję „Dodaj termin i szczegóły" z Data/Godzina/Ile czasu
    (`duration`/`estimatedMinutes`), pole Obszar(category) i checkbox „Powtarzaj"+`RecurrenceFields`
    (recurrence zostaje tylko dla `type==='event'`). Usunąć wywołania `addRecurringTask`.
  - Dodać dla zadania: pole tagów; zostawić checkbox „Zadanie priorytetowe" (`isFocus`), Ważność,
    Energia, Widoczność. `parseSmartCapture` dla zadań: użyć tylko `parsed.title` (czyszczenie
    frazy), IGNORUJĄC `parsed.date`/`parsed.time` (nie ustawiać daty zadania). Podpowiedź
    `smart-hint` o „jutro/godzinie" pokazywać tylko dla event/reminder.
  - Pola Data/Godzina i recurrence dla event/reminder ZOSTAJĄ bez zmian.
- `src/pages/TodayPage.tsx`:
  - `focusTasks` — zostawić `isFocus && status==='todo'`, usunąć warunek `task.date`.
  - Usunąć `todayTasks`/`todayOpenTasks`/`todayDoneTasks` oparte na `task.date === today`,
    `tomorrowTasksCount`, oraz `taskItems` (zadania z `task.time`) z `agenda` — agenda pokazuje
    już tylko wydarzenia. Postęp/`progress` (dziś liczony z todayDoneTasks) — przeliczyć na bazie
    `focusTasks` albo usunąć (patrz „Pytania"). Nagłówek „Masz dziś N rzeczy" — oprzeć na
    `focusTasks`/otwartych zadaniach bez daty.
  - `scratchToTask` — usunąć `date: today` i `category: "Prywatne"`; ustawić `tags: []` (lub jeden
    domyślny tag). `AgendaItem.meta = task.category` → usunąć gałąź task z agendy (nie ma zadań w
    agendzie).
- `src/pages/CalendarPage.tsx` — usunąć całą integrację zadań: `selectedTasks`, `dayTasks`, mapowanie
  zadań na `week-event`/`agenda-event--task`, `editingTask`/`setEditingTask`, `<TaskEditModal>` i
  samą definicję `TaskEditModal` w tym pliku (jej pola dat/category/estimatedMinutes są martwe),
  akcje `updateTask/deleteTask/updateSeries/deleteSeries` używane tylko przez ten modal. Kalendarz
  pokazuje wyłącznie wydarzenia. `EventEditModal` i seria wydarzeń ZOSTAJĄ.
- `src/components/CommandPalette.tsx` — w mapowaniu zadań `meta: \`Zadanie · ${task.category}\`` i
  `\`${task.title} ${task.category}\`` (linie ~168–176) zamienić `task.category` na `task.tags`
  (np. `task.tags.join(" ")`).
- `src/styles.css` — dodać style chipów tagów zadania (reużyć wyglądu istniejącego `.category-tag`).
  Reguły `.category-tag--praca/--zdrowie/--finanse` (linie ~1790–1812) stają się martwe po usunięciu
  `category` z `TaskItem` — usunąć lub przemapować na generyczny chip taga. Sprawdzić, czy
  `.category-tag` nie jest używane poza zadaniami (grep: tylko `TaskItem.tsx`).
- Sprawdzić importy/utility, które przestają być używane przez zadania, ale ZOSTAJĄ dla innych
  kolekcji: `isOverdue`/`relativeDay`/`formatMinutes` (`src/lib/date.ts`) — nadal używane przez
  wydarzenia/inne moduły, nie usuwać; `RecurrenceFields`/`useRecurrenceForm`
  (`src/components/RecurrenceFields.tsx`) — zostają dla wydarzeń.

## Kryteria akceptacji

- [ ] `Task` (w `src/types.ts`, `schema.ts`, `life.mjs`) nie ma `date`/`time`/`estimatedMinutes`/
  `category`/`seriesId`/`seriesIndex`/`recurrence`; ma `tags: string[]`.
- [ ] Migracja 014 na bazie z istniejącymi zadaniami: stara `category` ląduje w `tags`, kolumny
  dat/serii są usunięte, dawne serie zadań są zwykłymi zadaniami (bez `series_id`); `events`
  nietknięte.
- [ ] `TasksPage`: brak widoków opartych na dacie; działa przełącznik grupowania wg ważności / wg
  tagu / bez grupowania; wyszukiwanie po tytule i tagach.
- [ ] `TodayPage`: „Najważniejsze dzisiaj" pokazuje zadania z `isFocus` niezależnie od daty; brak
  zadań w agendzie/„jutro"; strona się nie wywala bez pól daty.
- [ ] `CalendarPage`: zadania nie pojawiają się ani w siatce tygodnia, ani w agendzie dnia; edycja
  zadań tylko z `TasksPage`.
- [ ] `QuickAddModal`: dodanie zadania nie oferuje daty/godziny/czasu/powtarzalności; oferuje tagi,
  ważność, priorytet dnia, energię, widoczność. Recurrence nadal działa dla wydarzeń.
- [ ] `TaskItem` pokazuje tagi zamiast daty/czasu/category; brak „Przenieś na jutro".
- [ ] Prywatne zadanie zapisane z tagami trafia do `user_workspace_states`-owego owner scope
  (`ownerId` z sesji), nie ujawnia się innym domownikom.
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą (w tym zaktualizowany
  `useLifeRecordsStore.test.ts`).
- [ ] Aplikacja odpala się i feature działa w preview, także na wąskim ekranie (PWA).

## Ryzyka

- **Migracja jednokierunkowa (DROP COLUMN).** Usunięcie kolumn dat/serii jest nieodwracalne bez
  backupu. Dane `date`/`time` zadań przepadają — to zamierzone (decyzja: „odciąć daty"), ale warto
  potwierdzić brak potrzeby archiwum. Wariant „wyzeruj zamiast DROP" jest w „Pytaniach".
- **Kompatybilność wsteczna localStorage.** Zustand persist trzyma stare zadania z `date`/`category`
  bez `tags`. `taskSchema` musi tolerować brak `tags` (`.default([])`/`.catch([])`) i cicho gubić
  usunięte pola, inaczej `merge`/`hydrateFromSnapshot` odrzuci rekordy (`parseArrayField` liczy
  `dropped` i pokazuje ostrzeżenie „dane uszkodzone").
- **Nie zepsuć wydarzeń.** `Recurrence`, `RecurrenceFields`, `src/lib/recurrence.ts`,
  `expandRecurringSeries` (część eventowa), seria wydarzeń w store i `CalendarPage`/`QuickAddModal`
  MUSZĄ zostać. Ryzyko przy „hurtowym" usuwaniu recurrence — usuwać tylko gałęzie `task.*`.
- **Granica prywatne/wspólne.** Tagi to zwykłe pole rekordu — `owner_id`/`visibility` bez zmian,
  `resolveOwnerId(ctx)=ctx.userId` (sesja) obowiązuje. Nie przepuścić `ownerId` z klienta.
- **Współbieżna edycja tagów.** Tagi jako absolutny set (jak `completedDates`): dwa urządzenia
  edytujące tagi tego samego zadania → OCC per rekord + cichy rebase w `applyMutationResults`
  reaplikuje deltę (nadpisuje całą tablicę). Ostatni zapis wygrywa całą listą tagów — akceptowalne,
  ale to nie jest merge pojedynczych tagów.
- **Zadania nigdy nie były w push/przypomnieniach.** `useReminderEngine`/`worker.mjs` obsługują
  tylko `reminders` (i inne moduły z godziną) — zadania nie mają tam wpisu. Zmiana dat zadań NIE
  wymaga zmian w workerze; to potwierdzenie, nie zadanie (dobrze udokumentować, by nie szukać).
- **Martwy CSS/utility.** Po usunięciu `category` z `TaskItem` reguły `.category-tag--*` i importy
  `isOverdue`/`formatMinutes` w plikach zadań stają się martwe — usunąć lokalnie, ale nie kasować
  współdzielonych helperów używanych przez inne moduły.

## Pytania do doprecyzowania

- [ ] „Dzisiaj" (`TodayPage`): potwierdzić, że zadania trafiają na dziś WYŁĄCZNIE przez `isFocus`
  (ręczny wybór), a nie żaden nowy mechanizm „na dziś". Czy „Dzisiejszy postęp"/pierścień ma liczyć
  ukończone spośród `isFocus`, czy w ogóle znika (bo bez dat nie ma „zadań dnia")?
- [ ] Migracja `category`→tag: mapować 1:1 KAŻDĄ kategorię (w tym domyślną „Ogólne"/„Prywatne"), czy
  pomijać wartości domyślne, żeby nie zaśmiecać tagów? Czy stare 5 kategorii ma zostać
  znormalizowane (np. lowercase) przy zamianie na tag?
- [ ] Sort w grupie „bez grupowania" (i wewnątrz sekcji): po czym po `isFocus`? Data utworzenia
  (najnowsze/najstarsze), alfabetycznie po tytule, czy po `priority`?
- [ ] Limit „3 priorytety dnia" (`isFocus`): zostaje jako twardy limit 3 (teraz liczony globalnie,
  nie per-dzień), czy znosimy/zmieniamy liczbę skoro nie ma już „dnia"?
- [ ] Tagi wspólne dla gospodarstwa czy per użytkownik? Rekomendacja: tagi to zwykły string na
  rekordzie (dziedziczą `visibility` zadania) — brak globalnej listy tagów. Czy potrzebna wspólna
  „paleta" istniejących tagów do podpowiedzi przy wpisywaniu (autouzupełnianie z już użytych)?
- [ ] Czy zostaje wymiar „energia" (`energy`) i jej filtr w `TasksPage`? Decyzje usuwają tylko
  date/time/estimatedMinutes — energia formalnie zostaje, ale ergonomicznie jest podobna do „ile
  czasu" i można ją rozważyć do usunięcia.
- [ ] Migracja: DROP COLUMN (czysty model, nieodwracalne) czy tylko wyzerowanie kolumn na NULL
  (niżej-ryzykowne, zostawia martwe pola)? Domyślnie plan zakłada DROP.
- [ ] Format wpisywania tagów w UI: input z separatorem (przecinek/enter zamienia na chip), czy
  prosty tekst dzielony po przecinku? Limit liczby tagów i długości pojedynczego taga (rekomendacja:
  do 20 tagów, do 50 znaków — jak cap w `recipes.tags`).
