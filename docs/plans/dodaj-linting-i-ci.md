# Dodaj linting i CI

> Plan wygenerowany przez skill `/plan-feature`. Slug: `dodaj-linting-i-ci`. Branch: `claude/linting-ci-7pmgz5`.

## Kontekst / Problem

Repo Puls 2.0 (PWA React 19 + Vite w `src/`, Fastify + PostgreSQL w `server/`, serwowane z jednego originu) nie ma dziś **żadnego lintingu, formatowania ani CI**:

- brak `eslint.config.js`, brak Prettiera, brak `.github/` (potwierdzone: `.github/workflows` nie istnieje),
- jedyna „weryfikacja" to ręczne `npm run build`, `npm test`, `cd server && npm test` (README, sekcja „Weryfikacja"),
- nic nie pilnuje jakości kodu przy push / pull requeście — regresje (nieużywane zmienne, złamane reguły hooków, niespójne formatowanie) łapane są dopiero lokalnie albo wcale.

Cel: dodać spójny linting (frontend TS/React + backend Node/ESM), formatowanie Prettierem oraz pipeline GitHub Actions uruchamiany na push i pull_request, który blokuje wejście kodu łamiącego lint/build/testy.

To jest **praca czysto infrastrukturalna (tooling/CI)** — nie dotyka warstwy danych ani logiki aplikacji (patrz „Zakres i Non-goals" oraz uwaga o warstwach niżej).

## Wymagania

- **Linting frontendu**: ESLint 9 flat config + `typescript-eslint`, z pluginami `eslint-plugin-react-hooks` (React 19) i `eslint-plugin-react-refresh` (Vite/HMR). Reguły TS-aware dopasowane do `src/**/*.{ts,tsx}`.
- **Linting backendu**: reguły dopasowane do Node/ESM dla `server/**/*.mjs` (globalne `node`, ESM `sourceType: module`), **bez** reguł React. Spójne z resztą repo.
- **Prettier**: dodany razem z lintingiem; zintegrowany z ESLint przez `eslint-config-prettier` (wyłącza reguły formatujące ESLint, żeby nie kolidowały z Prettierem). **Bez** `eslint-plugin-prettier` — formatowanie osobnym poleceniem `prettier --check` / `prettier --write`.
- **CI (GitHub Actions)** na push i pull_request: lint (frontend + backend), build frontendu (`npm run build`), testy frontendu (`npm test`) i backendu (`npm run test:server`), z cache npm dla przyspieszenia.
- Niefunkcjonalne: zero zmian w runtime aplikacji, w bazie i w API; po jednorazowym `prettier --write .` cały istniejący kod ma przechodzić `format:check` i `lint` na zielono (żeby CI od startu był zielony na `main`).

## Zakres i Non-goals

**W zakresie:**
- `eslint.config.js` (root, flat config) z **dwiema sekcjami**: frontend (`src/**`) i backend (`server/**`).
- Konfiguracja Prettiera (`.prettierrc.json` + `.prettierignore`).
- Nowe devDependencies i skrypty (`lint`, `lint:fix`, `format`, `format:check`) w **root** `package.json`.
- Workflow `.github/workflows/ci.yml`.
- Wpis `.eslintcache` w `.gitignore`.
- Sekcja o lint/format/CI w `README.md`.
- Jednorazowe znormalizowanie istniejącego kodu Prettierem oraz naprawa realnych błędów zgłoszonych przez ESLint (tak, żeby `main` był zielony).

**Non-goals (świadomie pomijamy):**
- Zmiany w warstwie danych (migracje SQL, `server/src/db.mjs`) i w warstwie backend (endpointy w `server/src/server.mjs`, worker, security). **Ten feature ich nie dotyka.**
- Zmiany logiki komponentów/stanu/hooków frontendu poza tym, co wymusi naprawa realnych lintów.
- `eslint-plugin-prettier` (świadomie pominięty — patrz Wymagania).
- Type-aware linting typescript-eslint (`recommendedTypeChecked` / `parserOptions.projectService`) — patrz „Podejście": startujemy od nietypowanego `recommended`, bo `tsc -b` w buildzie CI już robi pełną kontrolę typów; typed-linting jako ewentualne późniejsze rozszerzenie.
- Branch protection / wymagane statusy na GitHubie (ustawienie po stronie repo, poza kodem) — patrz „Pytania do doprecyzowania".
- Pre-commit hooki (husky/lint-staged), release/publish, deploy, Dependabot.
- Lint plików spoza kodu źródłowego (build output `dist/`, `coverage/`, `server/src` SQL, assety w `public/`).

## Podejście

**Jeden root `eslint.config.js`, nie osobny config w `server/`.** Mimo że backend to osobny projekt npm (własny `server/package.json` **i** `server/package-lock.json`, budowany osobnym `npm ci` w Dockerfile), to nadal **jedno repo lintowane z roota w jednym kroku CI**. ESLint 9 flat config jest tablicą obiektów konfiguracyjnych scopowanych per `files`, więc heterogeniczne pliki (`src/**/*.{ts,tsx}` vs `server/**/*.mjs`) obsługujemy w jednym pliku dwiema sekcjami. Zalety: pojedynczy zestaw devDependencies ESLinta (tylko w root `package.json`, bez duplikacji w `server/`), jeden krok `eslint .` w CI, jedno źródło reguł. `server/package.json` **nie** dostaje własnego toolchainu ESLinta.

- Odrzucona alternatywa (osobny `server/eslint.config.js` + ESLint w `server/package.json`): uzasadniona tylko gdyby backend miał całkowicie rozłączny toolchain uruchamiany niezależnie; tu CI i tak leci z roota, więc duplikacja instalacji/konfiguracji nie daje korzyści.

**Baza konfiguracji frontendu** = kanoniczny starter szablonu Vite React-TS 19: `@eslint/js` recommended + `tseslint.configs.recommended` (nietypowany) + `eslint-plugin-react-hooks` (`recommended-latest`) + `eslint-plugin-react-refresh` (`vite`), na końcu `eslint-config-prettier` żeby zdjąć reguły kolidujące z Prettierem. Backend: `@eslint/js` recommended + globalne `node` + `eslint-config-prettier`, bez React.

**Prettier osobno od ESLinta.** ESLint pilnuje poprawności kodu, Prettier — formatowania. `eslint-config-prettier` (dołączony jako ostatni w tablicy flat config) wyłącza wszystkie stylistyczne reguły ESLinta. Format sprawdzamy/naprawiamy poleceniem `prettier`. Konfiguracja Prettiera minimalna, dobrana pod **istniejący styl kodu** (podwójne cudzysłowy, średniki, wcięcie 2 spacje — zgodne z domyślnymi ustawieniami Prettiera, patrz np. `vite.config.ts`), żeby jednorazowe `prettier --write .` dało minimalny diff.

**CI: jeden workflow, jeden job** `ci` (dla małego repo prostszy i wystarczający niż rozbijanie na równoległe joby). Krok po kroku: checkout → `actions/setup-node@v4` (Node 22, `cache: npm`, `cache-dependency-path` obejmujący **oba** lockfile) → `npm ci` (root) → `npm ci --prefix server` → `lint` → `format:check` → `build` → `test` → `test:server`. Node 22 dobrany pod Dockerfile (`node:22-alpine`); bez matrixa (jeden target = mniej szumu; matrix jako opcja na przyszłość).

**Cache npm dla obu package.json:** jeden krok `actions/setup-node` z `cache: npm` i `cache-dependency-path: |` listującym `package-lock.json` **oraz** `server/package-lock.json`. To cache'uje globalny cache npm (`~/.npm`) współdzielony przez oba `npm ci` i inwaliduje po zmianie któregokolwiek lockfile. Osobny cache katalogu nie jest potrzebny — `server/` ma własny lockfile, ale to nadal ten sam globalny cache pobranych paczek na runnerze.

**Zgodność z `docs/ARCHITECTURE.md`:** architektura (Fastify + PostgreSQL, dane wspólne `workspace_states` vs prywatne `user_workspace_states`, synchronizacja przez rewizje, worker Web Push) pozostaje **nietknięta**. Ten feature nie dodaje endpointów, migracji, ani nie dotyka granicy prywatne/wspólne — to wyłącznie tooling wokół istniejącego kodu.

### Uwaga o warstwowym workflow (`implement-layered`)

Szablon planu i orkiestrator `/implement-feature` zakładają warstwy **dane → backend → frontend** z przekazaniem schematu między warstwami. **Ten feature nie pasuje do tego modelu 1:1:** nie ma warstwy danych (zero migracji/zapytań) ani warstwy backend w sensie API (zero endpointów). Cała zmiana to **tooling/CI**. Dlatego:

- Warstwy „Baza" i „Backend (API)" = **brak — nie dotyczy**.
- Zamiast warstw sugerowany podział na **dwa logiczne etapy jednego przebiegu** (nie wymaga trybu warstwowego):
  1. **Konfiguracja lokalna** — ESLint + Prettier + skrypty + `.gitignore`, jednorazowa normalizacja (`prettier --write .`) i naprawa lintów; weryfikacja `npm run lint && npm run format:check && npm run build && npm test && npm run test:server` lokalnie na zielono.
  2. **CI workflow** — `.github/workflows/ci.yml` odtwarzający dokładnie te kroki + cache; plus aktualizacja `README.md`.
- Etap 2 zależy od 1 (workflow uruchamia skrypty zdefiniowane w etapie 1), więc kolejność jest liniowa i najlepiej zrobić to **jednym przebiegiem** (albo dwoma commitami: „config" + „CI"), nie orkiestracją warstwową.

## Pliki do zmiany

Uwaga: `src/server/` to mimo nazwy **kod frontendowy** (browserowy klient API, `.ts`/`.tsx`) — objęty sekcją frontendu (`src/**`), nie backendu. Prawdziwy backend to katalog `server/` (`.mjs`).

**Baza (warstwa danych):** — brak — (feature nie dotyka danych)

**Backend (warstwa backend / API):** — brak — (feature nie dodaje endpointów; `server/**/*.mjs` jest jedynie *lintowany*, nie zmieniany logicznie)

**Tooling / konfiguracja (root):**

- `eslint.config.js` (NOWY, root, flat config) — jedno źródło reguł dla całego repo. Szkielet w sekcji „Szkielety plików" niżej. Zawiera: global ignores, sekcję frontendu (`src/**/*.{ts,tsx}`), sekcję backendu (`server/**/*.mjs`), `eslint-config-prettier` na końcu.
- `.prettierrc.json` (NOWY) — minimalna konfiguracja Prettiera dopasowana do obecnego stylu.
- `.prettierignore` (NOWY) — wyłącza `dist/`, `coverage/`, lockfile, build output, assety `public/` i inne pliki niebędące kodem.
- `package.json` (root, ZMIANA) — nowe `devDependencies` (ESLint + pluginy + Prettier) i nowe skrypty:
  - `"lint": "eslint . --max-warnings 0"` (ostrzeżenia też blokują CI — ustalone)
  - `"lint:fix": "eslint . --fix"`
  - `"format": "prettier --write ."`
  - `"format:check": "prettier --check ."`
  - `package-lock.json` (root) zaktualizowany przez `npm install` po dodaniu devDeps.
- `.gitignore` (ZMIANA) — dopisać `.eslintcache` (ESLint cache; przydatne jeśli włączymy `--cache`).
- `server/package.json` — **bez zmian toolchainu** (świadomie: jeden root config lintuje `server/**`). Opcjonalnie *tylko* skrypt-delegat `"lint": "eslint --config ../eslint.config.js ."` gdyby ktoś chciał lintować z `server/` — **nie jest wymagany**, domyślnie pomijamy, bo ESLint i pluginy nie są instalowane w `server/node_modules`.

**CI:**

- `.github/workflows/ci.yml` (NOWY) — patrz szkielet niżej.

**Frontend (warstwa frontend):**

- `src/**/*.{ts,tsx}` — **bez zmian logicznych**; tylko (a) jednorazowe formatowanie Prettierem i (b) ewentualne naprawy realnych lintów (np. nieużywany import). Objęte lintingiem, nie przepisywaniem. Reużywamy istniejące pliki — nic nowego w warstwie aplikacji.
- `public/sw.js` (service worker, plain JS) — **wykluczony** z ESLinta i Prettiera (dodany do `ignores` / `.prettierignore`), żeby nie wymuszać reguł browserowego SW. (Decyzja domyślna; alt: osobna sekcja z globalami `serviceworker` — patrz Pytania.)

**Dokumentacja:**

- `README.md` (ZMIANA) — rozszerzyć sekcję „Weryfikacja" o `npm run lint` i `npm run format:check`; dodać krótką notkę o CI (GitHub Actions na push/PR). Opcjonalny badge CI — patrz Pytania.

## Szkielety plików (punkt startowy dla implementera)

### `eslint.config.js` (root, flat config)

```js
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Globalne ignores (build output, deps, assety, service worker)
  {
    ignores: [
      "dist",
      "coverage",
      "server/node_modules",
      "public/sw.js",
    ],
  },

  // FRONTEND: src/**/*.{ts,tsx}
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended, // nietypowany; tsc -b w CI robi kontrolę typów
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },

  // BACKEND: server/**/*.mjs (Node/ESM, bez React)
  {
    files: ["server/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },

  // Prettier na końcu — wyłącza reguły stylistyczne kolidujące z Prettierem
  eslintConfigPrettier,
);
```

Uwagi dla implementera:
- `tseslint.config(...)` to helper z pakietu `typescript-eslint` (typowane API flat config).
- Jeśli ESLint zgłosi realne błędy w istniejącym kodzie (np. `@typescript-eslint/no-unused-vars`, `no-empty`), naprawić je w kodzie; nie wyłączać reguł hurtowo. Ewentualne pojedyncze wyjątki przez inline `// eslint-disable-next-line` z komentarzem.
- Pliki testowe `*.test.ts(x)` są objęte sekcją frontendu; jeśli testy używają globali (sprawdzić czy `vitest` importowany jawnie — w `src/test/setup.ts` używany `@testing-library/jest-dom`), w razie potrzeby dodać sekcję z globalami vitest, ale domyślnie zakładamy jawne importy.

### `.prettierrc.json`

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100
}
```
(Dobrane pod istniejący styl: podwójne cudzysłowy + średniki jak w `vite.config.ts`. Implementer: po dodaniu odpalić `prettier --write .` i zweryfikować, że diff jest kosmetyczny/minimalny; jeśli `printWidth`/`trailingComma` generują duży diff, dostroić do istniejącego stylu.)

### `.prettierignore`

```
dist
coverage
package-lock.json
server/package-lock.json
public/sw.js
*.md
```
(`*.md` opcjonalnie — jeśli chcemy formatować dokumentację/plany Prettierem, usunąć tę linię. Domyślnie wyłączamy, żeby nie przeformatować istniejących planów w `docs/plans/`.)

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: |
            package-lock.json
            server/package-lock.json

      - name: Install frontend deps
        run: npm ci

      - name: Install server deps
        run: npm ci --prefix server

      - name: Lint (frontend + backend)
        run: npm run lint

      - name: Prettier check
        run: npm run format:check

      - name: Build frontend
        run: npm run build

      - name: Test frontend
        run: npm test

      - name: Test backend
        run: npm run test:server
```

