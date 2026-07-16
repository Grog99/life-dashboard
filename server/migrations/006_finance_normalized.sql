-- Znormalizowane Finanse: konta/transakcje/budżety/cele oszczędnościowe przestają być
-- częścią dokumentów JSONB (workspace_states / user_workspace_states) i dostają własne
-- tabele z optymistyczną współbieżnością per rekord (kolumna `version`) oraz tabelę
-- idempotencji mutacji. Patrz docs/plans/model-synchronizacji-danych.md ("Model tabel").

CREATE TABLE IF NOT EXISTS finance_accounts (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('checking', 'savings', 'cash', 'credit')),
  balance_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL,
  color text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finance_accounts_household_idx ON finance_accounts(household_id);
CREATE INDEX IF NOT EXISTS finance_accounts_household_visibility_idx
  ON finance_accounts(household_id, visibility);
CREATE INDEX IF NOT EXISTS finance_accounts_owner_idx ON finance_accounts(owner_id);

CREATE TABLE IF NOT EXISTS finance_transactions (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES finance_accounts(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  booked_on date NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  merchant text NOT NULL DEFAULT '',
  title text NOT NULL,
  category text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'csv', 'subscription', 'trip', 'car')),
  fingerprint text,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finance_transactions_household_idx ON finance_transactions(household_id);
CREATE INDEX IF NOT EXISTS finance_transactions_account_idx ON finance_transactions(account_id);
CREATE INDEX IF NOT EXISTS finance_transactions_household_booked_idx
  ON finance_transactions(household_id, booked_on DESC);
-- Dedup importu CSV: fingerprint już zawiera accountId (src/lib/csvImport.ts), więc
-- zakres household odpowiada dzisiejszej globalnej deduplikacji po fingerprincie.
CREATE UNIQUE INDEX IF NOT EXISTS finance_transactions_fingerprint_unique_idx
  ON finance_transactions(household_id, fingerprint) WHERE fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance_budgets (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category text NOT NULL,
  limit_minor bigint NOT NULL CHECK (limit_minor >= 0),
  currency char(3) NOT NULL,
  color text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finance_budgets_household_idx ON finance_budgets(household_id);

CREATE TABLE IF NOT EXISTS finance_goals (
  id text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'household')),
  name text NOT NULL,
  target_minor bigint NOT NULL CHECK (target_minor >= 0),
  saved_minor bigint NOT NULL CHECK (saved_minor >= 0),
  currency char(3) NOT NULL,
  deadline date,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS finance_goals_household_idx ON finance_goals(household_id);
CREATE INDEX IF NOT EXISTS finance_goals_owner_idx ON finance_goals(owner_id);

