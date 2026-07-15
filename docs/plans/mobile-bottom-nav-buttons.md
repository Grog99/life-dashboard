# Dolny pasek mobilny: Dzisiaj, Zadania, Kalendarz, Notatki

> Plan wygenerowany przez skill `/plan-feature`. Slug: `mobile-bottom-nav-buttons`. Branch: `claude/mobile-bottom-nav-buttons-p6hton`.

## Kontekst / Problem

Zgłoszenie użytkownika:

> „W mobilnym widoku umieścić na dole przyciski Dzisiaj, Zadania, Notatki i Kalendarz zamiast tych co teraz są. Dzięki temu będą dostępne pod ręką rzeczy które zazwyczaj chce się zrobić na szybko"

Dolny pasek nawigacji mobilnej (`<nav className="mobile-nav">`, `src/components/Layout.tsx:284-300`) pokazuje dziś przyciski `["today", "calendar", "finance", "trips"]`. Finanse i Podróże to moduły, które na telefonie otwiera się rzadziej niż podstawowy planer (zadania, notatki), więc zajmują cenne, „podręczne" sloty na dole ekranu. Celem jest wymiana zawartości paska na cztery najczęściej używane szybkie widoki, przy zachowaniu dostępu do Finansów i Podróży w menu bocznym.

Podczas rundy doprecyzowującej użytkownik świadomie wybrał kolejność **Dzisiaj, Zadania, Kalendarz, Notatki** (inną niż w treści zgłoszenia — bo pasuje do kolejności w menu bocznym).

## Wymagania

