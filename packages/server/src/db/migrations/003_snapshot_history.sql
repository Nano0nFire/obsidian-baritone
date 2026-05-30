CREATE TABLE IF NOT EXISTS yjs_snapshot_history(
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  room_epoch bigint NOT NULL,
  seq bigint NOT NULL,
  snapshot bytea NOT NULL,
  state_vector bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT 'compact' CHECK (reason IN ('activation','cadence','compact','demote','restore')),
  device_id text,
  user_id uuid REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS yjs_snapshot_history_file_time
  ON yjs_snapshot_history(vault_id,file_id,created_at DESC,seq DESC,version_id DESC);

CREATE INDEX IF NOT EXISTS yjs_snapshot_history_gc
  ON yjs_snapshot_history(vault_id,file_id,created_at DESC);
