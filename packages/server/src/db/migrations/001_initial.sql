CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations(
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vaults(
  vault_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  next_seq bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users(
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  pw_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vault_members(
  vault_id uuid NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(vault_id,user_id)
);

CREATE TABLE IF NOT EXISTS devices(
  device_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  vault_id uuid NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  name text NOT NULL,
  last_device_seq bigint NOT NULL DEFAULT 0,
  last_seq bigint NOT NULL DEFAULT 0,
  last_seen timestamptz,
  revoked bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files(
  file_id uuid PRIMARY KEY,
  vault_id uuid NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('note','attachment','config')),
  path text NOT NULL,
  path_normalized text NOT NULL,
  path_clock jsonb NOT NULL,
  content_vv jsonb NOT NULL DEFAULT '{}',
  content_hash text,
  size bigint,
  blob_ref text,
  delete_vv jsonb,
  deleted bool NOT NULL DEFAULT false,
  deleted_at timestamptz,
  epoch int NOT NULL DEFAULT 0,
  conflict_id uuid,
  active_lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS files_live_path ON files(vault_id, path_normalized) WHERE deleted=false;
CREATE INDEX IF NOT EXISTS files_manifest_page ON files(vault_id, deleted, path_normalized, file_id);

CREATE TABLE IF NOT EXISTS file_ops(
  vault_id uuid NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  op_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES devices(device_id),
  device_seq bigint NOT NULL,
  file_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(vault_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS file_ops_opid ON file_ops(op_id);
CREATE UNIQUE INDEX IF NOT EXISTS file_ops_devseq ON file_ops(device_id, device_seq);

CREATE TABLE IF NOT EXISTS note_content(
  content_hash text PRIMARY KEY,
  text bytea NOT NULL,
  size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments(
  file_id uuid PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE,
  hash text NOT NULL,
  size bigint NOT NULL,
  mime text,
  upload_status text NOT NULL CHECK (upload_status IN ('pending','uploaded','verified','deleted')),
  blob_ref text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blobs(
  hash text PRIMARY KEY,
  size bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','uploaded','verified','unreferenced','deleted')),
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  unreferenced_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS blob_refs(
  hash text NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
  ref_type text NOT NULL CHECK (ref_type IN ('file_live','file_version','conflict_base','conflict_side','yjs_snapshot','trash')),
  ref_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(hash, ref_type, ref_id)
);

CREATE TABLE IF NOT EXISTS conflicts(
  conflict_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('content','delete','attachment','rename')),
  base_hash text,
  ours_hash text,
  theirs_hash text,
  ours_vv jsonb,
  theirs_vv jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','resolved')),
  claimed_by uuid REFERENCES devices(device_id),
  claimed_at timestamptz,
  resolved_by uuid REFERENCES devices(device_id),
  resolved_hash text,
  resolved_vv jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(file_id, kind, ours_hash, theirs_hash)
);
CREATE INDEX IF NOT EXISTS conflicts_open ON conflicts(vault_id, status) WHERE status<>'resolved';

CREATE TABLE IF NOT EXISTS tokens(
  token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked bool NOT NULL DEFAULT false,
  replaced_by uuid REFERENCES tokens(token_id)
);

CREATE TABLE IF NOT EXISTS outbox(
  vault_id uuid NOT NULL,
  vault_seq bigint NOT NULL,
  payload jsonb NOT NULL,
  published bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY(vault_id, vault_seq)
);

CREATE TABLE IF NOT EXISTS audit_log(
  audit_id bigserial PRIMARY KEY,
  vault_id uuid,
  user_id uuid,
  device_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS yjs_rooms(
  file_id uuid PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE,
  vault_id uuid NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  active bool NOT NULL DEFAULT false,
  seeded bool NOT NULL DEFAULT false,
  lease_owner uuid REFERENCES devices(device_id),
  lease_until timestamptz,
  participants jsonb NOT NULL DEFAULT '[]',
  last_update_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS yjs_updates(
  file_id uuid NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  seq bigserial,
  update bytea NOT NULL,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(file_id, seq)
);

CREATE TABLE IF NOT EXISTS yjs_snapshots(
  file_id uuid PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE,
  snapshot bytea NOT NULL,
  state_vector bytea NOT NULL,
  up_to_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
