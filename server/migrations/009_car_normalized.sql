-- Znormalizowane Auto: vehicles/carExpenses/vehicleDeadlines przestają być częścią dokumentów
-- JSONB (workspace_states / user_workspace_states) i dostają własne tabele z optymistyczną
-- współbieżnością per rekord (kolumna `version`, z jednym świadomym wyjątkiem — `mileage`,
-- patrz docs/plans/auto-car.md "Projekt mileage") oraz tabelę idempotencji mutacji.
-- Patrz docs/plans/auto-car.md ("Model tabel").
--
-- W ODRÓŻNIENIU od Podróży (007) i Meals (008), które porzuciły widoczność, Auto ZACHOWUJE
-- rozróżnienie prywatne/wspólne: `vehicles`/`car_expenses` mają `owner_id`/`visibility`
-- (model referencyjny — Finanse, `006_finance_normalized.sql`). `vehicle_deadlines` NIE mają
-- własnej widoczności — dziedziczą ją po pojeździe-rodzicu (parytet z dzisiejszym
-- `CHILD_RELATIONS` w `server/src/workspace.mjs`); dostęp filtrowany przez `EXISTS` na `vehicles`.
-- Historyczne prywatne pojazdy/koszty migrują jako PRYWATNE — bez ujawnienia (różnica względem
-- 007/008, gdzie prywatne migrowały jako wspólne).

