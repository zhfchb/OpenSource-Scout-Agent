import { openDatabase } from './db.js';
import { constants, copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { verifyBackup } from './backup-integrity.js';
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: npm run restore -- <backup.sqlite> <new-target.sqlite>');
const source = resolve(process.argv[2]), target = resolve(process.argv[3]);
if ([target, `${target}-wal`, `${target}-shm`].some(existsSync) || source === target) throw new Error('RESTORE_REQUIRES_NEW_TARGET');
await verifyBackup(source);
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
copyFileSync(source, target, constants.COPYFILE_EXCL); chmodSync(target, 0o600);
const db = openDatabase(target);
try {
  db.transaction(() => {
    const nextUtcDay = (Math.floor(Date.now()/86400000)+1)*86400000;
    db.prepare('UPDATE model_test_guard SET blocked_until_utc=max(blocked_until_utc,?) WHERE id=1').run(nextUtcDay);
    db.prepare("UPDATE discovery_control SET enabled=0,evaluation_enabled=0,next_due_at=NULL,schedule_revision=schedule_revision+1,last_schedule_reason='RESTORE_DISABLED' WHERE id=1").run();
    db.prepare('DELETE FROM sessions').run();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'publication_previews'").get()) db.prepare('DELETE FROM publication_previews').run();
    // Old backups must never silently resurrect reports revoked after the backup.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'publications'").get()) db.prepare('UPDATE publications SET revoked_at = coalesce(revoked_at, CURRENT_TIMESTAMP)').run();
    db.prepare("UPDATE tasks SET status = 'INTERRUPTED' WHERE status IN ('QUEUED','RUNNING')").run();
    db.prepare("UPDATE usage SET state = 'UNKNOWN' WHERE state = 'RESERVED'").run();
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
} finally { db.close(); }
console.log('Restored into a NEW migrated database; sessions/previews cleared, publications revoked, unfinished work interrupted. Model probes blocked until next UTC day; provider billing remains authoritative. Stop the service before selecting this database; re-preview before publishing again.');
