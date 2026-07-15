# Zadania i wydarzenia powtarzalne (recurring)

> Plan wygenerowany przez skill `/plan-feature`. Slug: `zadania-wydarzenia-powtarzalne`. Branch: `claude/recurring-tasks-events-mplelp`.

## Kontekst / Problem

Użytkownik chce tworzyć zadania i wydarzenia, które powtarzają się co ustalony okres (np. „co tydzień", „co 2 tygodnie w pon/śr/pt", „co miesiąc 15."), bez ręcznego dodawania tej samej pozycji za każdym razem albo tworzenia kilku kopii naraz. Dziś `Task` i `CalendarEvent` to pojedyncze, jednorazowe wpisy w płaskich tablicach `LifeData` (`src/types.ts`), a jedyny „automatyzm" to derywowane powiadomienia w workerze (`server/src/worker.mjs`). Cel: dodać lekki wzorzec powtarzania z materializacją kilku wystąpień z góry, tak by od razu działały w istniejących widokach (lista zadań, kalendarz) i w powiadomieniach push — bez przepisywania modelu dokumentowego na znormalizowane tabele.

## Wymagania

- Przy tworzeniu **zadania** lub **wydarzenia kalendarza** można włączyć powtarzanie z regułą: **co N dni / tygodni / miesięcy**.
- Dla trybu tygodniowego: możliwość wskazania konkretnych **dni tygodnia** (np. pon+śr+pt), z zachowanym interwałem (co 1 lub co N tygodni).
- Dla trybu miesięcznego: powtarzanie wg **dnia miesiąca** (np. zawsze 15.; dzień kotwicy).
- Opcjonalny **limit liczby powtórzeń** (`count` — „powtórz N razy i zakończ"). Brak limitu = seria bezterminowa (utrzymujemy przesuwane okno przyszłych wystąpień).
- Wystąpienia serii są **materializowane** jako zwykłe `Task`/`CalendarEvent` — widoczne na liście zadań, w kalendarzu, liczone w filtrach i statystykach, i obsłużone przez istniejący worker powiadomień (30 min przed wydarzeniem) „za darmo".
- **Edycja serii** dotyczy całej serii (przyszłych, jeszcze niezmaterializowanych/nadchodzących wystąpień). **Usunięcie serii** kasuje wszystkie jej wystąpienia.
- UI po polsku, dostępny (a11y) i użyteczny na wąskim ekranie (PWA).
- Nowe pola muszą przejść przez zod (`taskSchema`/`eventSchema`), inaczej zostaną odrzucone przy hydratacji store (`merge`) i przy `applyData` w synchronizacji, oraz zachowane w kopii zapasowej (`backupEnvelopeV2Schema`).
- Materializacja musi być **deterministyczna i idempotentna** — dwa urządzenia nie mogą wygenerować różnych `id` dla tego samego logicznego wystąpienia (trójstronne scalanie po `id`).

## Zakres i Non-goals

**W zakresie (v1):**
- Reguła powtarzania: `daily` / `weekly` (+ dni tygodnia) / `monthly` (wg dnia miesiąca), interwał `co N`.
- Limit `count` (liczba wystąpień) lub brak limitu (bezterminowo).
- Materializacja okna przyszłych wystąpień (domyślnie ~10) i dosuwanie go w czasie.
- Edycja całej serii (tytuł, godziny, obszar, reguła itd. dla przyszłych wystąpień) i usunięcie całej serii.
- UI: przełącznik „Powtarzaj" w `QuickAddModal` (task + event) oraz w modalach edycji; wskaźnik „seria" na pozycjach.

**Non-goals (świadomie pomijamy w v1):**
- Pełny RRULE / RFC5545 (BYSETPOS, wyjątki EXDATE, „drugi wtorek miesiąca" itp.).
- Data zakończenia serii (`until`) — tylko `count` lub brak limitu.
- Edycja/usuwanie/pomijanie **pojedynczego** wystąpienia (only „cała seria"). Ukończenie pojedynczego zadania z serii nadal działa (to nie usunięcie).
- Powtarzalność dla `Reminder` i `Habit` (bez zmian).
- Wirtualne wystąpienia liczone w locie (świadomie wybieramy materializację).

## Podejście

### Model danych — rekomendacja: Wariant A (pola serii bezpośrednio na `Task`/`CalendarEvent`)

Każde wystąpienie to normalny `Task`/`CalendarEvent` z dodatkowymi, **opcjonalnymi** polami serii. Reguła powtarzania jest **replikowana na każdym wystąpieniu** (self-describing), razem ze stabilnym `seriesId` i porządkowym `seriesIndex`.

**Dlaczego Wariant A, a nie B (osobna kolekcja `recurringSeries` w `LifeData`):**
- Serwer dzieli i scala dane po **stałej liście kolekcji**: `LIFE_COLLECTIONS = ["tasks","events","reminders","notes","habits"]` w `server/src/workspace.mjs` (`splitWorkspaceData`/`mergeWorkspaceData`). Nowa kolekcja `recurringSeries` **nie byłaby** partycjonowana po `visibility` (trafiłaby w całości do części wspólnej przez `{...life}`), więc prywatne reguły wyciekłyby do gospodarstwa — wymagałoby to zmian w backendzie (`workspace.mjs`), `workspaceDocumentIsValid`, `mergeById`, w schematach i w `WorkspaceSync`/`replaceWithEmptyWorkspace`.
- W Wariancie A pola serii to zwykłe klucze rekordu `Task`/`CalendarEvent`. Serwer robi `structuredClone` i zachowuje wszystkie klucze pozycji (`withOwner` dotyka tylko `ownerId`/`visibility`), więc pola serii przechodzą przez split/merge/worker **bez żadnej zmiany w backendzie**.
- Wystąpienia od razu działają w istniejących widokach, filtrach (`TasksPage`, `CalendarPage`), statystykach i w `derivedReminders()` — bo to zwykłe eventy/zadania.
- Koszt Wariantu A: logika rozwijania okna i edycji „całej serii" po stronie klienta. Akceptowalny i izolowany w jednym module (`src/lib/recurrence.ts`).

Wariant B daje czystszy rozdział reguła/wystąpienie, ale jego koszt integracyjny (backend + schemat + merge + backup + sync) jest nieproporcjonalny do prostoty wzorca „co N". Odrzucamy.

### Kształt reguły powtarzania

```ts
// src/types.ts
export type RecurrenceFreq = "daily" | "weekly" | "monthly";

export interface Recurrence {
  freq: RecurrenceFreq;
  interval: number;        // co ile jednostek, liczba całkowita >= 1
  weekdays?: number[];     // TYLKO dla freq="weekly"; ISO 1=pon … 7=niedz, posortowane, unikalne, min. 1
  count?: number;          // limit liczby wystąpień (>= 1) LICZONY OD KOTWICY; brak = bezterminowo
  anchorDate: string;      // "yyyy-MM-dd" — data wystąpienia seriesIndex=0 (start serii, self-sufficient)
  anchorTime?: string;     // "HH:mm" — dla eventów startTime kotwicy; task może nie mieć godziny
}
```

Pola serii na `Task` i `CalendarEvent` (wszystkie **opcjonalne**, dla wstecznej zgodności):

```ts
seriesId?: string;       // wspólny dla całej serii (generateId() raz przy tworzeniu)
seriesIndex?: number;    // 0-based porządek chronologiczny wystąpienia w serii
recurrence?: Recurrence; // reguła zreplikowana na każdym wystąpieniu (self-describing)
```

**Semantyka `id` wystąpienia (kluczowe dla sync):** `id = \`${seriesId}#${seriesIndex}\`` — deterministyczne. Dwa urządzenia dla tego samego `seriesId` i `seriesIndex` policzą **identyczny** `id`, więc trójstronne scalanie po `id` (`mergeWorkspaceChanges` w `src/server/workspaceMerge.ts`, `mergeById` w `server/src/workspace.mjs`) automatycznie deduplikuje — brak podwójnych wystąpień.

**Generowanie dat (deterministyczne, przez `date-fns`):**
- `daily`: `anchorDate + k*interval` dni, `k = 0,1,2,…` (`addDays`).
- `weekly` bez `weekdays`: `anchorDate + k*interval` tygodni (`addWeeks`).
- `weekly` z `weekdays`: bloki po `interval` tygodni licząc od **tygodnia ISO (poniedziałek) kotwicy** (stały `weekStartsOn: 1` w generatorze — niezależnie od `preferences.weekStartsOnMonday`, aby determinizm był identyczny na wszystkich urządzeniach/kontach); w każdym bloku emituj wskazane dni tygodnia w kolejności chronologicznej; pomiń daty przed `anchorDate`. `seriesIndex` = pozycja chronologiczna. UI zapewnia, że `anchorDate` jest pierwszym zaznaczonym dniem tygodnia w dniu/po dniu wybranym przez użytkownika.
- `monthly` (wg dnia miesiąca): `anchorDate + k*interval` miesięcy (`addMonths` — klampuje przepełnienie: 31 → ostatni dzień krótszego miesiąca). Dzień miesiąca bierzemy z `anchorDate`.

`count` liczy wystąpienia **łącznie z kotwicą** (indeksy `0..count-1`).

### Gdzie i kiedy następuje materializacja (rozwijanie okna)

Cała logika w nowym, czystym module **`src/lib/recurrence.ts`** (bez zależności od store), z funkcjami:
- `occurrenceDate(recurrence, index): { date, time? }` — mapuje `seriesIndex` → data/godzina.
- `buildSeriesOccurrence(base, recurrence, seriesId, index)` — buduje `Task`/`CalendarEvent` dla indeksu (id, date, seriesIndex, recurrence).
- `expandSeries(items, today, window=10)` — czysta funkcja: dla każdego `seriesId` obecnego w `items` **dołącza brakujące przyszłe wystąpienia** tak, by istniało ~`window` wystąpień z datą `>= today`, z zachowaniem limitu `count`.

Zasady, które robią rozwijanie **idempotentnym i bezpiecznym dla sync**:
- **Tylko dodawanie w przód (frontier), bez backfillu luk.** Dla serii znajdź `M = max(seriesIndex)` obecnych wystąpień; twórz wyłącznie indeksy `> M`. Dzięki temu wystąpienie ukończone/usunięte w środku serii **nie zostaje wskrzeszone**, i nie zależymy od obecności kotwicy (index 0).
- **Nigdy nie nadpisuj istniejących wystąpień** (po `id`) — chroni per-wystąpienie zmiany (np. `status: "done"`, `completedAt`).
- Deterministyczne `id` → gdy dwa urządzenia niezależnie rozwiną okno, powstają te same `id`, a merge je scala bez duplikatów.

Punkty wywołania `expandSeries` (materializacja):
1. **Przy utworzeniu serii** — nowe akcje store `addRecurringTask` / `addRecurringEvent` tworzą wystąpienia `0..min(window, count-1)` od razu.
2. **Przy starcie aplikacji / zmianie dnia** — lekki „reconcile" po hydratacji store i przy powrocie do aplikacji (`visibilitychange`/`focus`), aby dosunąć okno serii bezterminowych, gdy `today` się przesunął. Implementacja: mała akcja store `expandRecurringSeries()` wołana z istniejącego hooka montującego (np. w komponencie root/`App` albo obok logiki „dziś") — do doprecyzowania miejsce; nie wolno wołać w trakcie `applyingRemote` w `WorkspaceSync`, żeby nie mieszać z zapisem remote (patrz Ryzyka).

Uwaga o sync: każde rozwinięcie okna mutuje store → `scheduleSave` w `WorkspaceSync` wyśle zapis. To jest OK (idempotentne, deterministyczne id). Trzeba tylko upewnić się, że `expandRecurringSeries()` nie odpala się w pętli (wołać najwyżej raz na montaż i na zmianę dnia; jest no-op, gdy okno pełne).

### Edycja i usuwanie serii

- **Edycja serii (całość):** nowe akcje `updateSeries(seriesId, changes)` (task) i `updateEventSeries(seriesId, changes)` — aktualizują wspólne pola treści (tytuł, godziny, obszar, `kind`, `visibility`, reguła) na **przyszłych** wystąpieniach (`date >= today`), zachowując przeszłe/ukończone bez zmian. Jeśli zmienia się reguła (interwał/dni/miesiąc) → przelicz daty przyszłych wystąpień z nowej `Recurrence` (te same `seriesIndex`, nowe `date`) i wywołaj `expandSeries`. Semantyka MVP: prosto — zachowaj `seriesIndex`, przelicz daty od bieżącej granicy.
- **Usunięcie serii:** `deleteSeries(seriesId)` / `deleteEventSeries(seriesId)` filtruje wszystkie pozycje o danym `seriesId`.
- **Pojedyncze wystąpienie:** istniejące `deleteTask`/`deleteEvent` nadal usuwają jedną pozycję (nie jest to eksponowane jako główna ścieżka; per-wystąpienie edycja jest non-goal). Ryzyko „wskrzeszenia" ostatniego (frontier) wystąpienia opisane w Ryzykach.

### Wpływ na backend / worker

**Backend: — brak zmian wymaganych.** Uzasadnienie:
- `server/src/workspace.mjs` (`splitWorkspaceData`/`mergeWorkspaceData`) operuje na kolekcjach `tasks`/`events` po `visibility` i kopiuje całe rekordy — nowe pola (`seriesId`, `seriesIndex`, `recurrence`) przechodzą bez zmian.
- `workspaceDocumentIsValid` sprawdza tylko, że kolekcje są tablicami i limit długości — nowe pola nie łamią walidacji. (Uwaga pojemnościowa: serie bezterminowe zwiększają liczbę pozycji; limit to 100 000 na kolekcję — z okratowaniem ~10 wystąpień na serię jest bezpiecznie.)
- `server/src/server.mjs` (`PUT/GET /api/v1/workspace`) — bez zmian; kontrakt dokumentowy niezmieniony.
- `server/src/worker.mjs` — bez zmian. `derivedReminders()` czyta wyłącznie `event.date`/`event.startTime`/`event.title`/`event.id`. Zmaterializowane wystąpienia serii to zwykłe eventy → powiadomienia „30 min przed" działają automatycznie, każde wystąpienie ma unikalny `id` (`seriesId#index`), więc dedup deliveries (`notification_deliveries` po `reminder_id`+`occurrence`) działa poprawnie. Zadania (`Task`) nie generują push i tu bez zmian.

Materializacja jest **w całości po stronie klienta** — serwer i worker są pasywne.

## Pliki do zmiany

### Baza (warstwa danych)

- `server/migrations/` — **— brak —**. Model jest dokumentowy (JSONB w `workspace_states`/`user_workspace_states`); nowe pola to dodatkowe klucze w istniejących kolekcjach `tasks`/`events`. Żadnej migracji SQL.
- `src/types.ts` — dodać `RecurrenceFreq`, interfejs `Recurrence` oraz opcjonalne pola `seriesId?`, `seriesIndex?`, `recurrence?` do `Task` i `CalendarEvent`. (Współdzielone typy = warstwa danych; napędza handoff do backendu/frontu.)
- `src/lib/schema.ts` — dodać `recurrenceSchema` (zod) i rozszerzyć `taskSchema` oraz `eventSchema` o opcjonalne `seriesId`/`seriesIndex`/`recurrence`. **Krytyczne:** bez tego pola zostaną wycięte przy `merge` w store i przy `lifeDataSchema.parse` w `WorkspaceSync.applyData`, oraz przy `backupEnvelopeV2Schema` (import/eksport kopii). Walidacja: `interval` `z.number().int().min(1)`; `weekdays` `z.array(z.number().int().min(1).max(7)).min(1).optional()`; `count` `z.number().int().min(1).optional()`; `anchorDate` = istniejący `isoDate`; `anchorTime` = istniejący `clockTime` opcjonalnie. Reużyj istniejących helperów `isoDate`/`clockTime`. Ponieważ `lifeDataSchema` i `backupEnvelopeV2Schema` składają się z `taskSchema`/`eventSchema`, backup jest pokryty automatycznie — bez osobnej zmiany w kształcie backupu.

### Backend (warstwa backend)

- **— brak —** (uzasadnienie w sekcji „Wpływ na backend / worker"). Orkiestrator: pominąć warstwę backend. Do świadomości: `server/src/workspace.mjs`, `server/src/server.mjs`, `server/src/worker.mjs` **nie wymagają** zmian; nowe pola przechodzą przez split/merge/worker tranzytem. Jedyny „kontrakt" do utrzymania: `id` wystąpień muszą pozostać stabilne i deterministyczne (front), by scalanie po `id` nie tworzyło duplikatów.

### Frontend (warstwa frontend)

- `src/lib/recurrence.ts` (**nowy**) — czysta logika serii: `occurrenceDate`, `buildSeriesOccurrence`, `expandSeries`, `nextOccurrences`. Reużyj `date-fns` (`addDays`, `addWeeks`, `addMonths`, `format`, `parseISO`, `getISODay`/`getDay`) i `src/lib/date.ts` (`dateKey`), oraz `generateId` z `src/lib/id.ts` (tylko dla `seriesId`; `id` wystąpienia jest deterministyczne). Bez zależności od zustand — łatwe do testów.
- `src/store/useLifeStore.ts` — nowe akcje: `addRecurringTask`, `addRecurringEvent`, `updateSeries`/`updateEventSeries`, `deleteSeries`/`deleteEventSeries`, `expandRecurringSeries()` (dosuwanie okna). Reużyj istniejących wzorców `addTask`/`addEvent` (owner/visibility defaults, `updatedAt`). Zwykłe `addTask`/`addEvent`/`updateTask`/`deleteTask` pozostają dla pozycji jednorazowych.
  - Rozważ czy `version` w `persist` wymaga bumpa: **nie** — pola są opcjonalne i addytywne; stare dane bez tych pól są nadal poprawne (optional), `merge` per-pozycja przez `safeParse` je zaakceptuje. Bump byłby potrzebny tylko przy niezgodnej zmianie kształtu. (Zaznaczyć w PR, że świadomie nie bumpujemy.)
- `src/components/QuickAddModal.tsx` — dodać sekcję „Powtarzaj" (widoczną dla `type === "task"` i `type === "event"`): przełącznik on/off, wybór `freq` (dzień/tydzień/miesiąc), pole `interval` („co N"), dla `weekly` multiselect dni tygodnia (pon…niedz), opcjonalny `count` („powtórz N razy"). Po włączeniu → `addRecurringTask`/`addRecurringEvent`. Reużyj istniejący `parseSmartCapture`, `dateKey`, wzorce pól `.field`/`.form-grid`.
- `src/pages/TasksPage.tsx` (`TaskEditModal`) — pola edycji serii (gdy `task.seriesId`): edycja reguły + akcje „Zapisz dla całej serii" / „Usuń całą serię" (`updateSeries`/`deleteSeries`). Wskaźnik „seria" (ikona/etykieta) na pozycji. Zachować obecną edycję pojedynczego zadania dla pozycji bez serii.
- `src/pages/CalendarPage.tsx` (`EventEditModal`, oraz `TaskEditModal` w tym pliku) — analogicznie: edycja/usuwanie serii dla eventów (`updateEventSeries`/`deleteEventSeries`), wskaźnik serii w widoku kalendarza.
- `src/components/TaskItem.tsx` — (opcjonalnie) mały wskaźnik powtarzalności (ikona `Repeat` z `lucide-react`) przy pozycjach z `seriesId`; a11y `aria-label` „Zadanie powtarzalne".
- Wywołanie `expandRecurringSeries()` przy montażu/zmianie dnia — do wpięcia w root (`src/App.tsx` lub istniejący hook „dziś"); **nie** wewnątrz `applyingRemote` w `WorkspaceSync`.

**Testy (obowiązkowe pokrycie nowych pól):**
- `src/lib/recurrence.test.ts` (**nowy**) — determinizm dat dla daily/weekly(+weekdays)/monthly, klamp miesięczny (31.), `count`, idempotencja `expandSeries` (dwukrotne wywołanie = brak zmian), tylko-frontier (brak wskrzeszania usuniętych), stabilność `id`.
- `src/lib/schema.test.ts` — rozszerzyć: `taskSchema`/`eventSchema` akceptują poprawną `recurrence`, odrzucają błędne (`interval=0`, `weekday=8`, `count=0`).
- `src/store/useLifeStore.test.ts` — `addRecurringTask` tworzy okno, `deleteSeries` kasuje całość, `updateSeries` zmienia tylko przyszłe, `expandRecurringSeries` idempotentne.
- `src/server/workspaceMerge.test.ts` — scalanie dwóch urządzeń z tym samym `seriesId` nie tworzy duplikatów (deterministyczne `id`).

## Kryteria akceptacji

- [ ] Można utworzyć zadanie i wydarzenie z regułą „co N dni/tygodni/miesięcy"; dla tygodnia z wyborem dni; z opcjonalnym limitem `count`.
- [ ] Po utworzeniu serii widać kilka (~10) przyszłych wystąpień na liście zadań i w kalendarzu; każde ma stabilny, deterministyczny `id` (`seriesId#index`).
- [ ] Wydarzenia z serii generują powiadomienie push 30 min przed (bez zmian w workerze) — zweryfikowane, że worker czyta tylko `date`/`startTime`.
- [ ] Edycja serii zmienia przyszłe wystąpienia; usunięcie serii kasuje wszystkie jej wystąpienia; ukończenie jednego zadania z serii nie znika po dosunięciu okna.
- [ ] Dwa urządzenia rozwijające okno niezależnie nie tworzą duplikatów po synchronizacji (merge po `id`).
- [ ] Nowe pola przechodzą przez `merge` store, `applyData` (sync) i eksport/import kopii (`backupEnvelopeV2Schema`) bez utraty danych.
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą.
- [ ] Aplikacja odpala się i feature działa w preview (w tym na wąskim ekranie — to PWA); UI po polsku, kontrolki dostępne z klawiatury i z `aria-label`.

## Ryzyka

- **Determinizm `id` między urządzeniami** — jeśli `id` wystąpienia nie byłby czysto deterministyczny (np. `generateId()` na wystąpienie), dwa urządzenia zmaterializowałyby różne `id` i `mergeWorkspaceChanges` zostawiłby duplikaty. Mitygacja: `id = seriesId#seriesIndex`, `expandSeries` tylko dołącza brakujące indeksy, nigdy nie regeneruje.
- **Wskrzeszanie usuniętych wystąpień** — backfill luk odtworzyłby usunięte pozycje. Mitygacja: rozwijanie tylko w przód od `max(seriesIndex)`. Znane ograniczenie: usunięcie *ostatniego* (frontier) wystąpienia może zostać dosunięte ponownie — akceptowalne (per-wystąpienie delete to non-goal); do ewentualnego rozwiązania tombstone'ami w przyszłości.
- **Pętla zapisu przy rozwijaniu** — `expandRecurringSeries()` mutuje store → `scheduleSave`. Wołać najwyżej raz na montaż i na zmianę dnia; funkcja musi być no-op, gdy okno pełne, i nie może działać w trakcie `applyingRemote` (`WorkspaceSync`), by nie kolidować z zapisem remote/rewizją (`409`).
- **Granica prywatne/wspólne** — pola serii dziedziczą `visibility`/`ownerId` z pozycji; `splitWorkspaceData` ustawia `ownerId` z sesji (nie z klienta). Zmiana `visibility` „całej serii" musi być spójna na wszystkich wystąpieniach, inaczej część serii trafi do innego dokumentu (shared vs private) i będzie scalana osobno.
- **Determinizm tygodnia** — grupowanie „co N tygodni" zależy od początku tygodnia; użycie stałego ISO poniedziałku w generatorze (niezależnie od `preferences.weekStartsOnMonday`) zapobiega rozjazdowi między użytkownikami.
- **Pojemność dokumentu** — serie bezterminowe rosną; okno ~10 + przeszłe wystąpienia trzymają rozmiar w ryzach (limit 100 000/kolekcja w `workspaceDocumentIsValid`), ale warto rozważyć okresowe „przycinanie" bardzo starych ukończonych wystąpień (poza v1).
- **Miesięczny 29–31** — `addMonths` klampuje (31 → 28/29/30); trzeba to jawnie przetestować, by nie zdublować/pominąć wystąpień.

## Decyzje doprecyzowujące (runda pytań — rozstrzygnięte)

Wszystkie kwestie z rundy pytań zostały rozstrzygnięte z użytkownikiem:

- **Rozmiar okna materializacji: `10`** przyszłych wystąpień (`date >= today`). Stała `SERIES_WINDOW = 10` w `src/lib/recurrence.ts`.
- **Powtarzanie miesięczne 29–31:** przy krótszym miesiącu **przesuwamy na ostatni dzień miesiąca** (zachowanie `addMonths` z `date-fns`, jak Google Calendar). Żadne wystąpienie nie ginie. Trzeba to jawnie pokryć testem (luty → 28/29).
- **Ukończone/przeszłe wystąpienia serii:** **zostają w historii** jak zwykłe zadania (widoczne w filtrze „Ukończone"). Auto-przycinanie starych wystąpień jest **non-goal v1** (ewentualnie w przyszłości).
- **Granica edycji serii:** edycja „całej serii" dotyczy wystąpień o `date >= dziś` (przyszłe i dzisiejsze, jeszcze nie w przeszłości); przeszłe/ukończone pozostają nietknięte. `updateSeries`/`updateEventSeries` przeliczają daty przyszłych wystąpień od tej granicy przy zmianie reguły.
- **Wskaźnik serii w UI:** **ikona `Repeat`** (z `lucide-react`) z `aria-label` „Zadanie powtarzalne" / „Wydarzenie powtarzalne". Bez tekstu reguły przy pozycji (czytelność na wąskim ekranie); pełna reguła jest edytowalna w modalu.
