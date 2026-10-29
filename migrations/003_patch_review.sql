ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'ANALYSIS' CHECK (phase IN ('ANALYSIS','PATCH'));
ALTER TABLE tasks ADD COLUMN data_source TEXT NOT NULL DEFAULT 'LIVE_API' CHECK (data_source IN ('LIVE_API','FIXTURE'));
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  hash TEXT NOT NULL,
  confirmed_at TEXT,
  requested_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, version)
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id),
  content TEXT NOT NULL CHECK (json_valid(content)),
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','REVIEWED','REJECTED')),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE manual_pr_records (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','OPEN','MERGED','CLOSED')),
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source = 'MANUAL'),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