Uwagi:
- `pull_request` bez filtra gałęzi = wszystkie PR-y (w praktyce feature branche `claude/*` → `main`). `push` ograniczony do `main`, żeby nie dublować runów na każdym push feature brancha (walidacja i tak przez PR) — **ustalone**, zostaje jak w szkicu.
- `npm run lint` w kroku CI ma używać `--max-warnings 0` (ostrzeżenia też blokują CI) — **ustalone**. Skrypt root: `"lint": "eslint . --max-warnings 0"`.
- `npm run test:server` = `npm --prefix server test` = `node --test test/*.node.mjs` (istniejący skrypt); backend nie potrzebuje bazy do tych testów (to testy jednostkowe `*.node.mjs`) — implementer potwierdzi, że przechodzą bez PostgreSQL.
- Kolejność kroków tak, by tańsze/szybsze (lint, format) failowały wcześniej niż build/testy.
- Node 22 spójne z Dockerfile.

## Kryteria akceptacji

- [ ] `npx eslint .` przechodzi na zielono dla `src/**/*.{ts,tsx}` i `server/**/*.mjs` (0 błędów).
- [ ] `npx prettier --check .` przechodzi (po jednorazowym `prettier --write .` zacommitowanym).
- [ ] `npm run lint`, `npm run lint:fix`, `npm run format`, `npm run format:check` istnieją w root `package.json` i działają.
- [ ] `eslint-config-prettier` faktycznie zdejmuje reguły stylistyczne (brak konfliktów: `npx eslint-config-prettier ./src/App.tsx` — helper CLI — nie zgłasza kolizji), Prettier i ESLint nie walczą o formatowanie.
- [ ] `.github/workflows/ci.yml` uruchamia się na push do `main` i na pull_request; wszystkie kroki (lint, format:check, build, test, test:server) zielone.
- [ ] Cache npm działa (widoczny „Cache restored"/„saved" w logach setup-node) i pokrywa oba lockfile.
- [ ] `npm run build`, `npm test` i `npm run test:server` nadal przechodzą lokalnie i w CI.
- [ ] Zero zmian w runtime aplikacji (żaden endpoint, migracja, komponent nie zmienił zachowania) — diff to konfiguracja + formatowanie + ewentualne kosmetyczne naprawy lintów.
- [ ] `README.md` udokumentowany o lint/format i CI.

