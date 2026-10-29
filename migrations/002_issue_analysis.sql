ALTER TABLE tasks ADD COLUMN request_key TEXT;
ALTER TABLE tasks ADD COLUMN snapshot TEXT CHECK (snapshot IS NULL OR json_valid(snapshot));
ALTER TABLE tasks ADD COLUMN analysis TEXT CHECK (analysis IS NULL OR json_valid(analysis));
CREATE UNIQUE INDEX tasks_request_key ON tasks(request_key) WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX tasks_active_issue ON tasks(repo, issue_number) WHERE status IN ('QUEUED','RUNNING');
CREATE TABLE task_steps (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  actual_tokens INTEGER,
  state TEXT NOT NULL CHECK (state IN ('RESERVED','KNOWN','UNKNOWN')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
