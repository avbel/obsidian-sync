export const currentSchemaVersion = 1;

const initialSchema = `
CREATE TABLE vault (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner      TEXT NOT NULL,
  kdf_salt   BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE device (
  id            TEXT NOT NULL,
  vault_id      TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  platform      TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, id)
);

CREATE TABLE file (
  vault_id     TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL,
  head_version TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0,
  updated_seq  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, file_id)
);
CREATE INDEX file_vault_updated ON file (vault_id, updated_seq);

CREATE TABLE version (
  vault_id       TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  file_id        TEXT NOT NULL,
  version_id     TEXT NOT NULL,
  parent_version TEXT,
  meta_blob      TEXT NOT NULL,
  chunks         TEXT NOT NULL,
  size           INTEGER NOT NULL,
  device_id      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (vault_id, file_id, version_id)
);
CREATE INDEX version_file_created ON version (vault_id, file_id, created_at);

CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id   TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,
  version_id TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX change_log_vault_seq ON change_log (vault_id, seq);

CREATE TABLE blob_ref (
  vault_id TEXT NOT NULL REFERENCES vault(id) ON DELETE CASCADE,
  addr     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  refcount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, addr)
);
CREATE INDEX blob_ref_reclaimable ON blob_ref (vault_id, refcount);
`;

/** Index N holds the migration that raises the schema from version N to N+1. */
export const migrations: readonly string[] = [initialSchema];
