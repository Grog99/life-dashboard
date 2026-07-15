# Widoczność prywatna/wspólna dla kolekcji „life"

> Plan wygenerowany przez skill `/plan-feature`. Slug: `visibility-options`. Branch: `claude/visibility-options-feature-g6q9j5` (istniejący branch repo — NIE `feature/visibility-options`).

## Kontekst / Problem

Dziś pięć podstawowych kolekcji „life" — zadania (`tasks`), wydarzenia (`events`), przypomnienia (`reminders`), notatki (`notes`) i rytuały/nawyki (`habits`) — jest zawsze wspólnych dla całego gospodarstwa. Wszystko, co ktokolwiek doda, widzą wszyscy domownicy. Kolekcje „zaawansowane" (finanse, podróże, subskrypcje, auto, zdrowie) mają już mechanizm wyboru widoczności prywatna/wspólna (`visibility: "private" | "household"` + `ownerId`), oparty o generyczny podział danych w `server/src/workspace.mjs` (`splitWorkspaceData`/`mergeWorkspaceData`) na `workspace_states` (wspólne) i `user_workspace_states` (prywatne per użytkownik).

Celem featurea jest rozszerzenie tego istniejącego mechanizmu na pięć kolekcji „life", tak aby każdy domownik mógł mieć własną przestrzeń zamiast domyślnie publicznej widoczności wszystkiego.

## Wymagania

