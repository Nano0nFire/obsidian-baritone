ALTER TABLE file_ops DROP CONSTRAINT IF EXISTS file_ops_device_id_fkey;
ALTER TABLE file_ops ALTER COLUMN device_id TYPE text USING device_id::text;

ALTER TABLE yjs_rooms ADD COLUMN IF NOT EXISTS room_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE yjs_rooms ADD COLUMN IF NOT EXISTS activation_base_vv jsonb NOT NULL DEFAULT '{}';
ALTER TABLE yjs_rooms ADD COLUMN IF NOT EXISTS activation_base_hash text;
ALTER TABLE yjs_rooms ADD COLUMN IF NOT EXISTS next_seq bigint NOT NULL DEFAULT 1;
ALTER TABLE yjs_rooms ALTER COLUMN lease_owner TYPE text USING lease_owner::text;
ALTER TABLE yjs_rooms DROP COLUMN IF EXISTS participants;

ALTER TABLE yjs_updates DROP CONSTRAINT IF EXISTS yjs_updates_pkey;
ALTER TABLE yjs_updates ADD COLUMN IF NOT EXISTS vault_id uuid REFERENCES vaults(vault_id) ON DELETE CASCADE;
UPDATE yjs_updates u SET vault_id = r.vault_id FROM yjs_rooms r WHERE u.file_id = r.file_id AND u.vault_id IS NULL;
UPDATE yjs_updates u SET vault_id = f.vault_id FROM files f WHERE u.file_id = f.file_id AND u.vault_id IS NULL;
DELETE FROM yjs_updates WHERE vault_id IS NULL;
ALTER TABLE yjs_updates ALTER COLUMN vault_id SET NOT NULL;
ALTER TABLE yjs_updates ADD COLUMN IF NOT EXISTS room_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE yjs_updates ALTER COLUMN seq DROP DEFAULT;
ALTER TABLE yjs_updates ALTER COLUMN device_id TYPE text USING device_id::text;
UPDATE yjs_updates SET device_id = 'unknown' WHERE device_id IS NULL;
ALTER TABLE yjs_updates ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE yjs_updates ADD PRIMARY KEY(file_id, room_epoch, seq);

ALTER TABLE yjs_snapshots DROP CONSTRAINT IF EXISTS yjs_snapshots_pkey;
ALTER TABLE yjs_snapshots ADD COLUMN IF NOT EXISTS vault_id uuid REFERENCES vaults(vault_id) ON DELETE CASCADE;
UPDATE yjs_snapshots s SET vault_id = r.vault_id FROM yjs_rooms r WHERE s.file_id = r.file_id AND s.vault_id IS NULL;
UPDATE yjs_snapshots s SET vault_id = f.vault_id FROM files f WHERE s.file_id = f.file_id AND s.vault_id IS NULL;
DELETE FROM yjs_snapshots WHERE vault_id IS NULL;
ALTER TABLE yjs_snapshots ALTER COLUMN vault_id SET NOT NULL;
ALTER TABLE yjs_snapshots ADD COLUMN IF NOT EXISTS room_epoch bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='yjs_snapshots' AND column_name='up_to_seq')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='yjs_snapshots' AND column_name='compacted_through_seq') THEN
    ALTER TABLE yjs_snapshots RENAME COLUMN up_to_seq TO compacted_through_seq;
  END IF;
END $$;
ALTER TABLE yjs_snapshots ADD COLUMN IF NOT EXISTS compacted_through_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE yjs_snapshots ADD PRIMARY KEY(file_id, room_epoch);
