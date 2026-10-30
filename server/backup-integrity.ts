import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { digest } from './auth.js';
export async function fileHash(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export function inspectBackup(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('BACKUP_DATABASE_INVALID');
    for (const table of ['artifacts', 'plans', 'publications', 'publication_previews']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      for (const row of db.prepare(`SELECT content, hash${table === 'artifacts' ? ', bytes' : ''} FROM ${table}`).iterate() as Iterable<{ content: string; hash: string; bytes?: number }>) {
        if (digest(row.content) !== row.hash || (row.bytes !== undefined && row.bytes !== Buffer.byteLength(row.content))) throw new Error('BACKUP_CONTENT_HASH_INVALID');
      }
    }
    const tables: Record<string, { rows: number; sha256: string }> = {};
    // Fixed allowlist; iterate to avoid loading all artifacts into memory.
    for (const table of ['schema_migrations', 'settings', 'sessions', 'tasks', 'task_steps', 'usage', 'plans', 'artifacts', 'manual_pr_records', 'publication_previews', 'publications', 'model_tests', 'model_test_guard']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      const hash = createHash('sha256'); let rows = 0;
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) { hash.update(JSON.stringify(row) + '\n'); rows++; }
      tables[table] = { rows, sha256: hash.digest('hex') };
    }
    return { integrity: 'ok', tables };
  } finally { db.close(); }
}
export async function verifyBackup(path: string) {
  const manifest = JSON.parse(readFileSync(`${path}.manifest.json`, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.databaseSha256 !== await fileHash(path)) throw new Error('BACKUP_FILE_HASH_INVALID');
  const actual = inspectBackup(path);
  if (JSON.stringify(actual.tables) !== JSON.stringify(manifest.tables)) throw new Error('BACKUP_TABLE_HASH_INVALID');
  return { ...actual, databaseSha256: manifest.databaseSha256 };
}