- Przy tworzeniu zadania, wydarzenia, przypomnienia, notatki i rytuału pojawia się selektor widoczności: **„Tylko ja" (private) / „Cały dom" (household)**.
- **Domyślna widoczność nowych rekordów: „Tylko ja" (private).** Świadoma zmiana zachowania — użytkownik musi aktywnie wybrać „Cały dom", żeby udostępnić. (Decyzja użytkownika #1.)
- **Widoczność jest edytowalna także po utworzeniu** — selektor pojawia się również w formularzach edycji, analogicznie do `src/pages/TripsPage.tsx` (modal tworzenia + modal edycji). (Decyzja #2.)
- **Wskaźnik UI dla rekordów prywatnych** — widoczny znacznik (ikona kłódki / etykieta „Prywatne") na listach i w widoku kalendarza, wzorem `TripsPage.tsx` (`{trip.visibility === "household" ? "Wspólna" : "Prywatna"}`). (Decyzja #3.)
- **Wydarzenia z Google Calendar (`source === "google"`) także obsługują widoczność prywatną.** Tworzone są automatycznie przez synchronizację (nie przez formularz), więc dostają widoczność domyślną ustaloną w kodzie synchronizacji — patrz „Podejście" i decyzja poniżej. (Decyzja #4.)
- Rekordy prywatne trafiają wyłącznie do właściciela (odczyt i powiadomienia push), spójnie z `docs/ARCHITECTURE.md` („Prywatne rekordy trafiają tylko do subskrypcji ich właściciela").
- `ownerId` rekordu prywatnego jest ustalany **z sesji serwera, nigdy z wartości klienta** — reużycie istniejącej gwarancji w `withOwner()` (server nadpisuje `ownerId` sesyjnym `userId` dla `visibility === "private"` oraz dla sentinela `"me"`).
- Niefunkcjonalne: zero utraty ani nieoczekiwanego ujawnienia istniejących danych po wdrożeniu (patrz „Ryzyka" — migracja); brak złamania walidacji `workspaceDocumentIsValid` i limitu rozmiaru workspace; i18n PL (etykiety jak w istniejącym UI).

## Zakres i Non-goals

**W zakresie:**
- Pola `visibility?` i `ownerId?` na typach i schematach 5 kolekcji life (`src/types.ts`, `src/lib/schema.ts`).
- Rozszerzenie `splitWorkspaceData`/`mergeWorkspaceData` w `server/src/workspace.mjs` o `LIFE_COLLECTIONS` (dziś objęte tylko `META_COLLECTIONS`/`ADVANCED_COLLECTIONS`).
- Rozszerzenie workera push (`server/src/worker.mjs`) tak, aby prywatne przypomnienia notyfikowały tylko właściciela.
- Selektory widoczności w formularzach tworzenia i edycji + znaczniki „Prywatne" w UI list i kalendarza.
- Domyślna widoczność w kodzie synchronizacji Google Calendar.
- Testy: `server/test/workspace.node.mjs`, `src/store/useLifeStore.test.ts`.

**Non-goals (świadomie pomijamy):**
- Zmiana modelu z dokumentowego (JSONB) na znormalizowane tabele — poza zakresem (patrz „Dalsza ewolucja" w ARCHITECTURE.md).
- Współdzielenie granularne (np. „widoczne dla wybranej osoby") — tylko binarne private/household, jak w istniejącym mechanizmie.
- Migracja SQL/kolumny — dane trzymane są w dokumentach JSONB, brak zmian schematu bazy.
- Zmiana widoczności danych osobistych już per-user (`scratchpad`, `intention`, `energy`, `preferences`) — pozostają bez zmian (`PERSONAL_LIFE_KEYS`).

## Podejście

Reużywamy w całości istniejący, sprawdzony mechanizm z kolekcji zaawansowanych zamiast budować nowy:

1. **Dane (typy/schematy):** dodajemy opcjonalne `ownerId?: string` i `visibility?: Visibility` do `Task`, `CalendarEvent`, `Reminder`, `Note`, `Habit`. **Pola muszą być opcjonalne** (w TS i w Zod), bo istniejące rekordy ich nie mają — brak pola traktujemy wszędzie jako `household` (sprawdzenie zawsze przez `record.visibility === "private"`). Reużywamy istniejący `Visibility` z `src/advancedTypes.ts` oraz `visibilitySchema`/`idSchema` z `src/lib/schema.ts`.

2. **Backend (podział danych):** `splitWorkspaceData`/`mergeWorkspaceData` mają już generyczną pętlę dla kolekcji zaawansowanych + helper `withOwner(item, userId, isPrivate)`. Dodajemy analogiczną pętlę dla `LIFE_COLLECTIONS` na obiekcie `life` (dziś life dostaje tylko separację `PERSONAL_LIFE_KEYS`, a kolekcje idą w całości do `sharedLife`). Rekordy `visibility === "private"` z `ownerId` odseparowujemy do `privateLife[key]`, resztę zostawiamy w `sharedLife[key]`. `ownerId` prywatnych jest wymuszany z sesji przez istniejący `withOwner` — bez zmian w `server.mjs` (endpoint `PUT /api/v1/workspace` już wywołuje `splitWorkspaceData(body.data, session.user_id)`).

3. **Powiadomienia:** dziś worker dostarcza wspólne `life.reminders` z `workspace_states` do **wszystkich** domowników, a pętla prywatnych workspace'ów woła tylko `deliverDerived` (obsługuje `life.events` — 30 min przed — oraz encje advanced), ale **nie** przetwarza ręcznych `life.reminders`. Po przeniesieniu prywatnych przypomnień do `user_workspace_states` trzeba rozszerzyć pętlę prywatną o dostarczanie `life.reminders` zawężone do właściciela (`targetUserId = user_id`). Prywatne wydarzenia (event-reminder 30 min przed) już działają poprzez `deliverDerived(..., user_id)`.

4. **Google Calendar — decyzja o domyślnej widoczności: PRYWATNA (`private`).** Uzasadnienie oparte na kodzie: połączenie Google jest **per użytkownik** (`google_connections.user_id`, endpoint `/api/v1/integrations/google/sync` używa `session.user_id`), a eventy tworzone są klientowo w `CalendarPage.syncGoogle` przez `addEvent(changes)`. Domyślne `private` jest spójne z regułą #1 i semantycznie poprawne (event pochodzi z prywatnego kalendarza konkretnej osoby, nie powinien automatycznie trafiać do całego domu). Użytkownik może później przełączyć event na „Cały dom" w modalu edycji. Ta decyzja jest podjęta; w „Pytania do doprecyzowania" pozostaje jako jedno pytanie potwierdzające, bo istnieje realny tradeoff produktowy (relewantność dla domu).

5. **`ownerId` po stronie klienta:** reużywamy wzorzec z `TripsPage.tsx` (`const { snapshot } = useServerAuth(); const currentOwnerId = snapshot?.user.id ?? "me";`). Store `useLifeStore` domyślnie ustawia `visibility: "private"` i `ownerId: "me"` gdy nie podano, a formularze z selektorem przekazują wybraną `visibility` oraz `ownerId = currentOwnerId`. Sentinel `"me"` jest bezpieczny — serwerowy `withOwner` mapuje `"me"` → sesyjny `userId` (dla private oraz household), więc klient nigdy nie dyktuje właściciela rekordu prywatnego. W trybie lokalnym (`serverMode === false`) pola po prostu nie są rozdzielane — brak wpływu.

Odrzucona alternatywa: osobny, dedykowany mechanizm prywatności dla life — odrzucony, bo `workspace.mjs` już ma generyczny, przetestowany podział; duplikacja zwiększyłaby ryzyko rozjazdu granicy prywatności.

## Pliki do zmiany

Pogrupowane w trzy warstwy zgodnie z `implement-layered` (dane → backend → frontend).

### Baza (warstwa danych)

- **`src/types.ts`** — dodać opcjonalne `ownerId?: string` i `visibility?: Visibility` do interfejsów `Task`, `CalendarEvent`, `Reminder`, `Note`, `Habit`. Reużyć `Visibility` importując z `./advancedTypes` (już eksportuje `export type Visibility = "private" | "household"`). Brak zmian w `LifeData`/`QuickAddType`.
- **`src/lib/schema.ts`** — dodać `.optional()` `visibility` i `ownerId` do `taskSchema`, `eventSchema`, `reminderSchema`, `noteSchema`, `habitSchema`. **Uwaga na kolejność deklaracji:** `idSchema` i `visibilitySchema` są zdefiniowane niżej (linie ~118–122), *po* schematach life (linie 28–87) — trzeba je wyhoistować ponad schematy life albo zainline'ować (`z.enum(["private","household"]).optional()`). Pola muszą być opcjonalne, żeby `lifeDataSchema.parse()` (w `WorkspaceSync.applyData`) oraz `parseArrayField` (w store `merge`) nie odrzucały/nie usuwały istniejących rekordów bez tych pól. `backupEnvelopeSchema`/`backupEnvelopeV2Schema` pozostają kompatybilne (współdzielą `lifeDataSchema`).

*(Brak migracji SQL — dane life to dokumenty JSONB w `workspace_states`/`user_workspace_states`; brak zmian kolumn ani `server/src/db.mjs`.)*

### Backend (warstwa backend)

- **`server/src/workspace.mjs`** (rdzeń zmiany) — reużyć istniejące `withOwner`, `mergeById`:
  - `splitWorkspaceData`: po obecnej obsłudze `PERSONAL_LIFE_KEYS` dodać pętlę po `LIFE_COLLECTIONS` na obiekcie `life`: rekordy `item?.visibility === "private"` → `privateLife[key] = ...map(withOwner(item, userId, true))`; pozostałe → `sharedLife[key] = ...map(withOwner(item, userId, false))`. Zachować dotychczasowe usuwanie kluczy osobistych ze `sharedLife`.
  - `mergeWorkspaceData`: dla `LIFE_COLLECTIONS` scalać `mergeById(sharedLife[key], privateLife[key])` i aplikować `withOwner(item, userId, true)` dla `item?.visibility === "private"` (analogicznie do pętli advanced, linie 162–166). Obecnie sekcja life (linie 177–189) bierze kolekcje tylko ze `sharedLife` — trzeba to rozszerzyć, zachowując pola `scratchpad/intention/energy/preferences`.
  - `withOwner`: działa już poprawnie — dla rekordów bez `ownerId` (legacy/household) `"ownerId" in next` jest `false` → no-op (zostają wspólne); nowe rekordy prywatne mają oba pola. Zweryfikować, że nowy rekord prywatny life zawsze niesie `ownerId` (ustawiany w store/UI), inaczej `withOwner` nie nadpisze właściciela.
  - `workspaceDocumentIsValid`: dziś waliduje per-item tylko `ADVANCED_COLLECTIONS` (sprawdza `item.id`); dla life sprawdza jedynie `Array.isArray` + limit `> 100_000`. Nowe opcjonalne pola tego nie łamią. Opcjonalnie (nice-to-have) dołożyć lekką walidację `item.id`/`visibility` dla life — niewymagane do działania.
- **`server/src/worker.mjs`** — rozszerzyć pętlę `privateWorkspaces` (linie 220–226). Dziś woła tylko `deliverDerived(workspace, workspace.data, workspace.user_id)` (eventy 30 min przed + derived advanced). Dodać obsługę ręcznych `workspace.data.life.reminders` zawężoną do właściciela: filtr „due" jak w pętli wspólnej (linie 185–193) i `deliverReminder(workspace, reminder, workspace.user_id)`. **Nie** zapisywać `notifiedAt` z powrotem do `user_workspace_states` (brak kolumny `revision` → ryzyko nadpisania równoległej edycji użytkownika); deduplikację zapewnia już `notification_deliveries` (ON CONFLICT po `household_id, subscription_id, reminder_id, occurrence, channel`). Pętla wspólna (`workspace_states`, linie 179–219) pozostaje bez zmian — wspólne przypomnienia nadal notyfikują wszystkich.
- **`server/src/server.mjs`** — **brak zmian funkcjonalnych.** Zweryfikować (i potwierdzić w PR), że `PUT /api/v1/workspace` nadal woła `splitWorkspaceData(body.data, session.user_id)` (linia 506) oraz `GET` woła `mergeWorkspaceData(..., { userId: session.user_id, ... })` (linie 482–487) — `ownerId` pochodzi z sesji, nie z klienta.

### Frontend (warstwa frontend)

- **`src/store/useLifeStore.ts`** — w `addTask`/`addEvent`/`addReminder`/`addNote`/`addHabit` domyślnie ustawiać `visibility: <payload>.visibility ?? "private"` oraz `ownerId: <payload>.ownerId ?? "me"` (pola przechodzą przez istniejący `...task`/`...event` spread, wystarczy dodać fallbacki). `updateTask`/`updateEvent`/`updateNote` już przepuszczają `changes` (w tym `visibility`) — bez zmian strukturalnych. `exportData`/`replaceData` bez zmian.
- **`src/store/useLifeStore.test.ts`** — dodać asercje: nowy rekord bez podanej widoczności → `visibility === "private"`; przekazana `household` jest zachowywana; `ownerId` fallback `"me"`.
- **`src/components/QuickAddModal.tsx`** — główny formularz tworzenia dla `task`/`event`/`reminder`/`note`. Dodać selektor „Widoczność" (reużyć wzorzec z `TripsPage`, ale **z domyślną `private`**): `defaultValue="private"`, opcje `„Tylko ja" (private)` / `„Cały dom" (household)`. Dodać stan `visibility` (jak inne pola formularza, resetowany w `useEffect` na `open`). Odczytać `currentOwnerId` przez `useServerAuth()` i przekazać `visibility` + `ownerId: currentOwnerId` do wszystkich czterech wywołań `add*` (linie 110, 126, 140, 143).
- **`src/components/TaskItem.tsx`** — dodać znacznik prywatności w `task-meta` (linie 114–130): gdy `task.visibility === "private"` renderować `<span><Lock size={13} /> Prywatne</span>` (ikona `Lock`/`LockKeyhole` z `lucide-react`). To pokrywa listy zadań (TasksPage, TodayPage używają `TaskItem`).
- **`src/pages/TasksPage.tsx`** — w `TaskEditModal` (linie 215–285) dodać stan + pole „Widoczność" w `form-grid`, inicjalizowany z `task.visibility ?? "household"` (edycja: brak pola = obecnie wspólne), i dołożyć `visibility` do obiektu `onSave` (linie 239–248). `hasUnsavedChanges` uwzględnić nowe pole.
- **`src/pages/CalendarPage.tsx`** — (a) `EventEditModal` (linie 256–311): dodać selektor „Widoczność" (init `event.visibility ?? "household"`) i dołożyć `visibility` do `onSave` (linie 282–290); (b) `syncGoogle` (linie 64–91): do obiektów `changes` dla nowych eventów dodać `visibility: "private"` i `ownerId: currentOwnerId` (odczyt `currentOwnerId` przez `useServerAuth`) — dla istniejących eventów przy `updateEvent` **nie** nadpisywać widoczności (żeby nie cofać ręcznej zmiany użytkownika na „Cały dom"); (c) znacznik „Prywatne" na kafelkach `week-event` i `agenda-event` gdy `event.visibility === "private"`.
- **`src/pages/NotesPage.tsx`** — w `NoteCard` (linie 114–176): dodać do menu kontekstowego (linie 161–168) przełącznik widoczności (Prywatne/Wspólne, `onUpdate({ visibility })`) oraz badge „Prywatne" w nagłówku karty gdy `note.visibility === "private"`. `convertFirstLine` (tworzy task) i `QuickAdd` korzystają z domyślnej `private` w store.
- **`src/pages/HabitsPage.tsx`** — w `AddHabitModal` (linie 96–101) dodać selektor „Widoczność" (default `private`) i przekazać `visibility` + `ownerId` do `onAdd`→`addHabit`; w wierszu rytuału (`habit-name-cell`, linia 63) dodać znacznik „Prywatne" gdy `habit.visibility === "private"`. Odczyt `currentOwnerId` przez `useServerAuth`.
- **`src/pages/TodayPage.tsx`** — w karcie przypomnień (linie ~415–428) i agendzie dodać znacznik „Prywatne" gdy `visibility === "private"`; `scratchToTask` (linie 181–204) korzysta z domyślnej `private` w store (bez selektora — to szybka akcja).
- **`src/styles.css`** (lub odpowiedni plik w `src/styles/`) — drobny styl badge'a prywatności (reużyć istniejące klasy meta/`focus-label` jako wzorzec). Bez nowej architektury CSS.

*Reużywane utility/komponenty:* `Modal` (`src/components/Modal.tsx`), `useServerAuth`/`AuthSnapshot` (`src/server/AuthGate.tsx`, `src/server/api.ts`), `Visibility`/`withOwner`/`mergeById`/`splitWorkspaceData`/`mergeWorkspaceData` (`src/advancedTypes.ts`, `server/src/workspace.mjs`), wzorzec selektora i badge z `src/pages/TripsPage.tsx`.

## Kryteria akceptacji

- [ ] Selektor widoczności (domyślnie „Tylko ja") jest w formularzu tworzenia zadania, wydarzenia, przypomnienia, notatki i rytuału.
- [ ] Widoczność da się zmienić po utworzeniu (formularze/menu edycji) dla wszystkich 5 kolekcji.
- [ ] Rekordy prywatne mają widoczny znacznik „Prywatne" na listach i w kalendarzu; nie są widoczne u innych domowników po synchronizacji.
- [ ] Nowy rekord domyślnie ląduje jako prywatny (trafia do `user_workspace_states`, nie do `workspace_states`).
- [ ] Eventy z Google sync tworzą się jako prywatne właściciela; ręczna zmiana na „Cały dom" nie jest cofana przy kolejnej synchronizacji.
- [ ] Prywatne przypomnienie wywołuje push tylko u właściciela; wspólne — u wszystkich domowników (bez zmian).
- [ ] Istniejące rekordy (bez `visibility`) po wdrożeniu pozostają wspólne i nie znikają ani nie ujawniają się nietypowo (patrz „Ryzyka").
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą (w tym nowe testy w `server/test/workspace.node.mjs` dla splitu/merge life + `src/store/useLifeStore.test.ts` dla domyślnej widoczności).
- [ ] Aplikacja odpala się i feature działa w preview (także na wąskim ekranie — to PWA).

## Ryzyka

- **Migracja istniejących danych (krytyczne).** Istniejące zadania/notatki/przypomnienia/wydarzenia/rytuały są dziś zapisane w `workspace_states.life.*` bez `visibility`/`ownerId`, czyli wspólne. **Brak pola trzeba wszędzie traktować jako `household`** — split odseparowuje wyłącznie `visibility === "private"`. Gdyby brak pola był traktowany jako `private`, pierwszy zapis dowolnego użytkownika przypisałby wszystkie wspólne rekordy jemu jako prywatne (przez `withOwner`) i schowałby je reszcie domu. Dlatego: domyślną `private` ustawiamy **tylko dla nowych rekordów w momencie tworzenia (UI/store)**, a mechanizm split/merge i UI odczytu bazują na jawnym `=== "private"`. Testy muszą pokrywać rekord legacy bez pól.
- **Schemat Zod odrzucający legacy (krytyczne).** `lifeDataSchema.parse()` (`WorkspaceSync.applyData`) rzuca wyjątkiem na brakujących wymaganych polach → crash aplikacji; `parseArrayField` (store `merge`) po cichu **usuwa** rekordy niepasujące do schematu → utrata danych. Dlatego `visibility`/`ownerId` w life-schematach muszą być `.optional()`.
- **`workspaceDocumentIsValid` i limit rozmiaru.** Nowe pola nie zmieniają walidacji (life waliduje tylko `Array.isArray` + `length > 100_000`), ale warto potwierdzić, że dodanie dwóch krótkich pól per rekord nie przekracza `MAX_WORKSPACE_BYTES` przy dużych zbiorach — realnie pomijalne.
- **`ownerId` zawsze z sesji, nie z klienta.** Utrzymać istniejącą gwarancję: serwerowy `withOwner` nadpisuje `ownerId` sesyjnym `userId` dla `private` (i dla sentinela `"me"`). Klient przekazuje `currentOwnerId`/`"me"` tylko jako atrybucję rekordów wspólnych; nie może zdefiniować właściciela cudzego rekordu prywatnego. Zweryfikować w code review, że żaden nowy kod nie ufa `ownerId` z body do rozstrzygania granicy prywatności.
- **Powiadomienia prywatnych przypomnień.** Bez zmiany w workerze prywatne `life.reminders` przestałyby generować push (pętla prywatna dziś ich nie przetwarza). Konieczna zmiana w `worker.mjs`; przy dostarczaniu polegać na dedupie `notification_deliveries` i nie zapisywać `notifiedAt` do `user_workspace_states` (brak `revision` → ryzyko wyścigu z zapisem użytkownika).
- **Google sync a ręczna zmiana widoczności.** `updateEvent` przy kolejnej synchronizacji nie może nadpisywać `visibility` istniejącego eventu (inaczej cofnie wybór „Cały dom"). Aktualizować tylko pola treści (tytuł/daty/lokalizacja), zostawiając `visibility`/`ownerId`.
- **Trójstronny merge klienta (`workspaceMerge.ts`).** Zmiana widoczności tego samego rekordu na dwóch urządzeniach rozstrzyga się po `updatedAt` (field-level). Upewnić się, że każda zmiana `visibility` bumpuje `updatedAt` (store add/update już to robią) — inaczej możliwe „utknięcie" na starej wartości.

## Pytania do doprecyzowania

Brak otwartych pytań. Google Calendar: przyjęto domyślną widoczność **prywatną** dla eventów z synchronizacji (połączenie Google jest per-użytkownik, spójne z regułą „domyślnie prywatne"); zmiana na „Cały dom" jest możliwa ręcznie w edycji i nie jest cofana przy kolejnej synchronizacji.
