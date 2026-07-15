# Spójne, poprawnie pozycjonowane modale (fix pozycjonowania + scroll)

> Plan wygenerowany przez skill `/plan-feature`. Slug: `modal-fullscreen-consistency`. Branch: `claude/modal-fullscreen-consistency-ffzt6j` (istniejący branch repo — NIE `feature/modal-fullscreen-consistency`).

## Kontekst / Problem

Użytkownik zgłasza, że modale zachowują się niespójnie:

> „Chciałbym żeby każdy modal otwierał się tak samo. W tym momencie dla przykładu modal dodawania rytuału otwiera się dziwnie w oknie rytuałów, a np zadania na cały ekran. Modal rytuału też nie można scrolować na telefonach i części rzeczy nie widać na mniejszych ekranach, a modal zadań normalnie można scrolować."

Wszystkie modale w apce współdzielą jeden komponent `src/components/Modal.tsx` (23 użycia `<Modal>` w 10 plikach `src/pages/*.tsx` + 1 w `src/components/QuickAddModal.tsx` = 24 użycia łącznie). Modal renderuje `.modal-backdrop` (`position: fixed; inset: 0`, `src/styles.css:789-800`) **bezpośrednio w drzewie JSX strony**, a nie przez React Portal.

**Root cause (zweryfikowany w kodzie).** Każda strona owija swój root w klasę `page-enter` (np. `src/pages/HabitsPage.tsx:47`, `src/pages/TasksPage.tsx:103`). Reguła w `src/styles.css:553-561`:

```css
.page-enter { animation: page-in 260ms ease both; }
@keyframes page-in {
  from { opacity: 0; transform: translateY(5px); }
  to   { opacity: 1; transform: translateY(0);   }
}
```

`animation-fill-mode: both` sprawia, że po zakończeniu animacji element trwale zachowuje styl ostatniej klatki, czyli `transform: translateY(0)`. Wg specyfikacji CSS Transforms `translateY(0)` to nadal wartość funkcji transform różna od `none` — a **każdy element z transform innym niż `none` ustanawia containing block dla potomków `position: fixed`**. Efekt: `.modal-backdrop` renderowany wewnątrz `.page-enter` przestaje być pozycjonowany względem viewportu i pozycjonuje się względem opakowującego `<div>` strony. Stąd modal „otwiera się dziwnie w oknie" strony, bywa ucięty, a scroll działa źle — bo `lockBodyScroll()` (`src/lib/scrollLock.ts`) blokuje scroll na `<body>` zakładając, że modal jest fixed względem viewportu, co po złamaniu containing blocku nie jest prawdą.

