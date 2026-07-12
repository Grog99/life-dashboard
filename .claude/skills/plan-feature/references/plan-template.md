# <Nazwa featurea>

> Plan wygenerowany przez skill `/plan-feature`. Slug: `<slug>`. Branch: `feature/<slug>`.

## Kontekst / Problem

Dlaczego robimy ten feature — jaki problem lub potrzebę adresuje, co go wywołało, jaki jest oczekiwany efekt.

## Wymagania

- Wymaganie funkcjonalne 1
- Wymaganie funkcjonalne 2
- Wymagania niefunkcjonalne (wydajność, format danych, i18n itd.), jeśli istotne

## Zakres i Non-goals

**W zakresie:**
- ...

**Non-goals (świadomie pomijamy):**
- ...

## Podejście

Rekomendowane podejście na wysokim poziomie. Kluczowe decyzje architektoniczne i uzasadnienie. Jeśli odrzucono alternatywę — jedno zdanie dlaczego.

Pamiętaj o `docs/ARCHITECTURE.md`: to Fastify + PostgreSQL (nie Next.js), z rozróżnieniem danych prywatnych (per użytkownik) i wspólnych (gospodarstwo) przez `workspace_states`/`user_workspace_states`.

## Pliki do zmiany

Konkretne ścieżki i co się w nich dzieje. **Wskaż istniejące utility/komponenty do reużycia** (ze ścieżkami), zamiast pisać od zera.

Grupuj pliki w **trzy warstwy** poniżej — ta struktura napędza orkiestrator `/implement-feature` (implementacja idzie dane → backend → frontend, z przekazaniem kontekstu między warstwami). Warstwa, której feature nie dotyka, dostaje wpis `— brak —` (np. pure-frontend feature bez zmian w danych/backendzie).

**Baza (warstwa danych):** migracje SQL, zapytania/funkcje w `server/src/db.mjs`, wspólne typy w `src/types.ts`.

- `server/migrations/00X_xxx.sql` — co i po co
- `server/src/db.mjs` — nowa funkcja zapytania (reużyj istniejący wzorzec zapytań)

**Backend (warstwa backend):** route handlery Fastify w `server/src/server.mjs`, worker Web Push w `server/src/worker.mjs`, middleware/autoryzacja w `server/src/security.mjs`, integracje zewnętrzne.

- `server/src/server.mjs` — nowy endpoint + walidacja (wzorzec: istniejący route handler w tym pliku)
- `server/src/worker.mjs` — nowy/zmieniony job powiadomień (jeśli dotyczy)

**Frontend (warstwa frontend):** komponenty (`src/components/`), strony (`src/pages/`), stan (`src/store/`, zustand), hooki (`src/hooks/`).

- `src/components/XxxForm.tsx` — reużyj istniejące komponenty UI
- `src/pages/Xxx.tsx` — strona/karta konsumująca nowy endpoint

## Kryteria akceptacji

Obserwowalne warunki „done" — jak poznać, że feature działa (najlepiej dające się sprawdzić w preview / build / testach).

- [ ] ...
- [ ] `npm run build`, `npm test` i `npm run test:server` przechodzą
- [ ] Aplikacja odpala się i feature działa w preview (w tym na wąskim ekranie — to PWA)

## Ryzyka

Pułapki, zależności zewnętrzne, miejsca łatwe do zepsucia — np. granica prywatne/wspólne dane (`visibility: private`, identyfikator właściciela z sesji, nie z klienta), konflikty rewizji przy synchronizacji.

## Pytania do doprecyzowania

Otwarte pytania do użytkownika o feature lub implementację. Główny agent zada je po planowaniu i wykreśli po uzyskaniu odpowiedzi.

- [ ] Pytanie 1
- [ ] Pytanie 2