## Ryzyka

- **Istniejący kod nie przechodzi lintu/formatu od razu.** `prettier --write .` przeformatuje pliki (duży, ale mechaniczny diff) i `eslint .` może wykryć realne problemy (nieużywane zmienne/importy, reguły hooków). Mitigacja: jednorazowa normalizacja + naprawa w tym samym PR, żeby `main` startował zielony. Rozbić commity: „chore: eslint+prettier config", „style: prettier --write", „fix: eslint findings" dla czytelnego review.
- **Rozdzielny toolchain frontend/backend w jednym configu.** Sekcja `server/**/*.mjs` nie może dziedziczyć reguł React ani parsera TS. Pilnować scopowania przez `files`; `server/node_modules` w `ignores` (ESLint ignoruje `**/node_modules` domyślnie, ale jawny wpis nie szkodzi).
- **Wersje pod ESLint 9 flat config + React 19 + TS 5.9.** Użyć: `eslint@^9`, `typescript-eslint@^8` (pakiet zbiorczy z helperem `config`), `eslint-plugin-react-hooks@^5` (wsparcie React 19 + eksport flat `recommended-latest`), `eslint-plugin-react-refresh@^0.4`, `eslint-config-prettier@^10`, `prettier@^3`, `@eslint/js@^9`, `globals@^15`. Nie mieszać ze starym `.eslintrc` (RC) — wyłącznie flat config. Implementer instaluje najnowsze zgodne patche w tych majorach.
- **`prettier --check .` w CI vs pliki dokumentacji.** Jeśli `*.md` nie jest w `.prettierignore`, Prettier będzie wymagał sformatowania istniejących planów w `docs/plans/` — domyślnie ignorujemy `*.md`, by tego uniknąć.
- **Testy backendu bez bazy.** `node --test test/*.node.mjs` musi przejść w CI bez usługi PostgreSQL. Zweryfikować lokalnie; jeśli któryś test wymaga DB, trzeba by dodać usługę `postgres` do joba (obecnie zakładamy, że to testy jednostkowe i nie wymaga).
- **Cache przy dwóch lockfile.** `cache-dependency-path` musi listować oba pliki, inaczej cache inwaliduje się niepoprawnie po zmianie tylko jednego. Współdzielony jest globalny cache npm, nie `node_modules` — oba `npm ci` z niego korzystają.
- **`public/sw.js`.** Ręczny service worker w plain JS — domyślnie wykluczony z lint/format, żeby nie wymuszać reguł browser/TS. Jeśli chcemy go lintować, trzeba osobnej sekcji z globalami `serviceworker`.

## Pytania do doprecyzowania

Wszystkie pytania rozstrzygnięte z użytkownikiem:

- **Branch protection / wymagane statusy:** nie konfigurujemy teraz (poza kodem repo, wymaga uprawnień admina) — w opisie PR wspominamy jako sugerowany ręczny krok dla maintainera.
- **`--max-warnings 0` w CI:** tak, ostrzeżenia ESLinta też blokują CI. Skrypt: `"lint": "eslint . --max-warnings 0"`.
- **Badge CI w README:** tak, dodać badge statusu workflow na górze `README.md` (np. `![CI](https://github.com/Grog99/life-dashboard/actions/workflows/ci.yml/badge.svg)`).
- **Trigger na push feature branchy:** zostaje jak w szkicu — `push` tylko na `main`, `pull_request` na wszystkie PR-y (unika podwójnych runów gdy PR jest otwarty).
- **Formatowanie Markdown/`docs`:** nie, `*.md` zostaje w `.prettierignore` (jak w szkicu) — unika przeformatowania istniejących planów w `docs/plans/`.
- **`public/sw.js`:** wykluczyć z lint/format (jak w szkicu, domyślna decyzja z sekcji „Ryzyka") — plain JS service worker bez reguł browser/TS.
