# Wdrożenie Puls 2.0 w homelabie

Puls używa trzech usług:

- `app` — Fastify API, logowanie i statyczny frontend,
- `worker` — Web Push i przypomnienia pochodne,
- `db` — PostgreSQL, bez publicznego portu.

## 1. Sekrety i plik .env

Skopiuj `.env.example` do `.env`. Na Linuksie wygeneruj osobne wartości:

```bash
openssl rand -hex 32       # POSTGRES_PASSWORD
openssl rand -base64 32    # TOKEN_ENCRYPTION_KEY
openssl rand -hex 32       # BOOTSTRAP_TOKEN
chmod 600 .env
```

Wartości przypisz do odpowiednich pól; nie wklejaj komentarzy ani spacji. Hasło PostgreSQL jest przekazywane jako `PGPASSWORD`, więc nie trzeba go kodować do URL.

`TOKEN_ENCRYPTION_KEY` po dekodowaniu musi mieć dokładnie 32 bajty. Zachowaj go razem z backupami — po jego utracie zapisanych tokenów Google nie da się odszyfrować. Zmiana klucza wymaga wcześniejszego odłączenia lub późniejszego ponownego połączenia Google Calendar.

`BOOTSTRAP_TOKEN` musi mieć co najmniej 24 znaki. Po utworzeniu właściciela endpoint nie pozwoli wykonać drugiego bootstrapu, ale zmienna nadal jest wymagana przy starcie; można ją zrotować i przechowywać w managerze sekretów.

## 2. Uruchomienie

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```

Migracje uruchamiają się automatycznie przed startem API. Test gotowości:

```bash
curl http://127.0.0.1:8080/health/ready
```

Pierwszy ekran poprosi o e-mail, hasło, nazwę domu i `BOOTSTRAP_TOKEN`. Kolejne osoby dołączają przez link z Ustawień. Link działa dla nowego i istniejącego konta.

## 3. Pangolin i HTTPS

Ustaw dokładny publiczny origin, bez końcowego ukośnika:

```dotenv
APP_ORIGIN=https://puls.twoja-domena.pl
GOOGLE_REDIRECT_URI=https://puls.twoja-domena.pl/api/v1/integrations/google/callback
```

Najwygodniejsze warianty:

1. Pangolin na tym samym hoście poza Dockerem: resource kieruje do `http://ADRES_LAN_HOSTA:8080`; ustaw `PULS_BIND` na adres LAN lub `0.0.0.0` i ogranicz port firewallem.
2. Pangolin/Traefik w Dockerze: dołącz proxy do sieci `puls-edge` i ustaw target `http://app:8080`. W takim wariancie mapowanie portu hosta można usunąć z Compose.

Nie publikuj portu 5432. `TRUST_PROXY=1` ma sens wyłącznie wtedy, gdy aplikację od klienta dzieli dokładnie jeden bezpośredni, zaufany proxy (typowy target Pangolin/Traefik → `app`). Puls ufa wówczas jednemu hopowi, a nie dowolnemu nagłówkowi `X-Forwarded-For`. Produkcyjny `APP_ORIGIN` musi używać HTTPS. Instalacja PWA, Web Push i bezpieczne cookie wymagają secure context; wyjątkiem przeglądarek jest lokalny `localhost`.

Przy konfiguracji Local Site na tej samej maszynie Pangolin może kierować ruch bez tunelowania. Szczegóły: [Pangolin — running without tunneling](https://docs.pangolin.net/self-host/advanced/without-tunneling).

## 4. Google Calendar

W Google Cloud:

1. włącz Google Calendar API,
2. utwórz OAuth Client typu Web application,
3. wpisz dokładny Authorized redirect URI z `.env`,
4. uzupełnij `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` i `GOOGLE_REDIRECT_URI`,
5. odtwórz kontener `app`.

Puls prosi o `calendar.readonly` i podstawowy profil. Używa OAuth `state`, dostępu offline i szyfrowanego refresh tokenu. Połączenie można odwołać z Ustawień.

Przycisk „Google” w kalendarzu wykonuje ręczny import/upsert głównego kalendarza na 90 dni do przodu. Obsługuje paginację, aktualizacje i anulowane wydarzenia po stabilnym `externalId`, ale nie jest jeszcze ciągłą dwukierunkową synchronizacją ani webhookiem. Importowane wydarzenia trafiają do wspólnego kalendarza domu.

Referencje: [Google OAuth 2.0 for web servers](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync).

## 5. PWA i Web Push

Po zbudowaniu obrazu wygeneruj klucze VAPID z lokalnej zależności obrazu:

```bash
docker compose run --rm app sh -lc 'cd /app/server && ./node_modules/.bin/web-push generate-vapid-keys'
```

Wpisz wynik do `VAPID_PUBLIC_KEY` i `VAPID_PRIVATE_KEY`, ustaw prawdziwy kontakt w `VAPID_SUBJECT`, a następnie:

```bash
docker compose up -d --force-recreate app worker
```

Na każdym telefonie/komputerze zainstaluj PWA i osobno włącz powiadomienia w Ustawieniach. Worker wysyła do wszystkich aktywnych urządzeń danego użytkownika, ponawia przejściowe błędy i deduplikuje dostarczenia.

Powiadomienia obejmują ręczne przypomnienia, wydarzenia kalendarza, płatności subskrypcji, wyjazdy, datowane terminy samochodu, wizyty oraz leki z ustawioną godziną. Terminy przebiegowe bez daty są widoczne w aplikacji, ale nie mają naturalnej godziny systemowego push.

## 6. Backup i odtworzenie

Ręczny backup PostgreSQL:

```bash
docker compose exec -T db pg_dump -U puls -d puls -Fc > puls-$(date +%F).dump
```

Test odtworzenia do osobnej bazy:

```bash
docker compose exec -T db createdb -U puls puls_restore_test
docker compose exec -T db pg_restore -U puls -d puls_restore_test --clean --if-exists < puls-2026-07-10.dump
docker compose exec -T db dropdb -U puls puls_restore_test
```

Pełne odtworzenie produkcji jest operacją destrukcyjną. Najpierw wykonaj dodatkowy dump, zatrzymaj `app` i `worker`, odtwórz bazę do czystej instancji, a dopiero potem uruchom usługi i sprawdź `/health/ready`. Backup musi zawierać także ten sam `TOKEN_ENCRYPTION_KEY`.

Trzymaj kopie na innym dysku lub NAS, szyfruj je, rotuj i regularnie testuj. Sam volume Dockera nie jest backupem. Eksport JSON z Ustawień jest przenośną kopią danych użytkowych, ale nie obejmuje kont, sesji, logu audytowego ani integracji.

## 7. Aktualizacja

```bash
docker compose exec -T db pg_dump -U puls -d puls -Fc > puls-before-update.dump
git pull
docker compose build --pull
docker compose up -d
docker compose ps
```

Migracje są wersjonowane w `schema_migrations`. Nie edytuj już zastosowanych plików migracji na działającym wdrożeniu; każda zmiana schematu powinna dostać kolejny numer.

Jeśli testowałeś przedpremierowy backend sprzed rozdzielenia danych wspólnych i prywatnych, nie aktualizuj takiego volume w ciemno. W tamtym formacie nie ma wiarygodnej informacji pozwalającej automatycznie przypisać wszystkie rekordy „Tylko ja” do właściwej osoby. Wyeksportuj dane, uruchom czystą bazę Puls 2.0 i zaimportuj je po zalogowaniu na odpowiednie konto. Świeże instalacje oraz bazy utworzone przez obecny zestaw migracji nie wymagają tego kroku.
