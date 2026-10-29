import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileHash, inspectBackup } from './backup-integrity.js';
const directory = resolve(process.argv[2] || 'data/backups');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = new Database(resolve(process.env.DB_PATH || 'data/scout.sqlite'), { readonly: true, fileMustExist: true });
try {
  const path = resolve(directory, `scout-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);
  await db.backup(path); chmodSync(path, 0o600);
  const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), databaseSha256: await fileHash(path), ...inspectBackup(path) };
  writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('Backup and SHA-256 manifest created; keep both private.');
}
finally { db.close(); }
