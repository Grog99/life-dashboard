DELETE FROM push_subscriptions older
USING push_subscriptions newer
WHERE older.endpoint = newer.endpoint
  AND (older.created_at, older.id) < (newer.created_at, newer.id);

ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_endpoint_key;

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique_idx
  ON push_subscriptions(endpoint);