CREATE TABLE IF NOT EXISTS vehicles (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  name text NOT NULL,
  make text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  year integer NOT NULL,
  plate text NOT NULL DEFAULT '',
  mileage integer NOT NULL DEFAULT 0 CHECK (mileage >= 0),
  fuel_type text NOT NULL CHECK (fuel_type IN ('petrol', 'diesel', 'hybrid', 'electric')),
  inspection_date date NOT NULL,
  insurance_date date NOT NULL,
  color text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS vehicles_household_idx ON vehicles(household_id);
CREATE INDEX IF NOT EXISTS vehicles_household_visibility_idx ON vehicles(household_id, visibility);
CREATE INDEX IF NOT EXISTS vehicles_owner_idx ON vehicles(owner_id);

CREATE TABLE IF NOT EXISTS car_expenses (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  vehicle_id text NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  date date NOT NULL,
  type text NOT NULL CHECK (type IN ('fuel', 'service', 'insurance', 'parking', 'other')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  mileage integer,
  liters double precision,
  title text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS car_expenses_household_idx ON car_expenses(household_id);
CREATE INDEX IF NOT EXISTS car_expenses_vehicle_idx ON car_expenses(vehicle_id);
CREATE INDEX IF NOT EXISTS car_expenses_household_visibility_idx
  ON car_expenses(household_id, visibility);

-- Bez `owner_id`/`visibility` — dziedziczy widoczność po pojeździe-rodzicu (`vehicle_id`).
-- Częściowy unikat `(vehicle_id, kind)` dla kind IN ('inspection','insurance') egzekwuje
-- "jeden auto-generowany termin danego rodzaju per pojazd" i pozwala na
-- `INSERT ... ON CONFLICT (vehicle_id, kind) DO UPDATE` przy serwerowym auto-upsercie
-- (warstwa backend, `upsertAutoDeadline`). `kind='custom'` nie jest objęty unikatem.
CREATE TABLE IF NOT EXISTS vehicle_deadlines (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  vehicle_id text NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('inspection', 'insurance', 'custom')),
  title text NOT NULL,
  due_date date,
  due_mileage integer,
  completed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS vehicle_deadlines_household_idx ON vehicle_deadlines(household_id);
CREATE INDEX IF NOT EXISTS vehicle_deadlines_vehicle_idx ON vehicle_deadlines(vehicle_id);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_deadlines_kind_unique_idx
  ON vehicle_deadlines(vehicle_id, kind) WHERE kind IN ('inspection', 'insurance');

CREATE TABLE IF NOT EXISTS car_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS car_mutations_created_idx ON car_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa (visibility zwykle 'household', ale mogą
--                             zawierać legacy rekordy oznaczone 'private').
--   user_workspace_states  = prywatne rekordy zalogowanego użytkownika; owner_id jest ZAWSZE
--                             brany z kolumny `user_id` tego wiersza (sesja), NIGDY z pola
--                             `ownerId` w JSON. Prywatne rekordy migrują jako PRYWATNE (bez
--                             ujawnienia — różnica względem 007/008).
-- Kolejność: najpierw pojazdy (FK z carExpenses/vehicleDeadlines), potem koszty i terminy.
-- Wszystko defensywne wobec NULL/nieobecnych kolekcji i legacy `ownerId` ("me", stare id).
-- Dzieci (carExpenses/vehicleDeadlines) bez zmigrowanego rodzica-pojazdu w tym samym
-- gospodarstwie są pomijane (guard sierot, wzór 006/007).
-- ---------------------------------------------------------------------------

-- Pojazdy: wspólne
INSERT INTO vehicles (
  id, household_id, owner_id, visibility, name, make, model, year, plate, mileage, fuel_type,
  inspection_date, insurance_date, color, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'name', ''), 'Pojazd'),
  COALESCE(rec->>'make', ''),
  COALESCE(rec->>'model', ''),
  GREATEST(1886, LEAST(2200, COALESCE((rec->>'year')::integer, EXTRACT(YEAR FROM now())::integer))),
  COALESCE(rec->>'plate', ''),
  GREATEST(0, COALESCE((rec->>'mileage')::integer, 0)),
  CASE WHEN rec->>'fuelType' IN ('petrol', 'diesel', 'hybrid', 'electric')
       THEN rec->>'fuelType' ELSE 'petrol' END,
  COALESCE(NULLIF(rec->>'inspectionDate', '')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'insuranceDate', '')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'vehicles', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Pojazdy: prywatne (owner_id z wiersza user_workspace_states, nie z JSON; bez ujawnienia)
INSERT INTO vehicles (
  id, household_id, owner_id, visibility, name, make, model, year, plate, mileage, fuel_type,
  inspection_date, insurance_date, color, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'name', ''), 'Pojazd'),
  COALESCE(rec->>'make', ''),
  COALESCE(rec->>'model', ''),
  GREATEST(1886, LEAST(2200, COALESCE((rec->>'year')::integer, EXTRACT(YEAR FROM now())::integer))),
  COALESCE(rec->>'plate', ''),
  GREATEST(0, COALESCE((rec->>'mileage')::integer, 0)),
  CASE WHEN rec->>'fuelType' IN ('petrol', 'diesel', 'hybrid', 'electric')
       THEN rec->>'fuelType' ELSE 'petrol' END,
  COALESCE(NULLIF(rec->>'inspectionDate', '')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'insuranceDate', '')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'vehicles', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Koszty (carExpenses): wspólne (pomijamy sieroty bez zmigrowanego pojazdu w tym samym gospodarstwie)
INSERT INTO car_expenses (
  id, household_id, vehicle_id, owner_id, visibility, date, type, amount_minor, mileage,
  liters, title, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  rec->>'vehicleId',
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  CASE WHEN rec->>'type' IN ('fuel', 'service', 'insurance', 'parking', 'other')
       THEN rec->>'type' ELSE 'other' END,
  GREATEST(0, COALESCE((rec->>'amountMinor')::bigint, 0)),
  (rec->>'mileage')::integer,
  (rec->>'liters')::double precision,
  COALESCE(NULLIF(rec->>'title', ''), '(bez tytułu)'),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'carExpenses', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM vehicles v WHERE v.id = rec->>'vehicleId' AND v.household_id = ws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Koszty (carExpenses): prywatne
INSERT INTO car_expenses (
  id, household_id, vehicle_id, owner_id, visibility, date, type, amount_minor, mileage,
  liters, title, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  rec->>'vehicleId',
  uws.user_id,
  'private',
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  CASE WHEN rec->>'type' IN ('fuel', 'service', 'insurance', 'parking', 'other')
       THEN rec->>'type' ELSE 'other' END,
  GREATEST(0, COALESCE((rec->>'amountMinor')::bigint, 0)),
  (rec->>'mileage')::integer,
  (rec->>'liters')::double precision,
  COALESCE(NULLIF(rec->>'title', ''), '(bez tytułu)'),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'carExpenses', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM vehicles v WHERE v.id = rec->>'vehicleId' AND v.household_id = uws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Terminy (vehicleDeadlines): wspólne. Backfill `kind` przez jednorazowe dopasowanie po `title`
-- (ostatni raz — po tej migracji `kind` jest identyfikatorem, `title` tylko etykietą).
-- Dedup unikatu (vehicle_id, kind) dla auto-kindów: gdyby historycznie istniały dwa terminy tego
-- samego rodzaju na jednym pojeździe, zachowujemy najwcześniej utworzony. Brak realnego
-- `createdAt` w legacy JSON (VehicleDeadline go nie miał) — jako proxy używamy pozycji w
-- oryginalnej tablicy JSON (`WITH ORDINALITY`), czyli kolejności wstawienia. `kind='custom'`
-- nie ma unikatu, więc dedup go nie dotyczy (klucz dedupu = własne `id`, zawsze unikalne).
WITH shared_deadlines AS (
  SELECT
    rec->>'id' AS id,
    ws.household_id AS household_id,
    rec->>'vehicleId' AS vehicle_id,
    CASE
      WHEN rec->>'title' = 'Badanie techniczne' THEN 'inspection'
      WHEN rec->>'title' = 'Odnowienie OC/AC' THEN 'insurance'
      ELSE 'custom'
    END AS kind,
    COALESCE(NULLIF(rec->>'title', ''), 'Termin') AS title,
    NULLIF(rec->>'dueDate', '')::date AS due_date,
    (rec->>'dueMileage')::integer AS due_mileage,
    COALESCE((rec->>'completed')::boolean, false) AS completed,
    ord AS ordinality
  FROM workspace_states ws
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'vehicleDeadlines', '[]'::jsonb))
    WITH ORDINALITY AS elems(rec, ord)
  WHERE rec->>'id' IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM vehicles v WHERE v.id = rec->>'vehicleId' AND v.household_id = ws.household_id
    )
)
INSERT INTO vehicle_deadlines (
  id, household_id, vehicle_id, kind, title, due_date, due_mileage, completed, version,
  created_at, updated_at
)
SELECT DISTINCT ON (
  CASE WHEN kind IN ('inspection', 'insurance') THEN vehicle_id || ':' || kind ELSE id END
)
  id, household_id, vehicle_id, kind, title, due_date, due_mileage, completed, 1, now(), now()
