-- Znormalizowane Zdrowie: healthAppointments/medications/healthMeasurements przestają być
-- częścią dokumentów JSONB (workspace_states / user_workspace_states) i dostają własne tabele
-- z optymistyczną współbieżnością per rekord (kolumna `version`) oraz tabelę idempotencji
-- mutacji. Patrz docs/plans/zdrowie-sql.md ("Model tabel", "Projekt pól specjalnych").
--
-- Piąta migracja wg tego wzorca (po Finansach/006, Podróżach/007, Meals/008, Aucie/009,
-- Zwierzętach/010) -- NAJBLIŻSZY analog: Zwierzęta (010). W ODRÓŻNIENIU od Zwierząt/Auta/Podróży,
-- Zdrowie jest trzema CAŁKOWICIE NIEZALEŻNYMI, płaskimi kolekcjami -- żadnego `pet_id`/
-- `vehicle_id`-podobnego FK między nimi, żadnej kaskady widoczności, żadnego guardu sierot,
-- żadnego `EXISTS` na rodzicu. Każda tabela ma WŁASNĄ `owner_id`/`visibility` i filtruje
-- wyłącznie po swoim wierszu.
--
-- Rozstrzygnięcie specjalne: `health_measurements.measured_at` jest kolumną `text`, NIE
-- `timestamptz`. To free-form string budowany dziś w HealthPage.tsx jako `${date}T${time}`
-- (bez sekund/strefy), czytany przez `split("T")`/`parseISO`. Rzutowanie na `timestamptz`
-- zepsułoby wartość 1:1 (przesunięcie strefowe + doklejone sekundy/`Z`) -- patrz
-- docs/plans/zdrowie-sql.md "Projekt pól specjalnych" / "Ryzyka".
--
-- Historyczne prywatne wizyty/leki/pomiary migrują jako PRYWATNE -- bez ujawnienia (parytet
-- z 009/010).

