CREATE TABLE publication_previews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  content TEXT NOT NULL CHECK (json_valid(content)),
  hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  preview_id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL CHECK (json_valid(content)),
  hash TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);
CREATE UNIQUE INDEX publications_active_task ON publications(task_id) WHERE revoked_at IS NULL;
CREATE INDEX publications_published ON publications(published_at DESC);