CREATE TABLE IF NOT EXISTS finance_mutations (
  idempotency_key uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  op text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_mutations_created_idx ON finance_mutations(created_at);

-- ---------------------------------------------------------------------------
-- Migracja danych z JSONB.
--   workspace_states       = dane wspólne gospodarstwa (visibility zwykle 'household',
--                             ale mogą zawierać legacy rekordy oznaczone 'private').
--   user_workspace_states  = prywatne rekordy zalogowanego użytkownika; owner_id jest
--                             ZAWSZE brany z kolumny `user_id` tego wiersza (sesja), nigdy
--                             z pola `ownerId` w JSON.
-- Kolejność: najpierw konta (FK z transactions), potem transakcje, budżety, cele.
-- Wszystko defensywne wobec NULL/nieobecnych kolekcji i legacy `ownerId` ("me", stare id).
-- ---------------------------------------------------------------------------

-- Konta: wspólne
INSERT INTO finance_accounts (
  id, household_id, owner_id, visibility, name, type, balance_minor, currency, color, archived,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'name', ''), 'Konto'),
  CASE WHEN rec->>'type' IN ('checking', 'savings', 'cash', 'credit')
       THEN rec->>'type' ELSE 'checking' END,
  COALESCE((rec->>'balanceMinor')::bigint, 0),
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  COALESCE((rec->>'archived')::boolean, false),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'financeAccounts', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Konta: prywatne (owner_id z wiersza user_workspace_states, nie z JSON)
INSERT INTO finance_accounts (
  id, household_id, owner_id, visibility, name, type, balance_minor, currency, color, archived,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'name', ''), 'Konto'),
  CASE WHEN rec->>'type' IN ('checking', 'savings', 'cash', 'credit')
       THEN rec->>'type' ELSE 'checking' END,
  COALESCE((rec->>'balanceMinor')::bigint, 0),
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  COALESCE((rec->>'archived')::boolean, false),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'financeAccounts', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Transakcje: wspólne (pomijamy sieroty bez zmigrowanego konta w tym samym gospodarstwie)
INSERT INTO finance_transactions (
  id, household_id, account_id, owner_id, visibility, booked_on, amount_minor, currency,
  merchant, title, category, source, fingerprint, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  rec->>'accountId',
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE((rec->>'bookedOn')::date, (rec->>'updatedAt')::date, CURRENT_DATE),
  COALESCE((rec->>'amountMinor')::bigint, 0),
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  COALESCE(rec->>'merchant', ''),
  COALESCE(NULLIF(rec->>'title', ''), '(bez tytułu)'),
  COALESCE(NULLIF(rec->>'category', ''), 'inne'),
  CASE WHEN rec->>'source' IN ('manual', 'csv', 'subscription', 'trip', 'car')
       THEN rec->>'source' ELSE 'manual' END,
  NULLIF(rec->>'fingerprint', ''),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'financeTransactions', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM finance_accounts fa
    WHERE fa.id = rec->>'accountId' AND fa.household_id = ws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Transakcje: prywatne
INSERT INTO finance_transactions (
  id, household_id, account_id, owner_id, visibility, booked_on, amount_minor, currency,
  merchant, title, category, source, fingerprint, notes, version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  rec->>'accountId',
  uws.user_id,
  'private',
  COALESCE((rec->>'bookedOn')::date, (rec->>'updatedAt')::date, CURRENT_DATE),
  COALESCE((rec->>'amountMinor')::bigint, 0),
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  COALESCE(rec->>'merchant', ''),
  COALESCE(NULLIF(rec->>'title', ''), '(bez tytułu)'),
  COALESCE(NULLIF(rec->>'category', ''), 'inne'),
  CASE WHEN rec->>'source' IN ('manual', 'csv', 'subscription', 'trip', 'car')
       THEN rec->>'source' ELSE 'manual' END,
  NULLIF(rec->>'fingerprint', ''),
  NULLIF(rec->>'notes', ''),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'financeTransactions', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM finance_accounts fa
    WHERE fa.id = rec->>'accountId' AND fa.household_id = uws.household_id
  )
ON CONFLICT (id) DO NOTHING;

-- Budżety: tylko wspólne (FinanceBudget nie ma SharedMeta, zawsze household-wide)
INSERT INTO finance_budgets (
  id, household_id, category, limit_minor, currency, color, version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(NULLIF(rec->>'category', ''), 'inne'),
  COALESCE((rec->>'limitMinor')::bigint, 0),
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  COALESCE(NULLIF(rec->>'color', ''), '#397763'),
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'financeBudgets', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Cele oszczędnościowe: wspólne
INSERT INTO finance_goals (
  id, household_id, owner_id, visibility, name, target_minor, saved_minor, currency, deadline,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  ws.household_id,
  COALESCE(hm.user_id, h.created_by),
  CASE WHEN rec->>'visibility' = 'private' THEN 'private' ELSE 'household' END,
  COALESCE(NULLIF(rec->>'name', ''), 'Cel'),
  COALESCE((rec->>'targetMinor')::bigint, 0),
  COALESCE((rec->>'savedMinor')::bigint, 0),
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  NULLIF(rec->>'deadline', '')::date,
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM workspace_states ws
JOIN households h ON h.id = ws.household_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ws.data->'advanced'->'savingsGoals', '[]'::jsonb)) AS rec
LEFT JOIN household_members hm
  ON hm.household_id = ws.household_id AND hm.user_id::text = rec->>'ownerId'
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Cele oszczędnościowe: prywatne
INSERT INTO finance_goals (
  id, household_id, owner_id, visibility, name, target_minor, saved_minor, currency, deadline,
  version, created_at, updated_at
)
SELECT
  rec->>'id',
  uws.household_id,
  uws.user_id,
  'private',
  COALESCE(NULLIF(rec->>'name', ''), 'Cel'),
  COALESCE((rec->>'targetMinor')::bigint, 0),
  COALESCE((rec->>'savedMinor')::bigint, 0),
  COALESCE(NULLIF(rec->>'currency', ''), 'PLN'),
  NULLIF(rec->>'deadline', '')::date,
  1,
  COALESCE((rec->>'updatedAt')::timestamptz, now()),
  COALESCE((rec->>'updatedAt')::timestamptz, now())
FROM user_workspace_states uws
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(uws.data->'advanced'->'savingsGoals', '[]'::jsonb)) AS rec
WHERE rec->>'id' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Wycięcie finance z JSONB po migracji. Bump `revision` wymusza czysty refetch
-- u podłączonych klientów (por. docs/ARCHITECTURE.md "Synchronizacja").
-- WHERE-guardy czynią to bezpiecznym do ponownego uruchomienia (no-op gdy już wycięte).
-- ---------------------------------------------------------------------------

UPDATE workspace_states
SET data = data
    #- '{advanced,financeAccounts}'
    #- '{advanced,financeTransactions}'
    #- '{advanced,financeBudgets}'
    #- '{advanced,savingsGoals}',
  revision = revision + 1
WHERE data->'advanced' ?| array['financeAccounts', 'financeTransactions', 'financeBudgets', 'savingsGoals'];

UPDATE user_workspace_states
SET data = data
    #- '{advanced,financeAccounts}'
    #- '{advanced,financeTransactions}'
    #- '{advanced,savingsGoals}',
  updated_at = now()
WHERE data->'advanced' ?| array['financeAccounts', 'financeTransactions', 'savingsGoals'];