CREATE TABLE IF NOT EXISTS health_appointments (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  title text NOT NULL,
  clinician text NOT NULL,
  specialty text,
  date date NOT NULL,
  -- `time` jako text (clockTime "HH:MM"), nie `time`/`timestamptz` -- parytet z dzisiejszym
  -- stringiem i uniknięcie strefowego parsowania node-postgres (potrzebne dla push -24h), wzór
  -- pet_visits.time (010).
  time text NOT NULL,
  location text,
  status text NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS health_appointments_household_idx ON health_appointments(household_id);
CREATE INDEX IF NOT EXISTS health_appointments_household_visibility_idx
  ON health_appointments(household_id, visibility);
CREATE INDEX IF NOT EXISTS health_appointments_owner_idx ON health_appointments(owner_id);

CREATE TABLE IF NOT EXISTS medications (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  name text NOT NULL,
  dosage text NOT NULL,
  -- Wolnotekstowa etykieta ("Codziennie po śniadaniu"), NIE structured recurrence.
  schedule text NOT NULL,
  active boolean NOT NULL,
  -- Jedno pole, nullable -- prawdziwy toggle liczony po stronie klienta (nie tabela historii,
  -- świadome odrzucenie medication_intake_log -- YAGNI). Odczyt jako `::text` (dodge strefowy).
  last_taken_on date,
  -- clockTime "HH:MM" jako text z tej samej racji co health_appointments.time; potrzebne dla
  -- codziennego push.
  reminder_time text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS medications_household_idx ON medications(household_id);
CREATE INDEX IF NOT EXISTS medications_household_visibility_idx
  ON medications(household_id, visibility);
CREATE INDEX IF NOT EXISTS medications_owner_idx ON medications(owner_id);

CREATE TABLE IF NOT EXISTS health_measurements (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  type text NOT NULL CHECK (type IN ('weight', 'blood_pressure', 'glucose', 'temperature', 'other')),
  value text NOT NULL,
  -- Dopuszczalny pusty string (np. ciśnienie bez jednostki) -- `z.string().max(100)`, nie
  -- nonEmptyText.
  unit text NOT NULL,
  -- Free-form timestamp (Date.parse-owalny), NIE date/timestamptz -- patrz komentarz nagłówka.
  measured_at text NOT NULL,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS health_measurements_household_idx ON health_measurements(household_id);
CREATE INDEX IF NOT EXISTS health_measurements_household_visibility_idx
  ON health_measurements(household_id, visibility);
CREATE INDEX IF NOT EXISTS health_measurements_owner_idx ON health_measurements(owner_id);

CREATE TABLE IF NOT EXISTS health_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_mutations_created_idx ON health_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa (visibility zwykle 'household', ale mogą
--                             zawierać legacy rekordy oznaczone 'private').
--   user_workspace_states  = prywatne rekordy zalogowanego użytkownika; owner_id jest ZAWSZE
--                             brany z kolumny `user_id` tego wiersza (sesja), NIGDY z pola
--                             `ownerId` w JSON. Prywatne rekordy migrują jako PRYWATNE (bez
--                             ujawnienia -- parytet z 009/010).
-- Zdrowie nie ma relacji rodzic/dziecko -- BRAK guardów sierot, BRAK EXISTS na rodzicu (w
-- odróżnieniu od pet_expenses/pet_visits w 010). Wszystko defensywne wobec NULL/nieobecnych
-- kolekcji i legacy `ownerId` ("me", stare id).
-- ---------------------------------------------------------------------------

-- Wizyty (healthAppointments): wspólne
INSERT INTO health_appointments (
  id, household_id, owner_id, visibility, title, clinician, specialty, date, time, location,
  status, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
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
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'advanced'->'healthAppointments', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Wizyty (healthAppointments): prywatne (owner_id z wiersza user_workspace_states, nie z JSON)
INSERT INTO health_appointments (
  id, household_id, owner_id, visibility, title, clinician, specialty, date, time, location,
  status, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
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
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'advanced'->'healthAppointments', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Leki (medications): wspólne
INSERT INTO medications (
  id, household_id, owner_id, visibility, name, dosage, schedule, active, last_taken_on,
  reminder_time, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'name', ''), 'Lek'),
  COALESCE(rec->>'dosage', ''),
  COALESCE(NULLIF(rec->>'schedule', ''), 'Codziennie'),
  COALESCE((rec->>'active')::boolean, true),
  NULLIF(rec->>'lastTakenOn', '')::date,
  NULLIF(rec->>'reminderTime', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'advanced'->'medications', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Leki (medications): prywatne
INSERT INTO medications (
  id, household_id, owner_id, visibility, name, dosage, schedule, active, last_taken_on,
  reminder_time, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'name', ''), 'Lek'),
  COALESCE(rec->>'dosage', ''),
  COALESCE(NULLIF(rec->>'schedule', ''), 'Codziennie'),
  COALESCE((rec->>'active')::boolean, true),
  NULLIF(rec->>'lastTakenOn', '')::date,
  NULLIF(rec->>'reminderTime', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'advanced'->'medications', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Pomiary (healthMeasurements): wspólne. `measured_at` zachowany 1:1 jako text (bez rzutowania).
INSERT INTO health_measurements (
  id, household_id, owner_id, visibility, type, value, unit, measured_at, notes, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  CASE WHEN rec->>'type' IN ('weight', 'blood_pressure', 'glucose', 'temperature', 'other')
       THEN rec->>'type' ELSE 'other' END,
  COALESCE(NULLIF(rec->>'value', ''), '—'),
  COALESCE(rec->>'unit', ''),
  COALESCE(NULLIF(rec->>'measuredAt', ''), to_char(now(), 'YYYY-MM-DD"T"HH24:MI')),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(ws.data->'advanced'->'healthMeasurements', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Pomiary (healthMeasurements): prywatne
INSERT INTO health_measurements (
  id, household_id, owner_id, visibility, type, value, unit, measured_at, notes, version,
  created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  CASE WHEN rec->>'type' IN ('weight', 'blood_pressure', 'glucose', 'temperature', 'other')
       THEN rec->>'type' ELSE 'other' END,
  COALESCE(NULLIF(rec->>'value', ''), '—'),
  COALESCE(rec->>'unit', ''),
  COALESCE(NULLIF(rec->>'measuredAt', ''), to_char(now(), 'YYYY-MM-DD"T"HH24:MI')),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL
  jsonb_array_elements(COALESCE(uws.data->'advanced'->'healthMeasurements', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie Zdrowia z JSONB po migracji. Bump `revision` wymusza czysty refetch u podłączonych
-- klientów (por. docs/ARCHITECTURE.md "Synchronizacja"). WHERE-guardy czynią to bezpiecznym do
-- ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data
    #- '{advanced,healthAppointments}'
    #- '{advanced,medications}'
    #- '{advanced,healthMeasurements}',
  revision = revision + 1
WHERE data->'advanced' ?| array['healthAppointments', 'medications', 'healthMeasurements'];

UPDATE user_workspace_states
SET data = data
    #- '{advanced,healthAppointments}'
    #- '{advanced,medications}'
    #- '{advanced,healthMeasurements}',
  updated_at = now()
WHERE data->'advanced' ?| array['healthAppointments', 'medications', 'healthMeasurements'];
