-- Znormalizowane Zwierzęta: pets/petExpenses/petVisits przestają być częścią dokumentów
-- JSONB (workspace_states / user_workspace_states) i dostają własne tabele z optymistyczną
-- współbieżnością per rekord (kolumna `version`) oraz tabelę idempotencji mutacji.
-- Patrz docs/plans/zwierzeta-sql.md ("Model tabel", "Projekt fishStock").
--
-- Wzorem Auta (009) Zwierzęta ZACHOWUJĄ rozróżnienie prywatne/wspólne: `pets`/`pet_expenses`/
-- `pet_visits` mają własne `owner_id`/`visibility` (W ODRÓŻNIENIU od `vehicle_deadlines`, oba
-- dzieci Zwierząt mają WŁASNĄ widoczność, nie dziedziczą jej przez EXISTS na rodzicu).
-- Historyczne prywatne profile/wydatki/wizyty migrują jako PRYWATNE — bez ujawnienia (parytet
-- z 009, różnica względem 007/008).
--
-- `fishStock` (wariant `kind='aquarium'`) jest zagnieżdżoną kolumną JSONB w `pets`, wzorem
-- `trips.travelers` (007) — wędruje atomowo z rekordem profilu, bez własnej wersji/kolizji.
-- W odróżnieniu od `travelers` jest NULLABLE (pole opcjonalne, materializowane tylko dla
-- akwariów) — migracja NIE robi `COALESCE(rec->'fishStock', '[]'::jsonb)`.

