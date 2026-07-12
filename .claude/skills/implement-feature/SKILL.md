---
name: implement-feature
description: Implementuje gotowy plan (docs/plans/<slug>.md) warstwowo — dane -> backend -> frontend — przez deterministyczny workflow z handoffem schematu miedzy warstwami, potem weryfikacja end-to-end w preview. Uzyj gdy plan jest zaakceptowany, a chcesz implementacje z rozdzieleniem warstw zamiast jednego implementera. Argument: slug albo sciezka do planu.
argument-hint: <slug|docs/plans/xxx.md>
disable-model-invocation: true
---

# implement-feature

Orkiestruje implementacje **zaakceptowanego** planu warstwami: **dane -> backend -> frontend**, z deterministyczna kolejnoscia i strukturyzowanym przekazaniem kontekstu miedzy warstwami (schema handoff), a na koncu weryfikuje feature realnie w przegladarce. `$ARGUMENTS` to slug (np. `alert-plan-wyjazdu`) albo sciezka do pliku planu.

Ten skill NIE planuje i NIE pyta o zakres — od tego jest `/plan-feature`. Zaklada gotowy plan i (zwykle) istniejacy branch `feature/<slug>`.

## Stack projektu

life-dashboard (Puls 2.0) to PWA React 19 + Vite (frontend, `src/`) i Fastify + PostgreSQL (backend, `server/`), obsluzone z jednego originu. To NIE jest Next.js — brak `src/app/api`, route handlery i logika serwerowa zyja w `server/src/server.mjs` (Fastify) i `server/src/worker.mjs` (Web Push worker). Zobacz `docs/ARCHITECTURE.md` po szczegoly (granice systemu, gospodarstwa/role, prywatne vs wspolne dane, synchronizacja przez rewizje).

## Dlaczego workflow, nie zagniezdzeni subagenci

Wywolanie tego skilla jest **jawnym opt-inem do narzedzia `Workflow`** — nie potrzeba Ultracode ani slowa-klucza w prompcie. Workflow daje to, czego luzna orkiestracja agent-w-agencie nie gwarantuje: deterministyczna kolejnosc warstw, walidowany JSON-handoff (backend dostaje dokladne nazwy tabel/funkcji z warstwy danych, frontend — dokladny ksztalt endpointow), widocznosc postepu (`/workflows`) i resume z cache'em po edycji skryptu.

## Krok 1 — Ustal plan i branch

1. Z `$ARGUMENTS` wyznacz `planPath`: jesli podano sciezke do `.md` — uzyj jej; jesli slug — `docs/plans/<slug>.md`. Sprawdz, ze plik istnieje (jak nie: przerwij i powiedz uzytkownikowi, ze najpierw trzeba `/plan-feature`).
2. `git status`. Jesli jestes na `main` albo na innym branchu niz `feature/<slug>`, zapytaj uzytkownika (AskUserQuestion), czy utworzyc/przelaczyc na `feature/<slug>` czy implementowac tu. Nie commituj cudzych zmian.
3. Przeczytaj plan — w szczegolnosci sekcje `## Pliki do zmiany` (moze byc zwinieta pod warstwy) i `## Pytania do doprecyzowania`. **Jesli sa nierozstrzygniete pytania — najpierw je domknij z uzytkownikiem, dopiero potem implementacja.**

## Krok 2 — Wykryj obecne warstwy

Z sekcji `## Pliki do zmiany` ustal, ktore warstwy sa niepuste. Zmapuj podsekcje planu na warstwy workflowa:

- **`dane`** — podsekcje „Baza (warstwa danych)" i „Logika" (migracje SQL w `server/migrations/`, zapytania/funkcje w `server/src/db.mjs`, wspoldzielone typy w `src/types.ts`).
- **`backend`** — podsekcja „Backend (warstwa backend)" (route handlery Fastify w `server/src/server.mjs`, worker Web Push w `server/src/worker.mjs`, middleware/autoryzacja w `server/src/security.mjs`, integracje zewnetrzne).
- **`frontend`** — podsekcja „Frontend (warstwa frontend)" (komponenty w `src/components/`, strony w `src/pages/`, stan w `src/store/` (zustand), hooki w `src/hooks/`).

