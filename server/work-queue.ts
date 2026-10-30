import type Database from 'better-sqlite3';
import { DomainError } from './network.js';
import { executionSlot } from './execution-slot.js';
export function queueCount(db: Database.Database) { return (db.prepare("SELECT count(*) AS n FROM execution_queue WHERE state='QUEUED'").get() as {
    n: number;
}).n; }
export function enqueue(db: Database.Database, kind: string, id: string, attempt = 0, now = Date.now()) {
    if (db.prepare('SELECT 1 FROM execution_queue WHERE kind=? AND entity_id=? AND attempt=?').get(kind, id, attempt))
        return;
    if (queueCount(db) >= 10)
        throw new DomainError('QUEUE_LIMIT_REACHED', 409);
    db.prepare('INSERT INTO execution_queue(kind,entity_id,attempt,created_at) VALUES(?,?,?,?)').run(kind, id, attempt, now);
    executionSlot(db).wake();
}
export function queueHead(db: Database.Database) { return db.prepare("SELECT * FROM execution_queue WHERE state='QUEUED' ORDER BY seq LIMIT 1").get() as {
    seq: number;
    kind: string;
    entity_id: string;
    attempt: number;
} | undefined; }
export function finishWork(db: Database.Database, kind: string, id: string, attempt: number) { db.prepare("UPDATE execution_queue SET state='FINISHED' WHERE kind=? AND entity_id=? AND attempt=?").run(kind, id, attempt); }
export function cancelQueued(db: Database.Database, kind: string, id: string) { db.prepare("UPDATE execution_queue SET state='CANCELLED' WHERE kind=? AND entity_id=? AND state='QUEUED'").run(kind, id); executionSlot(db).wake(); }