FROM shared_deadlines
ORDER BY
  CASE WHEN kind IN ('inspection', 'insurance') THEN vehicle_id || ':' || kind ELSE id END,
  ordinality ASC
ON CONFLICT (id) DO NOTHING;

-- Terminy (vehicleDeadlines): prywatne (dziedziczą widoczność po pojeździe-rodzicu, więc same
-- nie niosą `owner_id`/`visibility` — nic do przepisania poza household_id z uws)
WITH private_deadlines AS (
  SELECT
    rec->>'id' AS id,
    uws.household_id AS household_id,
    rec->>'vehicleId' AS vehicle_id,
    CASE
      WHEN rec->>'title' = 'Badanie techniczne' THEN 'inspection'
      WHEN rec->>'title' = 'Odnowienie OC/AC' THEN 'insurance'
      ELSE 'custom'
    END AS kind,
    COALESCE(NULLIF(rec->>'title', ''), 'Termin') AS title,
    NULLIF(rec->>'dueDate', '')::date AS due_date,
    (rec->>'dueMileage')::integer AS due_mileage,
    COALESCE((rec->>'completed')::boolean, false) AS completed,
    ord AS ordinality
  FROM user_workspace_states uws
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'vehicleDeadlines', '[]'::jsonb))
    WITH ORDINALITY AS elems(rec, ord)
  WHERE rec->>'id' IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM vehicles v WHERE v.id = rec->>'vehicleId' AND v.household_id = uws.household_id
    )
)
INSERT INTO vehicle_deadlines (
  id, household_id, vehicle_id, kind, title, due_date, due_mileage, completed, version,
  created_at, updated_at
)
SELECT DISTINCT ON (
  CASE WHEN kind IN ('inspection', 'insurance') THEN vehicle_id || ':' || kind ELSE id END
)
  id, household_id, vehicle_id, kind, title, due_date, due_mileage, completed, 1, now(), now()
FROM private_deadlines
ORDER BY
  CASE WHEN kind IN ('inspection', 'insurance') THEN vehicle_id || ':' || kind ELSE id END,
  ordinality ASC
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie Auta z JSONB po migracji. Bump `revision` wymusza czysty refetch u podłączonych
-- klientów (por. docs/ARCHITECTURE.md "Synchronizacja"). WHERE-guardy czynią to bezpiecznym
-- do ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data
    #- '{advanced,vehicles}'
    #- '{advanced,carExpenses}'
    #- '{advanced,vehicleDeadlines}',
  revision = revision + 1
WHERE data->'advanced' ?| array['vehicles', 'carExpenses', 'vehicleDeadlines'];

UPDATE user_workspace_states
SET data = data
    #- '{advanced,vehicles}'
    #- '{advanced,carExpenses}'
    #- '{advanced,vehicleDeadlines}',
  updated_at = now()
WHERE data->'advanced' ?| array['vehicles', 'carExpenses', 'vehicleDeadlines'];
