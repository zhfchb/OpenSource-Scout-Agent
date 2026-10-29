ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN settings_revision INTEGER;
ALTER TABLE tasks ADD COLUMN error_request_id TEXT;
CREATE TABLE model_tests (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, settings_revision INTEGER NOT NULL,
 model TEXT NOT NULL, model_key_ref TEXT NOT NULL, github_token_ref TEXT NOT NULL,
 boot_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')),
 error_code TEXT, request_id TEXT NOT NULL, reserved_day TEXT NOT NULL, reserved_tokens INTEGER NOT NULL,
 actual_tokens INTEGER, usage_state TEXT NOT NULL DEFAULT 'RESERVED' CHECK(usage_state IN ('RESERVED','KNOWN','UNKNOWN')),
 started_at INTEGER NOT NULL, finished_at INTEGER, data_source TEXT NOT NULL
);
CREATE UNIQUE INDEX model_tests_running ON model_tests(status) WHERE status='RUNNING';
CREATE INDEX model_tests_day ON model_tests(reserved_day);
CREATE TABLE model_test_guard(id INTEGER PRIMARY KEY CHECK(id=1), blocked_until_utc INTEGER NOT NULL DEFAULT 0);
INSERT INTO model_test_guard(id) VALUES(1);
