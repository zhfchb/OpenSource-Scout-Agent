import Database from 'better-sqlite3';
import { constants, copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { verifyBackup } from './backup-integrity.js';
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: npm run restore -- <backup.sqlite> <new-target.sqlite>');
const source = resolve(process.argv[2]), target = resolve(process.argv[3]);
if ([target, `${target}-wal`, `${target}-shm`].some(existsSync) || source === target) throw new Error('RESTORE_REQUIRES_NEW_TARGET');
await verifyBackup(source);
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
copyFileSync(source, target, constants.COPYFILE_EXCL); chmodSync(target, 0o600);
const db = new Database(target, { fileMustExist: true });
try {
  db.transaction(() => {
    db.prepare('DELETE FROM sessions').run();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'publication_previews'").get()) db.prepare('DELETE FROM publication_previews').run();
    db.prepare("UPDATE tasks SET status = 'INTERRUPTED' WHERE status IN ('QUEUED','RUNNING')").run();
    db.prepare("UPDATE usage SET state = 'UNKNOWN' WHERE state = 'RESERVED'").run();
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
} finally { db.close(); }
console.log('Restored into a NEW database; sessions and previews cleared, unfinished tasks interrupted. Stop the service before selecting this database.');
