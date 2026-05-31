ALTER TABLE conflicts
  DROP CONSTRAINT IF EXISTS conflicts_file_id_kind_ours_hash_theirs_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS conflicts_open_dedupe
  ON conflicts(file_id, kind, COALESCE(ours_hash, ''), COALESCE(theirs_hash, ''))
  WHERE status <> 'resolved';