- Dolny pasek mobilny pokazuje dokładnie cztery przyciski w kolejności: **Dzisiaj → Zadania → Kalendarz → Notatki**.
- Finanse i Podróże znikają z dolnego paska; pozostają dostępne przez menu boczne (hamburger), które już je zawiera bez zmian.
- Ikony i etykiety pochodzą z istniejącej tablicy `navigation` (`LayoutDashboard`, `CheckSquare2`, `CalendarDays`, `NotebookPen`) — bez nowych ikon.
- FAB (przycisk „+", `<button className="mobile-fab">`) zostaje bez zmian: dalej unosi się `fixed` osobno nad paskiem, niezależnie od czterech slotów.
- Niefunkcjonalne: zmiana czysto frontendowa; `npm run build`, `npm test`, `npm run test:server` przechodzą; i18n PL bez zmian; pasek nadal wyrenderowany tylko na wąskim viewporcie (breakpoint mobilny — reguła `.mobile-nav` włącza się w media query przy `styles.css:1709`).

## Zakres i Non-goals

**W zakresie:**
- Zmiana filtra listy widoków renderowanych w `<nav className="mobile-nav">` z `["today", "calendar", "finance", "trips"]` na `["today", "tasks", "calendar", "notes"]` (`src/components/Layout.tsx:285`).

**Non-goals (świadomie pomijamy):**
- Zmiany w tablicy `navigation` (etykiety/ikony/kolejność wpisów) — reużywamy ją dosłownie, zmienia się tylko filtr.
- Zmiany CSS: pasek dalej ma 4 kolumny (`grid-template-columns: repeat(4, 1fr)`), więc `.mobile-nav`/`.mobile-fab` zostają bez zmian.
- Zmiany w menu bocznym (`.side-nav`) — pokazuje dalej wszystkie moduły.
- Jakiekolwiek zmiany w backendzie/bazie/danych (patrz „Pliki do zmiany" → warstwy Baza/Backend = brak).
- Konfigurowalność paska przez użytkownika, dodanie 5. slotu, zmiana zachowania FAB.

## Podejście

Rekomendacja: zmienić jeden argument filtra w `src/components/Layout.tsx:285`.

Pasek renderuje `navigation.filter((item) => [...].includes(item.id)).map(...)`. Kluczowy, zweryfikowany w kodzie fakt: `Array.prototype.filter` zachowuje **kolejność źródłowej tablicy `navigation`**, a nie kolejność tablicy przekazanej do `.includes()`. W `navigation` wpisy leżą już w kolejności `today` (idx 0) → `tasks` (1) → `calendar` (2) → `notes` (3) — czyli dokładnie w żądanej kolejności renderowania. Dlatego zwykła podmiana filtra na `["today", "tasks", "calendar", "notes"]` daje poprawną kolejność wizualną bez żadnej restrukturyzacji (nie trzeba mapować po tablicy filtra ani sortować).

Liczność pozostaje 4, więc siatka CSS `repeat(4, 1fr)` pasuje bez zmian. `tasks` i `notes` to prawidłowe wartości `ViewId` (`src/types.ts:6,7`), więc TypeScript jest zadowolony bez zmian typów. FAB jest osobnym elementem `fixed` (`src/components/Layout.tsx:302-304`, CSS `styles.css:1712`), nie slotem gridu — pozostaje nietknięty.

Zgodnie z `docs/ARCHITECTURE.md` (PWA React/Vite → Fastify → PostgreSQL, dane wspólne vs prywatne przez `workspace_states`/`user_workspace_states`, synchronizacja przez rewizje): to reorganizacja istniejącej nawigacji klienta, bez nowych danych, endpointów, migracji ani logiki synchronizacji. **Zmiana dotyka wyłącznie warstwy Frontend.**

## Pliki do zmiany

**Baza (warstwa danych):** — brak —

**Backend (warstwa backend):** — brak —

**Frontend (warstwa frontend):**

- `src/components/Layout.tsx:285` — jedyna zmiana merytoryczna. W `<nav className="mobile-nav">` podmienić argument filtra:
  - z: `navigation.filter((item) => ["today", "calendar", "finance", "trips"].includes(item.id))`
  - na: `navigation.filter((item) => ["today", "tasks", "calendar", "notes"].includes(item.id))`
  - Reużycie: ta sama tablica `navigation` (linie 37-53) i ten sam blok `.map(...)` renderujący `<button>` z `<Icon />` + `<span>{item.label}</span>`. Import ikon `CheckSquare2`, `NotebookPen`, `CalendarDays`, `LayoutDashboard` już istnieje (linie 5, 8, 4, 13) — nic nie dochodzi.
- `src/styles.css` — bez zmian (`.mobile-nav` `repeat(4, 1fr)` @ 1709, `.mobile-fab` @ 1712 pozostają; nadal 4 sloty).
- `src/types.ts` — bez zmian (`ViewId` już zawiera `tasks` i `notes`).
- `src/App.test.tsx` — bez zmian. Test „otwiera wszystkie moduły zaawansowane" (linie 25-38) klika przyciski przez `getAllByRole("button", { name })[0]`; jego lista modułów to Finanse/Podróże/Subskrypcje/Posiłki/Samochód/Zdrowie — wszystkie nadal obecne w menu bocznym, a `[0]` trafia w przycisk sidebaru (sidebar poprzedza `mobile-nav` w DOM). Usunięcie Finansów/Podróży z paska i dodanie Zadań/Notatek nie zmienia tych trafień. Do sprawdzenia jedynie, że test dalej przechodzi (bez edycji).

## Kryteria akceptacji

- [ ] Na wąskim ekranie dolny pasek pokazuje dokładnie: Dzisiaj, Zadania, Kalendarz, Notatki — w tej kolejności, lewa→prawa.
- [ ] Finanse i Podróże nie są już na dolnym pasku, ale nadal otwierają się z menu bocznego (hamburger).
- [ ] Kliknięcie każdego z 4 przycisków przełącza widok, a aktywny przycisk dostaje klasę `active` (`color: var(--brand)`), tak jak dotąd.
- [ ] FAB „+" wygląda i zachowuje się bez zmian — unosi się nad paskiem, otwiera szybkie dodawanie.
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą.
- [ ] Aplikacja odpala się i feature działa w preview na wąskim ekranie (to PWA).

## Ryzyka

- Niskie. Jednoliniowa zmiana filtra, bez nowych danych, endpointów ani stanu.
- Pułapka konceptualna (już zaadresowana w „Podejściu"): kolejność renderowania wynika z kolejności w `navigation`, nie z tablicy filtra. Gdyby ktoś w przyszłości chciał kolejność inną niż kolejność wpisów w `navigation`, sam filtr `.includes()` jej nie da — trzeba by mapować po tablicy kolejności. W obecnym przypadku kolejności są zgodne, więc problem nie występuje.
- Brak dotknięcia granicy prywatne/wspólne dane, brak konfliktów rewizji synchronizacji — feature nie zapisuje żadnego stanu.

## Pytania do doprecyzowania

Brak — wszystkie decyzje (zestaw przycisków, kolejność, ikony, los Finansów/Podróży, brak zmian FAB) zostały podjęte w rundzie doprecyzowującej. Dostępność jest zachowana bez dodatkowych ustaleń: kolejność DOM przycisków pokrywa się z kolejnością wizualną, a nazwa dostępna każdego przycisku pochodzi z widocznej etykiety `<span>{item.label}</span>`, więc czytnik ekranu odczyta „Dzisiaj, Zadania, Kalendarz, Notatki" w tej samej kolejności.