Zbuduj `layers` jako uporzadkowana liste tylko tych warstw, ktore maja realne pliki (pomin te oznaczone „— brak —"). Pure-frontend feature => `layers: ['frontend']`. Feature bez frontendu => `['dane','backend']` itd.

## Krok 3 — Uruchom workflow

Wywolaj narzedzie **`Workflow`**:

- `name: 'implement-layered'` (skrypt w `.claude/workflows/implement-layered.js`). Gdyby nazwa sie nie rozwiazala, uzyj `scriptPath: '.claude/workflows/implement-layered.js'`.
- `args: { planPath: '<planPath>', layers: [<wykryte warstwy>] }`. Przekaz `args` jako zwykly obiekt — nie stringuj recznie. Harness potrafi zserializowac `args` do JSON-stringa, ale skrypt sam normalizuje (parsuje string), wiec obejscie z literalna sciezka planu nie jest potrzebne.

Workflow implementuje warstwy po kolei (dane -> backend -> frontend), przekazujac miedzy nimi strukturyzowany opis (tabele/typy/funkcje -> endpointy/zadania workera -> frontend), i konczy ograniczona petla `npm run build` + testy z delegowana naprawa. Poczekaj na zakonczenie (dostaniesz `<task-notification>`), potem odczytaj zwrocony obiekt `{ data, backend, frontend, verify }`.

## Krok 4 — Weryfikacja end-to-end (preview)

Workflow potwierdza tylko build/testy. **Ty** domykasz weryfikacje w przegladarce (workflowowe agenty nie maja narzedzi preview):

1. Jesli `verify` z workflowa nie jest zielone — najpierw domknij build/testy (popraw sam albo deleguj `Agent` Sonnet), potem dalej.
2. `preview_start` (config `dev`), przeladuj, sprawdz `preview_console_logs` / `preview_logs` / `preview_network` na bledy.
3. `preview_snapshot` + `preview_screenshot`, faktycznie przejdz sciezke feature wg „Kryteriow akceptacji" z planu.
4. **Mobile:** to PWA — `preview_resize` do waskiego ekranu (np. ~375px) i potwierdz, ze UI zostaje uzyteczne.
5. Przy porazce: napraw (sam lub delegujac) i weryfikuj od nowa, az zielone.

## Krok 5 — Podsumowanie i przekazanie

Zrefeuj zwiezle: co powstalo w kazdej warstwie (z `data/backend/frontend`), wynik weryfikacji (build/testy/preview, ze screenshotem) i wszelkie odstepstwa od planu. **Nie commituj z automatu** — zaproponuj `/code-review` i zapytaj wprost o zgode na commit + PR (jak BRAMKA 2 w `/plan-feature`). Commit/push tylko na wyrazne polecenie.

## Zasady

- Warstwy ida **sekwencyjnie** (nie rownolegle) — pracuja na tym samym drzewie po kolei, wiec bez izolacji worktree.
- Implementacja bywa iteracyjna (backend czasem wymusza korekte w danych). Jesli handoff pokaze niespojnosc, ktorej petla build/testy nie zlapie — nie „idz dalej na sile": zdiagnozuj i deleguj poprawke do wlasciwej warstwy.
- Prywatne vs wspolne dane: kazda nowa encja dziedziczaca po prywatnym rekordzie (np. dziecko prywatnej podrozy czy auta) musi respektowac granice `visibility: private` opisana w `docs/ARCHITECTURE.md` — identyfikator wlasciciela ustalany z sesji, nigdy z danych klienta.
- Subagentom w workflow kontekst idzie przez `args` i schema-handoff — nie zakladaj, ze maja Twoja historie rozmowy.
- Modele/effort ustawia skrypt workflowa (implementery: Sonnet). Nie potrzeba Ultracode.
