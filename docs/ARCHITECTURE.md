# Architektura Puls 2.0

## Granice systemu

```text
PWA React/Vite
      │ HTTPS + sesja HttpOnly
      ▼
Fastify API ───── PostgreSQL
      │               ▲
      ├── Google OAuth│
      └── worker push ┘
```

Fastify serwuje frontend i API z jednego originu. Pangolin kończy TLS i przekazuje ruch wyłącznie do kontenera `app`. PostgreSQL działa w wewnętrznej sieci Docker; worker ma dodatkową, wychodzącą sieć potrzebną do Web Push, ale nie publikuje żadnego portu.

## Uwierzytelnianie i gospodarstwa

- Pierwsze konto powstaje z sekretem `BOOTSTRAP_TOKEN`.
- Kolejne osoby dołączają przez siedmiodniowy link. Link obsługuje zarówno nowe, jak i istniejące konto.
- Hasła są hashowane przez scrypt z osobną solą.
- Losowy token sesji trafia do cookie `Secure`, `HttpOnly`, `SameSite=Lax`; w bazie pozostaje tylko jego SHA-256.
- Role to `owner`, `admin` i `member`.
- Każde żądanie sprawdza aktywne gospodarstwo i członkostwo.

## Dane wspólne i prywatne

Stan przejściowy używa dwóch wersjonowanych dokumentów JSONB:

- `workspace_states` — dane wspólne gospodarstwa,
- `user_workspace_states` — prywatne rekordy oraz osobiste ustawienia bieżącego użytkownika.

API rozdziela rekordy oznaczone `visibility: private` przed zapisem i scala wyłącznie prywatną część zalogowanej osoby przy odczycie. Dzieci prywatnych encji — np. transakcje rachunku, plan prywatnej podróży czy terminy prywatnego auta — dziedziczą tę granicę. Identyfikator właściciela prywatnego rekordu jest ustalany z sesji, nie z dowolnej wartości klienta.

Motyw, energia, intencja, scratchpad i ukrywanie kwot są przechowywane per użytkownik. Zgoda oraz aktywna subskrypcja powiadomień pozostają lokalne dla konkretnego urządzenia.

PWA utrzymuje lokalny cache potrzebny do pracy przy chwilowym braku sieci. Cache przeglądarki nie jest dodatkowo szyfrowany, dlatego urządzenie i profil systemowy powinny być chronione blokadą ekranu. Wylogowanie usuwa dane użytkowe, stan synchronizacji i subskrypcję push z danego urządzenia.

## Synchronizacja

Klient wysyła oczekiwaną rewizję. Serwer atomowo zapisuje część wspólną i prywatną; niezgodna rewizja zwraca `409`. Frontend serializuje zapisy, utrzymuje znacznik niedokończonych zmian i wykonuje trójstronne scalanie kolekcji po `id`. Niezależne zmiany dwóch urządzeń są zachowywane; jednoczesna edycja dokładnie tego samego pola używa wartości lokalnej ostatniego klienta.

To nadal dokumentowy model współpracy. Przy bardzo intensywnej edycji przez wiele osób docelową ewolucją są mutacje domenowe i znormalizowane tabele z idempotency keys.

## Powiadomienia

Worker wysyła Web Push osobno do każdej zapisanej subskrypcji urządzenia. Dostarczenia mają lease, retry z backoffem i deduplikację. Obsługiwane są:

- ręczne przypomnienia,
- wydarzenia kalendarza (30 minut wcześniej),
- płatności subskrypcji,
- wyjazdy,
- terminy samochodu,
- wizyty oraz leki z ustawioną godziną.

Prywatne rekordy trafiają tylko do subskrypcji ich właściciela. Wyłączenie powiadomień lub wylogowanie usuwa subskrypcję danego urządzenia.

## Integracje i sekrety

Refresh token Google jest szyfrowany AES-256-GCM. Puls nie przechowuje danych logowania do banku. API ustawia CSP, HSTS, ochronę ramek, kontrolę originu i limit rozmiaru workspace.

`TOKEN_ENCRYPTION_KEY` jest częścią backupu operacyjnego: jego utrata uniemożliwi odczyt zapisanych tokenów Google, a zmiana wymaga ponownego połączenia integracji.

## Dalsza ewolucja

Status i priorytety kolejnych migracji z modelu JSONB na znormalizowane tabele SQL (wzorzec
ustalony przez Finanse) śledzi `docs/DATA_MODEL_MIGRATION.md`.

1. Znormalizowane finanse, import batches i reguły kategoryzacji.
2. CAMT.053 oraz opcjonalny konektor Open Banking.
3. Inkrementalny Google Calendar przez `syncToken` i webhook.
4. Pliki podróży poza publicznym katalogiem z autoryzowanym pobieraniem.
5. Opcjonalne MFA/WebAuthn i granularne role domenowe.
