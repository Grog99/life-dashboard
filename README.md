# Puls 2.0 — Life Dashboard

Minimalistyczne, self-hosted centrum codziennego życia dla jednej osoby lub całego domu. Łączy plan dnia, kalendarz, szybkie notatki i przypomnienia z finansami, podróżami, subskrypcjami, posiłkami, samochodem oraz podstawowym modułem zdrowia.

## Najważniejsze funkcje

- wspólny dom z kontami, rolami i linkami zaproszeń,
- prywatne i współdzielone rekordy rozdzielane po stronie serwera,
- widok „Dzisiaj”, zadania, notatki, rytuały, kalendarz i szybkie dodawanie,
- budżety, konta, cele, historia transakcji i kontrolowany import CSV do 10 000 operacji,
- planer podróży z harmonogramem, rezerwacjami, budżetem i pakowaniem,
- subskrypcje, tygodniowy plan posiłków, lista zakupów i przepisy,
- koszty, przebieg i terminy samochodu,
- prywatne wizyty, codzienna rutyna leków i podstawowe pomiary zdrowia,
- PWA na komputer i telefon z Web Push,
- ręczny import/upsert wydarzeń z Google Calendar,
- eksport JSON oraz backup całej bazy PostgreSQL.

## Dwa tryby pracy

### Lokalny / demonstracyjny

Wymagany jest Node.js 20+.

```bash
npm install
npm run dev
```

Dane są wtedy przechowywane w `localStorage` bieżącej przeglądarki. To dobry tryb do obejrzenia interfejsu i pracy jednoosobowej bez serwera.

### Self-hosted / wieloosobowy

Wersja produkcyjna działa jako zestaw Docker Compose: aplikacja Fastify, worker powiadomień i PostgreSQL. Frontend buduje się z `VITE_SERVER_MODE=true`, wymaga logowania i synchronizuje urządzenia.

Pełna instrukcja, w tym Pangolin, Google OAuth, VAPID i backupy: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

```bash
cp .env.example .env
docker compose build
docker compose up -d
```

W PowerShell odpowiednikiem pierwszej komendy jest `Copy-Item .env.example .env`.

## Weryfikacja

```bash
npm run build
npm test
cd server
npm test
```

## Prywatność i bezpieczeństwo

Prywatne rekordy modułów są przechowywane w osobnym dokumencie per użytkownik, a wspólne — per gospodarstwo. Motyw, energia, intencja, scratchpad i zgoda na powiadomienia również są osobiste. Sesja korzysta z ciasteczka `Secure`/`HttpOnly`, hasła są hashowane przez scrypt, a tokeny Google szyfrowane AES-256-GCM.

Puls nie prosi o login ani hasło do banku. Obecny import finansów działa przez plik CSV. Szczegóły i realne opcje automatyzacji opisuje [docs/FINANCE_IMPORT.md](docs/FINANCE_IMPORT.md).

## Dokumentacja

- [Architektura i model synchronizacji](docs/ARCHITECTURE.md)
- [Wdrożenie w homelabie](docs/DEPLOYMENT.md)
- [Import finansów i automatyzacja](docs/FINANCE_IMPORT.md)