CREATE TABLE IF NOT EXISTS pets (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rabbit', 'dog', 'cat', 'guinea_pig', 'aquarium', 'other')),
  color text NOT NULL,
  species text,
  birth_date date,
  fish_stock jsonb,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS pets_household_idx ON pets(household_id);
CREATE INDEX IF NOT EXISTS pets_household_visibility_idx ON pets(household_id, visibility);
CREATE INDEX IF NOT EXISTS pets_owner_idx ON pets(owner_id);

CREATE TABLE IF NOT EXISTS pet_expenses (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  pet_id text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  date date NOT NULL,
  type text NOT NULL CHECK (type IN ('food', 'vet', 'accessories', 'grooming', 'other')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  title text NOT NULL,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS pet_expenses_household_idx ON pet_expenses(household_id);
CREATE INDEX IF NOT EXISTS pet_expenses_pet_idx ON pet_expenses(pet_id);
CREATE INDEX IF NOT EXISTS pet_expenses_household_visibility_idx
  ON pet_expenses(household_id, visibility);

CREATE TABLE IF NOT EXISTS pet_visits (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  pet_id text NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  title text NOT NULL,
  clinician text NOT NULL,
  specialty text,
  date date NOT NULL,
  -- `time` jako text (clockTime "HH:MM"), nie `time`/`timestamptz` — parytet z dzisiejszym
  -- stringiem i uniknięcie strefowego parsowania node-postgres (potrzebne dla push -24h).
  time text NOT NULL,
  location text,
  status text NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS pet_visits_household_idx ON pet_visits(household_id);
CREATE INDEX IF NOT EXISTS pet_visits_pet_idx ON pet_visits(pet_id);
CREATE INDEX IF NOT EXISTS pet_visits_household_visibility_idx
  ON pet_visits(household_id, visibility);

CREATE TABLE IF NOT EXISTS pet_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pet_mutations_created_idx ON pet_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa (visibility zwykle 'household', ale mogą
--                             zawierać legacy rekordy oznaczone 'private').
--   user_workspace_states  = prywatne rekordy zalogowanego użytkownika; owner_id jest ZAWSZE
--                             brany z kolumny `user_id` tego wiersza (sesja), NIGDY z pola
--                             `ownerId` w JSON. Prywatne rekordy migrują jako PRYWATNE (bez
--                             ujawnienia — parytet z 009).
-- Kolejność: najpierw profile (FK z petExpenses/petVisits), potem wydatki i wizyty.
-- Wszystko defensywne wobec NULL/nieobecnych kolekcji i legacy `ownerId` ("me", stare id).
-- Dzieci (petExpenses/petVisits) bez zmigrowanego rodzica-profilu w tym samym gospodarstwie są
-- pomijane (guard sierot, wzór 006/007/009).
-- ---------------------------------------------------------------------------

-- Profile (pets): wspólne
INSERT INTO pets (
  id, household_id, owner_id, visibility, name, kind, color, species, birth_date, fish_stock,
  notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'name', ''), 'Zwierzę'),
  CASE WHEN rec->>'kind' IN ('rabbit', 'dog', 'cat', 'guinea_pig', 'aquarium', 'other')
       THEN rec->>'kind' ELSE 'other' END,
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  NULLIF(rec->>'species', ''),
  NULLIF(rec->>'birthDate', '')::date,
  rec->'fishStock',
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'pets', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Profile (pets): prywatne (owner_id z wiersza user_workspace_states, nie z JSON; bez ujawnienia)
INSERT INTO pets (
  id, household_id, owner_id, visibility, name, kind, color, species, birth_date, fish_stock,
  notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'name', ''), 'Zwierzę'),
  CASE WHEN rec->>'kind' IN ('rabbit', 'dog', 'cat', 'guinea_pig', 'aquarium', 'other')
       THEN rec->>'kind' ELSE 'other' END,
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  NULLIF(rec->>'species', ''),
  NULLIF(rec->>'birthDate', '')::date,
  rec->'fishStock',
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'pets', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Wydatki (petExpenses): wspólne (pomijamy sieroty bez zmigrowanego profilu w tym samym gospodarstwie)
INSERT INTO pet_expenses (
  id, household_id, pet_id, owner_id, visibility, date, type, amount_minor, title, notes,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  rec->>'petId',
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  CASE WHEN rec->>'type' IN ('food', 'vet', 'accessories', 'grooming', 'other')
       THEN rec->>'type' ELSE 'other' END,
  GREATEST(0, COALESCE((rec->>'amountMinor')::bigint, 0)),
  COALESCE(NULLIF(rec->>'title', ''), '(bez tytułu)'),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'petExpenses', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pets p WHERE p.id = rec->>'petId' AND p.household_id = ws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Wydatki (petExpenses): prywatne
INSERT INTO pet_expenses (
  id, household_id, pet_id, owner_id, visibility, date, type, amount_minor, title, notes,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  rec->>'petId',
  uws.user_id,
  'private',
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  CASE WHEN rec->>'type' IN ('food', 'vet', 'accessories', 'grooming', 'other')
       THEN rec->>'type' ELSE 'other' END,
  GREATEST(0, COALESCE((rec->>'amountMinor')::bigint, 0)),
  COALESCE(NULLIF(rec->>'title', ''), '(bez tytułu)'),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'petExpenses', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pets p WHERE p.id = rec->>'petId' AND p.household_id = uws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Wizyty (petVisits): wspólne (pomijamy sieroty bez zmigrowanego profilu w tym samym gospodarstwie)
INSERT INTO pet_visits (
  id, household_id, pet_id, owner_id, visibility, title, clinician, specialty, date, time,
  location, status, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  rec->>'petId',
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'title', ''), 'Wizyta'),
  COALESCE(rec->>'clinician', ''),
  NULLIF(rec->>'specialty', ''),
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'time', ''), '00:00'),
  NULLIF(rec->>'location', ''),
  CASE WHEN rec->>'status' IN ('scheduled', 'completed', 'cancelled')
       THEN rec->>'status' ELSE 'scheduled' END,
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'petVisits', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pets p WHERE p.id = rec->>'petId' AND p.household_id = ws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Wizyty (petVisits): prywatne
INSERT INTO pet_visits (
  id, household_id, pet_id, owner_id, visibility, title, clinician, specialty, date, time,
  location, status, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  rec->>'petId',
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'title', ''), 'Wizyta'),
  COALESCE(rec->>'clinician', ''),
  NULLIF(rec->>'specialty', ''),
  COALESCE((rec->>'date')::date, CURRENT_DATE),
  COALESCE(NULLIF(rec->>'time', ''), '00:00'),
  NULLIF(rec->>'location', ''),
  CASE WHEN rec->>'status' IN ('scheduled', 'completed', 'cancelled')
       THEN rec->>'status' ELSE 'scheduled' END,
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'petVisits', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pets p WHERE p.id = rec->>'petId' AND p.household_id = uws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie Zwierząt z JSONB po migracji. Bump `revision` wymusza czysty refetch u podłączonych
-- klientów (por. docs/ARCHITECTURE.md "Synchronizacja"). WHERE-guardy czynią to bezpiecznym
-- do ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data
    #- '{advanced,pets}'
    #- '{advanced,petExpenses}'
    #- '{advanced,petVisits}',
  revision = revision + 1
WHERE data->'advanced' ?| array['pets', 'petExpenses', 'petVisits'];

UPDATE user_workspace_states
SET data = data
    #- '{advanced,pets}'
    #- '{advanced,petExpenses}'
    #- '{advanced,petVisits}',
  updated_at = now()
WHERE data->'advanced' ?| array['pets', 'petExpenses', 'petVisits'];