Dlaczego `QuickAddModal` (modal zadań z „szybkiego dodawania") działa dobrze: jest renderowany raz na poziomie roota w `src/App.tsx:162`, **poza** jakimkolwiek `.page-enter`, więc jego `.modal-backdrop` jest prawdziwie fixed względem viewportu. To dokładnie odpowiada zgłoszeniu: modal zadań (QuickAdd) OK, modal rytuału (`AddHabitModal` w `HabitsPage`) i modal edycji zadania (`TaskEditModal` w `TasksPage`) — zepsute.

Weryfikacja zasięgu: wszystkie 10 stron używających `<Modal>` mają root z klasą `page-enter` (potwierdzone grepem — `HabitsPage`, `TasksPage`, `CalendarPage`, `CarPage`, `FinancePage`, `HealthPage`, `MealsPage`, `SettingsPage`, `SubscriptionsPage`, `TripsPage`), więc każdy modal renderowany wewnątrz strony jest dotknięty tym samym bugiem.

Dodatkowo: treść modala rytuału (`fieldset.habit-icon-picker` w `HabitsPage.tsx:113`) używa `display: flex` bez `flex-wrap` (`src/styles.css:933-946`), więc na wąskich viewportach ikony + legenda mogą wyjść poza szerokość i nic ich nie zawija.

## Wymagania

- **Każdy modal otwiera się identycznie i jest pozycjonowany względem viewportu** (wyśrodkowany), niezależnie od tego, na której stronie i wewnątrz jakiego kontenera został wyrenderowany w drzewie React. Znika efekt „modal w oknie strony".
- **Scroll wewnątrz modala działa poprawnie na telefonach** dla wszystkich modali (tak jak dziś działa dla QuickAddModal) — długa treść (np. modal rytuału, modal edycji zadania) jest w całości dostępna przez scroll wewnątrz karty modala.
- **Zachowany obecny wygląd** modala na WSZYSTKICH szerokościach: wyśrodkowana karta z zaokrąglonymi rogami, przyciemniony backdrop z blur. To NIE jest przejście na edge-to-edge „sheet". (Decyzja użytkownika #1 — patrz niżej.)
- **Naprawa centralna** w `src/components/Modal.tsx` (+ CSS), obejmująca od razu wszystkie 24 użycia — bez łatania pojedynczych stron. (Decyzja #2.)
- **Treść modala rytuału zawija się i nic nie wychodzi poza ekran** na wąskich viewportach — konkretnie siatka ikon `.habit-icon-picker`. (Decyzja #3.)
- Niefunkcjonalne: bez zmian w API/danych (feature czysto frontendowy); focus trap, obsługa Escape i blokada scrolla `<body>` działają jak dotąd; `npm run build`, `npm test`, `npm run test:server` przechodzą; i18n PL bez zmian.

## Zakres i Non-goals

**W zakresie:**
- Wyrenderowanie `.modal-backdrop` z `src/components/Modal.tsx` przez `ReactDOM.createPortal(..., document.body)`, tak aby modal zawsze trafiał w DOM bezpośrednio pod `<body>`, poza zasięgiem jakiegokolwiek przodka z `transform`/`filter`/`will-change`/`contain`.
- Drobne utwardzenie CSS animacji strony: zmiana końcowej klatki `@keyframes page-in` z `transform: translateY(0)` na `transform: none` (defense-in-depth — patrz „Podejście", punkt 2).
- Naprawa layoutu treści modala rytuału: `flex-wrap: wrap` dla `.habit-icon-picker` (i współdzielącego regułę `.color-picker`) oraz wymuszenie legendy na osobnej linii nad ikonami.
- Ewentualna korekta CSS `.modal`/`.modal-backdrop` jeśli po przejściu na portal potrzebne jest doprecyzowanie scrolla (patrz „Ryzyka").

**Non-goals (świadomie pomijamy):**
- **Prawdziwy edge-to-edge „sheet"** bez marginesów na mobile — świadomie NIE robimy (decyzja #1). Zostaje wyśrodkowana karta.
- **`CommandPalette.tsx`** (`.command-backdrop`, `src/styles.css:789-800,1049-1052`) — używa analogicznego `position: fixed`, ale **nie ma tego buga**, bo jest renderowany na poziomie roota w `src/App.tsx:163`, poza `.page-enter`. User prosił o „modal", a paleta komend to inny wzorzec UI. Pozostawiamy bez zmian; opcjonalne uspójnienie (portal również tam) to osobny, przyszły temat — patrz „Ryzyka".
- **Zmiany w 10 plikach `src/pages/*.tsx`** — NIE są wymagane; fix jest centralny w `Modal.tsx`. Pliki wymienione niżej tylko dla świadomości implementera (ma ich NIE dotykać).
- Zmiany w warstwie danych i backendzie — brak (feature czysto frontendowy).
- Inne siatki przycisków w treści modali — zweryfikowane, nie wymagają zmian: `form-grid--2`/`form-grid--3` już zwijają się do 1 kolumny na mobile (`src/styles.css:1798-1799`), `quick-add-tabs` do 2 kolumn (`:1797`), `modal-actions` do kolumny (`:1800-1802`), `color-picker` (4 swatche) mieści się i dodatkowo dostanie `flex-wrap`. `module-segmented`/`theme-options` znalezione grepem są w treści stron (toolbary/ustawienia), nie w modalach.

## Podejście

Wybrane rozwiązanie: **portal w `Modal.tsx`** jako naprawa główna, plus **utwardzenie keyframe `page-in`** jako tania warstwa dodatkowa.

1. **Portal (naprawa właściwa).** W `src/components/Modal.tsx` opakowujemy zwracany JSX (`<div className="modal-backdrop">…`) w `ReactDOM.createPortal(node, document.body)`. To gwarantuje, że modal jest wstawiany w DOM bezpośrednio jako dziecko `<body>`, więc żaden przodek w drzewie React (obecny `.page-enter` ani jakikolwiek przyszły `transform`/`filter`/`perspective`/`will-change`/`contain` na dowolnej stronie) nie może już złamać jego containing blocku ani z-index. To jedna zmiana w jednym pliku, zero zmian w 10 stronach konsumujących `<Modal>`. Dlaczego to najlepsze:
   - Odporność na regresje: naprawia problem u źródła (kontekst pozycjonowania), a nie tylko dla dzisiejszej reguły `.page-enter`.
   - `lockBodyScroll()` po zmianie działa poprawnie (backdrop jest teraz realnie fixed względem viewportu, a blokada scrolla `<body>` jest właśnie tego założeniem). Portal nie zmienia kontekstu React (stan/props/kontekst przepływają normalnie), zmienia tylko miejsce w DOM — więc `unlockScroll()` w cleanupie efektu działa bez zmian.
   - Focus trap / `document.activeElement` (`Modal.tsx:38-72`): `modalRef` jest przypięty do treści renderowanej przez portal, a `querySelector`/`focus` operują na realnym DOM — działają tak samo. Listener `keydown` jest na `document` (globalny), więc Escape i pułapka Tab działają niezależnie od miejsca w drzewie. `previousFocus` zapamiętywany przed otwarciem i przywracany w cleanupie — bez zmian.
   - Cel portalu: `document.body`. To SPA (Vite, klient-only, `src/main.tsx` montuje w `#root`), `document.body` jest zawsze dostępny w momencie renderu; `Modal` i tak robi `if (!open) return null;` (`Modal.tsx:74`), więc `createPortal` woła się tylko dla otwartego modala. Nie potrzeba dedykowanego kontenera „modal-root".

2. **Utwardzenie `@keyframes page-in` (defense-in-depth, tanie).** Zmieniamy klatkę `to` z `transform: translateY(0)` na `transform: none` (`src/styles.css:558-561`). Dzięki temu, nawet gdyby ktoś w przyszłości dodał modal renderowany bez portalu, `.page-enter` po zakończeniu animacji nie ustanawia już containing blocku. To NIE zastępuje portalu (podczas 260 ms trwania animacji transform wciąż jest niezerowy, a portal jest odporny także na to), ale usuwa pierwotny „ukryty" trigger i jest zgodne z intencją animacji (efekt wjazdu). Ten punkt jest opcjonalny względem punktu 1 — portal sam w pełni naprawia zgłoszenie — ale zalecany jako niski koszt/wysoka higiena.

3. **Layout treści modala rytuału.** W `src/styles.css` w regule współdzielonej `.color-picker, .habit-icon-picker` (`:933-941`) dodajemy `flex-wrap: wrap`, a w regule legendy (`:943-946`) ustawiamy legendę na pełną szerokość (`flex-basis: 100%` / `width: 100%`), aby napis „Ikona"/„Kolor notatki" siadał nad elementami (dziś `margin-bottom: 9px` sugeruje taki zamysł, ale w kontenerze `display:flex` legenda jest traktowana jako element flex w jednym rzędzie z ikonami). Efekt: legenda w osobnej linii, a ikony/swatche zawijają się i nie wychodzą poza szerokość modala na wąskich ekranach. Zmiana dotyka też `.color-picker` (QuickAddModal) — bez regresji, tylko poprawia zawijanie.

**Odrzucona alternatywa:** naprawa wyłącznie keyframe (`transform: none`) bez portalu. Odrzucona jako główne rozwiązanie, bo jest krucha: naprawia tylko dzisiejszy trigger `.page-enter`, a każdy przyszły `transform`/`filter`/`will-change`/`contain` na dowolnym przodku modala odtworzy buga; dodatkowo w trakcie 260 ms animacji strony containing block nadal by istniał. Portal jest odporny na całą tę klasę problemów przy jednej zmianie w jednym pliku. (Keyframe zostaje jako warstwa dodatkowa w punkcie 2, nie jako jedyny fix.)

## Pliki do zmiany

**Baza (warstwa danych):** — brak — (feature czysto frontendowy, bez zmian w schemacie, `server/src/db.mjs`, `src/types.ts`).

**Backend (warstwa backend):** — brak — (bez zmian w `server/src/server.mjs`, `server/src/worker.mjs`, `server/src/security.mjs`).

**Frontend (warstwa frontend):**

- `src/components/Modal.tsx` — **główna zmiana.** Dodać `import { createPortal } from "react-dom";`. Owinąć zwracany `<div className="modal-backdrop">…</div>` (linie 76-99) w `createPortal(<…>, document.body)`. Reszta komponentu (focus trap, `lockBodyScroll`, `requestClose`, obsługa Escape/Tab, `if (!open) return null`) bez zmian. `react-dom` już jest zależnością (19.2.7, patrz `src/main.tsx`).
- `src/styles.css` — trzy drobne zmiany CSS:
  - `@keyframes page-in` (`:558-561`): klatka `to` → `transform: none;` (utwardzenie z punktu 2).
  - `.color-picker, .habit-icon-picker` (`:933-941`): dodać `flex-wrap: wrap;`.
  - `.color-picker legend, .habit-icon-picker legend` (`:943-946`): dodać `flex-basis: 100%;` (lub `width: 100%`), by legenda była nad elementami.
  - (Opcjonalnie) po weryfikacji na urządzeniu ewentualne doprecyzowanie `.modal`/`.modal-backdrop` scrolla — patrz „Ryzyka”; domyślnie NIE potrzebne.

**Pliki, które używają `<Modal>` — NIE wymagają zmian (fix jest centralny), wymienione tylko dla świadomości implementera:**

- `src/components/QuickAddModal.tsx` (1× `<Modal>`) — już działał; po portalu działa tak samo.
- `src/pages/HabitsPage.tsx` (1×) — `AddHabitModal`; skorzysta z portalu + poprawki `.habit-icon-picker`.
- `src/pages/TasksPage.tsx` (1×) — `TaskEditModal`.
- `src/pages/CalendarPage.tsx` (2×)
- `src/pages/FinancePage.tsx` (5×)
- `src/pages/HealthPage.tsx` (3×)
- `src/pages/CarPage.tsx` (3×)
- `src/pages/TripsPage.tsx` (4×)
- `src/pages/MealsPage.tsx` (2×)
- `src/pages/SubscriptionsPage.tsx` (1×)
- `src/pages/SettingsPage.tsx` (1×)

Reużywane utility (bez zmian): `src/lib/scrollLock.ts` (`lockBodyScroll`), istniejące klasy CSS `.modal*`.

## Kryteria akceptacji

- [ ] Modal dodawania rytuału (Rytuały → „Nowy rytuał") otwiera się wyśrodkowany względem viewportu i wygląda identycznie jak modal QuickAdd — nie „w oknie" strony.
- [ ] Modal edycji zadania (Zadania → edycja pozycji) otwiera się wyśrodkowany i wygląda spójnie z pozostałymi.
- [ ] Na wąskim ekranie (np. 360–390 px szerokości) długi modal (rytuał, edycja zadania) daje się w całości przescrolować wewnątrz karty; cała treść jest osiągalna.
- [ ] Siatka ikon w modalu rytuału zawija się i nic nie wychodzi poza prawą krawędź modala na wąskim viewporcie; legenda „Ikona" jest nad ikonami.
- [ ] Wygląd modala (wyśrodkowana karta, zaokrąglenia, backdrop z blur) jest zachowany na wszystkich szerokościach — brak edge-to-edge.
- [ ] Escape zamyka modal; Tab „krąży" wewnątrz modala (focus trap); po zamknięciu focus wraca do elementu, który otworzył modal; scroll `<body>` jest zablokowany, gdy modal otwarty, i odblokowany po zamknięciu.
- [ ] `confirmClose` (niezapisane zmiany w `TaskEditModal`) nadal działa — kliknięcie w backdrop / Escape / „Anuluj" pyta o potwierdzenie.
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą (w tym `src/App.test.tsx`, który używa `screen.findByRole("dialog")` — portalowo bezpieczne, bo `screen` przeszukuje `document.body`).
- [ ] Aplikacja odpala się i feature działa w preview, w tym na wąskim ekranie (PWA).

## Ryzyka

- **Testy a portal.** Istniejące testy (`src/App.test.tsx`) używają `screen.getByRole` / `screen.findByRole` (przeszukują całe `document.body`), więc portal ich NIE psuje — element `role="dialog"` nadal jest znajdowany. Ryzyko dotyczyłoby tylko testów szukających modala przez `container.querySelector` — takich nie ma (zweryfikowano listę `*.test.tsx`). Gdyby implementer dodawał nowe testy modala, ma używać `screen`, nie `container`.
- **Cel portalu w środowisku testowym (jsdom).** `document.body` istnieje w jsdom (Vitest + Testing Library), więc `createPortal(..., document.body)` działa w testach. Brak SSR w projekcie (Vite SPA), więc nie ma ryzyka „document is not defined".
- **Scroll po portalu.** `.modal` ma `overflow: auto` i `max-height` (`src/styles.css:806`, mobile `94dvh` w `:1794`), a `lockBodyScroll` blokuje tło. Po przejściu na portal to powinno działać poprawnie na wszystkich stronach (tak jak dziś dla QuickAdd). Jeśli weryfikacja na urządzeniu ujawni resztkowy problem ze scrollem (np. iOS Safari i `dvh`), doprecyzowanie robimy w CSS `.modal`/`.modal-backdrop` — nie wymaga zmian w JS.
- **Podwójny/zagnieżdżony modal.** W apce nie występuje otwieranie modala z wnętrza innego modala; `lockBodyScroll` i tak ma licznik (`lockCount`), więc jest bezpieczne, ale nie jest to ścieżka do testowania.
- **`CommandPalette` poza zakresem.** Świadomie nie zmieniamy `CommandPalette.tsx`, bo nie ma buga (renderowany w root). Zostaje z `position: fixed` bez portalu. Jeśli w przyszłości ktoś przeniósłby jej render do wnętrza `.page-enter`, odziedziczyłaby ten sam problem — warto wtedy dać jej ten sam portal. To notatka na przyszłość, nie zadanie tego planu.
- **`z-index`.** Backdrop ma `z-index: 100` (`:793`); po przeniesieniu na koniec `<body>` porządek malowania jest jednoznaczny (modal nad wszystkim), co jest poprawą, nie ryzykiem.

## Pytania do doprecyzowania

Brak otwartych pytań — decyzje produktowe (zachowanie wyśrodkowanej karty zamiast edge-to-edge, centralna naprawa w `Modal.tsx`, poprawka layoutu ikon rytuału) zostały już podjęte przez użytkownika. Kierunek techniczny (portal + utwardzenie keyframe + `flex-wrap`) jest rekomendacją tego planu; alternatywa „tylko keyframe" została odrzucona z uzasadnieniem w „Podejście".
