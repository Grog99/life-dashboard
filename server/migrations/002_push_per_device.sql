ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES push_subscriptions(id) ON DELETE CASCADE;

DO $$
DECLARE
  old_constraint text;
BEGIN
  SELECT constraint_name
    INTO old_constraint
    FROM information_schema.table_constraints
   WHERE table_schema = current_schema()
     AND table_name = 'notification_deliveries'
     AND constraint_type = 'UNIQUE'
     AND constraint_name <> 'notification_deliveries_pkey'
     AND constraint_name NOT LIKE '%subscription%'
   LIMIT 1;

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notification_deliveries DROP CONSTRAINT %I', old_constraint);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_per_subscription_idx
  ON notification_deliveries(household_id, subscription_id, reminder_id, occurrence, channel);
