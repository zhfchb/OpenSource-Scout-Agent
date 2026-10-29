import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { defaults } from './config.js';

export function openDatabase(path: string, recover = true) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const root = new URL('../../migrations/', import.meta.url);
    // Source and compiled modules have different depth.
    const migrationDir = process.env.SCOUT_MIGRATIONS_DIR || new URL('../migrations/', import.meta.url);
    let files: string[];
    let directory: URL | string = migrationDir;
    try { files = readdirSync(directory); } catch { directory = root; files = readdirSync(directory); }
    db.transaction(() => {
      for (const file of files.filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
        const sql = readFileSync(typeof directory === 'string' ? `${directory}/${file}` : new URL(file, directory), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const applied = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(file) as { checksum: string } | undefined;
        if (applied && applied.checksum !== checksum) throw new Error('Applied migration checksum mismatch');
        if (!applied) { db.exec(sql); db.prepare('INSERT INTO schema_migrations(version, checksum) VALUES (?, ?)').run(file, checksum); }
      }
      db.prepare('INSERT OR IGNORE INTO settings(id, value) VALUES (1, ?)').run(JSON.stringify(defaults));
      if (recover) db.prepare("UPDATE tasks SET status = 'INTERRUPTED', updated_at = CURRENT_TIMESTAMP WHERE status = 'RUNNING'").run();
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    })();
    return db;
  } catch (error) { db.close(); throw error; }
}
