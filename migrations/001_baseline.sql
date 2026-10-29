CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  base_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','WAITING_CONFIRMATION','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  current_step TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  config_snapshot TEXT NOT NULL CHECK (json_valid(config_snapshot)),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX tasks_created ON tasks(created_at DESC);
