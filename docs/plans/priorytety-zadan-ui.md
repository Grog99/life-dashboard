# Priorytety zadań — dopracowanie UI

> Plan wygenerowany przez skill `/plan-feature`. Slug: `priorytety-zadan-ui`. Branch: `feature/priorytety-zadan-ui`.

## Kontekst / Problem

Sekcja „Najważniejsze dzisiaj" (panel priorytetów) na stronie głównej (Dziś / `TodayPage`) renderuje się zawsze — nawet gdy użytkownik nie ma żadnego zadania priorytetowego na dziś. Zamiast wartości pokazuje wtedy pusty stan zachęcający („Wybierz kierunek"), który zajmuje najbardziej eksponowane miejsce na dashboardzie i rozprasza. Dodatkowo bieżący UX priorytetów jest niespójny:

- tekst przycisku w menu zadania („Dodaj do 3 priorytetów") eksponuje techniczny limit „3", który myli, bo limit dotyczy tylko przełączania istniejących zadań;
- podczas szybkiego dodawania zadania nie da się od razu oznaczyć go jako priorytetowe — trzeba najpierw utworzyć zadanie, a potem osobno przełączyć je z listy.

Efekt oczekiwany: panel priorytetów pojawia się tylko wtedy, gdy realnie coś w nim jest; nazewnictwo priorytetów jest krótsze i spójne; użytkownik może oznaczyć nowe zadanie jako priorytetowe wprost w formularzu szybkiego dodawania.

## Wymagania

- **W1 — Ukrywanie sekcji priorytetów:** cała sekcja `priorities-panel` (nagłówek „Kierunek dnia / Najważniejsze dzisiaj" + link „Wszystkie zadania" + lista + przycisk „Dodaj priorytet") ma **w ogóle się nie renderować**, gdy `focusTasks.length === 0`. Nie chodzi o ukrycie samej treści w środku — znika cały `<section>`.
- **W2 — Tekst przycisku menu:** w menu kontekstowym zadania stan `!task.isFocus` ma pokazywać „Dodaj do priorytetów" zamiast „Dodaj do 3 priorytetów". Stan `task.isFocus` („Usuń z priorytetów") zostaje bez zmian.
- **W3 — Checkbox priorytetu w QuickAddModal:** w formularzu szybkiego dodawania, w gałęzi `type === "task"`, ma pojawić się checkbox „zadanie priorytetowe" — **zawsze widoczny** (nie tylko po rozwinięciu „Dodaj termin i szczegóły"). Zaznaczenie ustawia `isFocus: true` przy tworzeniu zadania; domyślnie `false`.
- **Niefunkcjonalne:** czysto frontendowa zmiana; pole `isFocus` istnieje end-to-end (typ, schema walidacji, store, serwer opaque). Zachować spójność wizualną z resztą formularza (labelki `Ważność`, `Widoczność`, `Obszar`) i responsywność PWA (wąski ekran).

## Zakres i Non-goals

**W zakresie:**
- Warunkowe renderowanie sekcji `priorities-panel` w `src/pages/TodayPage.tsx`.
- Zmiana tekstu przycisku w `src/components/TaskItem.tsx`.
- Nowy checkbox „zadanie priorytetowe" w `src/components/QuickAddModal.tsx` (stan + reset + użycie w `submit`).
- Minimalny nowy styl checkboxa w globalnym `src/styles.css` (klasa generyczna, wzorowana na istniejącej `.trips-check-field`).
- Aktualizacja/uzupełnienie testów (`src/App.test.tsx` i ewentualnie nowe asercje).

**Non-goals (świadomie pomijamy):**
- **Walidacja/blokada limitu 3 priorytetów przy tworzeniu zadania.** Zgodnie z decyzją: gdy checkbox jest zaznaczony, a na dany dzień są już 3 priorytety, **limit może zostać przekroczony** — nowe zadanie i tak dostaje `isFocus: true`. Istniejący limit w `toggleFocus`/`toggleTask` (`src/store/useLifeStore.ts`) zostaje **bez zmian** — dotyczy tylko przełączania istniejących zadań.
- Zmiany w `TaskEditModal` (`src/pages/TasksPage.tsx`) — nie dodajemy tam checkboxa `isFocus` (poza zakresem tej prośby).
- Jakiekolwiek zmiany w bazie, backendzie, schemacie walidacji czy sortowaniu listy zadań.
- Zmiana tekstu/wyglądu stanu `task.isFocus` („Usuń z priorytetów") i etykiety `Priorytet` na kaflu zadania.

## Podejście

Feature jest **czysto frontendowy**. Pole `Task.isFocus` już istnieje w całym łańcuchu:

- typ `Task.isFocus: boolean` — `src/types.ts:32`;
- schemat walidacji `isFocus: z.boolean()` — `src/lib/schema.ts:43`;
- store `addTask` przyjmuje `isFocus` w obiekcie wejściowym i zapisuje go bez zmian — `src/store/useLifeStore.ts:86-104`;
- serwer traktuje zadania **opaque**: `workspaceDocumentIsValid` (`server/src/workspace.mjs:38`) sprawdza tylko, że `life.tasks` jest tablicą ≤ 100 000 elementów; `splitWorkspaceData`/`mergeWorkspaceData` operują wyłącznie na `visibility`/`ownerId`/`id`. **Nigdzie w `server/` nie ma odwołania do `isFocus`** (potwierdzone grepem). Zgodne z `docs/ARCHITECTURE.md` (dokumentowy model JSONB, rozdział prywatne/wspólne po `visibility`).

Dlatego warstwy „Baza" i „Backend" to `— brak —`; zmiana `isFocus: true` na nowym zadaniu przechodzi end-to-end bez żadnej modyfikacji serwera.

Kluczowe decyzje frontendowe:

1. **Ukrywanie sekcji (W1):** owinąć cały `<section className="panel priorities-panel">` warunkiem `{focusTasks.length > 0 && ( … )}`. Ponieważ sekcja renderuje się już tylko dla `focusTasks.length > 0`, wewnętrzny pusty stan („Wybierz kierunek", gałąź `else` ternary) staje się martwym kodem — upraszczamy `priority-list` do samego `focusTasks.map(...)`, a warunek stopki `focusTasks.length < 3 && focusTasks.length > 0` do `focusTasks.length < 3`. Definicja `focusTasks` (`TodayPage.tsx:132-134`) zostaje bez zmian.

2. **Tekst przycisku (W2):** zmiana pojedynczego literału w ternary — bez zmian logiki `handleFocus`/`toggleFocus`.

3. **Checkbox (W3):** dodać lokalny stan `isFocus` w `QuickAddModal`, zresetować go w efekcie otwarcia modala i przekazać do `addTask` zamiast twardego `isFocus: false`. Checkbox umieścić na **początku** fragmentu `type === "task"` (nad przyciskiem „Dodaj termin i szczegóły"), czyli w zawsze widocznej części formularza — pod polem tytułu / podpowiedzią „smart-hint" i przed globalnym polem „Widoczność". Stylistycznie wzorować na jedynym istniejącym stylowanym checkboxie w repo — `.trips-check-field` (`src/styles/trips.css:1218`). **Uwaga:** `trips.css` jest importowany tylko w `TripsPage` (`src/pages/TripsPage.tsx:55`), a `QuickAddModal` może być otwarty z dowolnej strony i korzysta z globalnego `src/styles.css` (import w `src/main.tsx:5`). Dlatego **nie reużywamy** klasy `.trips-check-field`, tylko dodajemy analogiczną, generyczną klasę do `src/styles.css`.

Odrzucona alternatywa: reużycie `.trips-check-field` bezpośrednio — odrzucone, bo styl nie byłby załadowany, gdy modal otwierany jest spoza `TripsPage` (np. z `TodayPage`).

## Pliki do zmiany

Grupowane w trzy warstwy pod orkiestrator `/implement-feature`.

**Baza (warstwa danych):** — brak —

Pole `isFocus` już istnieje w `src/types.ts` (`Task.isFocus`, linia 32) i w `src/lib/schema.ts` (`taskSchema.isFocus`, linia 43). Bez migracji, bez zmian w typach/schema.

**Backend (warstwa backend):** — brak —

Potwierdzone: `server/src/server.mjs` i `server/src/workspace.mjs` nie walidują ani nie przetwarzają `isFocus` (zadania są opaque JSONB, split/merge tylko po `visibility`/`ownerId`/`id`). Żadna zmiana serwerowa nie jest potrzebna.

**Frontend (warstwa frontend):**

- **`src/pages/TodayPage.tsx` (W1)** — sekcja `priorities-panel`, ~linie 258-285:
  - Owinąć cały `<section className="panel priorities-panel"> … </section>` w `{focusTasks.length > 0 && ( … )}`.
  - W `priority-list` (~266-281) usunąć ternary `focusTasks.length ? (…) : (soft-empty „Wybierz kierunek")` i zostawić samo mapowanie: `{focusTasks.map((task, index) => ( … ))}` — pusty stan (`soft-empty`, `Sparkles`, „Wybierz kierunek", przycisk „Wybierz zadania") staje się zbędny i zostaje usunięty.
  - Stopkę (~282-284) uprościć z `{focusTasks.length < 3 && focusTasks.length > 0 && ( … )}` do `{focusTasks.length < 3 && ( … )}` (wewnątrz owiniętej sekcji `length > 0` jest zawsze prawdą).
  - `focusTasks` (~132-134) bez zmian. Import `Sparkles` zostaje (używany dalej, m.in. `TodayPage.tsx:352`).
- **`src/components/TaskItem.tsx` (W2)** — linia 151:
  - Zmienić `{task.isFocus ? "Usuń z priorytetów" : "Dodaj do 3 priorytetów"}` na `{task.isFocus ? "Usuń z priorytetów" : "Dodaj do priorytetów"}`. Tylko literał gałęzi `false`.
- **`src/components/QuickAddModal.tsx` (W3)**:
  - Dodać stan lokalny (~przy linii 66, obok `detailsOpen`): `const [isFocus, setIsFocus] = useState(false);`.
  - W efekcie resetu przy otwarciu (~linie 70-89) dodać `setIsFocus(false);`.
  - W `submit`, gałąź `type === "task"` (~linia 123): zmienić `isFocus: false,` na `isFocus,`.
  - Dodać checkbox na początku fragmentu `type === "task"` (~linia 249, tuż po `<>` i przed `<button className="details-toggle" …>`). Proponowana struktura (wzorzec `trips-check-field`, nowa klasa generyczna):
    ```tsx
    <label className="check-field">
      <input
        type="checkbox"
        checked={isFocus}
        onChange={(event) => setIsFocus(event.target.checked)}
      />
      <span>
        <Star size={16} />
        <strong>Zadanie priorytetowe</strong>
        <small>Trafi do sekcji „Najważniejsze dzisiaj".</small>
      </span>
    </label>
    ```
  - Dodać `Star` do importu z `lucide-react` (~linie 1-9; obecnie importowane m.in. `Sparkles`, `CheckSquare2` — `Star` jeszcze nie ma). `Star` jest spójny z ikonografią priorytetu w `TaskItem`/`TodayPage`.
- **`src/styles.css`** — dodać generyczną klasę checkboxa w okolicy reguł `.field` (~linie 709-755), skopiowaną z `.trips-check-field` (`src/styles/trips.css:1218-1244`) i przemianowaną na `.check-field` (oraz `.check-field input`, `.check-field > span`, `.check-field svg/strong/small`). Dzięki temu styl jest w globalnym arkuszu i działa niezależnie od tego, skąd otwarto modal.

**Reużycie:** `TaskItem` (już renderowany w `priority-list`), utility `dateKey` z `src/lib/date`, store `addTask` (`src/store/useLifeStore.ts`), wzorzec wizualny `.trips-check-field` (`src/styles/trips.css`).

## Kryteria akceptacji

Obserwowalne warunki „done":

**W1 — Ukrywanie sekcji „Najważniejsze dzisiaj":**
- [ ] Gdy istnieje ≥ 1 zadanie priorytetowe na dziś (`isFocus === true`, `status === "todo"`, brak daty lub data = dziś), sekcja renderuje się jak dotąd: nagłówek „Najważniejsze dzisiaj", link „Wszystkie zadania", lista priorytetów, a przy < 3 priorytetach przycisk „Dodaj priorytet (n/3)".
- [ ] Gdy `focusTasks.length === 0`, w DOM **nie ma** nagłówka „Najważniejsze dzisiaj", kickera „Kierunek dnia", listy priorytetów ani (usuniętego) pustego stanu „Wybierz kierunek" — cały `<section class="priorities-panel">` nie istnieje. Pierwszym panelem kolumny głównej staje się „Plan na dziś".
- [ ] Nowy test integracyjny (`src/App.test.tsx`): po ustawieniu store bez zadań priorytetowych na dziś, `screen.queryByRole("heading", { name: /Najważniejsze dzisiaj/i })` zwraca `null`.
- [ ] Istniejący test `src/App.test.tsx:20` („pokazuje najważniejsze elementy widoku dnia") **nadal przechodzi bez zmian** — `createSampleData()` zawiera 3 zadania priorytetowe na dziś (`src/data/sampleData.ts`, `isFocus: true` + `date: key()`), więc sekcja się renderuje. (Uwaga do udokumentowania: test jest teraz zależny od tego, że dane startowe mają ≥ 1 priorytet na dziś.)

**W2 — Tekst przycisku menu zadania:**
- [ ] W menu kontekstowym zadania **bez** priorytetu (`!task.isFocus`) przycisk pokazuje „Dodaj do priorytetów" (bez „3").
- [ ] Dla zadania z priorytetem (`task.isFocus`) przycisk nadal pokazuje „Usuń z priorytetów".
- [ ] Kliknięcie przycisku działa jak dotąd (`toggleFocus`, limit 3 nadal egzekwowany przez store — `onFocusLimit`).
- [ ] Żaden istniejący test nie odwołuje się do literału „Dodaj do 3 priorytetów" (potwierdzone grepem — brak), więc nic nie trzeba aktualizować; opcjonalnie dodać asercję na nowy tekst.

**W3 — Checkbox „zadanie priorytetowe" w QuickAddModal:**
- [ ] W zakładce „Zadanie" checkbox „Zadanie priorytetowe" jest widoczny **zawsze**, także gdy „Dodaj termin i szczegóły" jest zwinięte; leży pod polem tytułu (i „smart-hint"), przed polem „Widoczność".
- [ ] Checkbox **nie** pojawia się dla typów „Wydarzenie", „Przypomnienie", „Notatka".
- [ ] Domyślnie odznaczony; po utworzeniu zadania i ponownym otwarciu modala jest znów odznaczony (reset w efekcie otwarcia).
- [ ] Utworzenie zadania z **zaznaczonym** checkboxem daje `task.isFocus === true`; z odznaczonym — `isFocus === false`.
- [ ] Limit 3 nie jest egzekwowany w tym miejscu: przy 3 istniejących priorytetach na dany dzień zaznaczenie checkboxa i tak tworzy zadanie z `isFocus: true` (brak walidacji/komunikatu).
- [ ] Checkbox jest spójny wizualnie z formularzem i czytelny na wąskim ekranie (styl `.check-field` w `styles.css`).
- [ ] Opcjonalny nowy test (jednostkowy/komponentowy): render `QuickAddModal`, zaznaczenie checkboxa, submit → `addTask` wywołane z `isFocus: true`.

**Ogólne:**
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą.
- [ ] Aplikacja odpala się i feature działa w preview (w tym na wąskim ekranie — to PWA).

## Ryzyka

- **Zależność testu od danych startowych:** `src/App.test.tsx:20` zaczyna zależeć od tego, że `createSampleData()` ma ≥ 1 zadanie priorytetowe na dziś. Dziś ma (3), więc test przechodzi; gdyby dane startowe kiedyś to straciły, test padłby przez ukrycie sekcji. Nowy test na pusty stan powinien jawnie czyścić priorytety w store, a nie polegać na danych domyślnych.
- **Martwy kod po uproszczeniu (W1):** przy usuwaniu pustego stanu i warunku `length > 0` łatwo zostawić nieużywany import (`Sparkles`) — ale `Sparkles` jest nadal używany w `TodayPage.tsx:352`, więc importu nie usuwać. Zweryfikować, że po zmianie nie ma ostrzeżeń TS o nieużywanych symbolach.
- **Styl checkboxa poza `TripsPage`:** kluczowe, by styl checkboxa był w globalnym `src/styles.css`, a nie w `styles/trips.css` — inaczej checkbox będzie niestylowany przy otwarciu modala z `TodayPage`/innych stron. Nie reużywać `.trips-check-field` przez import trips.css.
- **Granica prywatne/wspólne:** bez zmian — `isFocus` nie wpływa na `visibility`/`ownerId`, split/merge działa jak dotąd; nowe zadanie z QuickAddModal nadal ustawia `ownerId: currentOwnerId` i `visibility` z formularza. Brak wpływu na synchronizację/rewizje.
- **Dostępność:** checkbox w `<label>` z tekstem — natywnie dostępny; upewnić się, że kliknięcie w tekst przełącza stan (owinięcie inputu i tekstu w jeden `<label>` to zapewnia).

## Pytania do doprecyzowania

Brak otwartych pytań. Trzy główne decyzje (ukrywanie całej sekcji, brak walidacji limitu przy tworzeniu, checkbox zawsze widoczny) są już podjęte. Podczas eksploracji nie natrafiono na konflikty z istniejącymi testami ani nieoczekiwane edge-case'y; jedyną świadomie odnotowaną kwestią jest zależność testu `App.test.tsx` od danych startowych (opisana w „Ryzyka", nie wymaga decyzji użytkownika).

Do potwierdzenia wyłącznie na etapie implementacji (kosmetyka, nie blokuje): finalny label checkboxa. Propozycja: **„Zadanie priorytetowe"** (strong) + podtekst **„Trafi do sekcji «Najważniejsze dzisiaj»."** (small) + ikona `Star`, spójne z etykietą `Priorytet` na kaflu zadania i labelkami `Ważność`/`Widoczność`.
