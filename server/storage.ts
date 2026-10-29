import type Database from 'better-sqlite3';
import { DomainError } from './network.js';
export interface StorageLimits { maxDatabaseBytes: number; maxArtifactTotalBytes: number; maxTasks: number; maxPlansPerTask: number; maxPublications: number }
export function loadStorageLimits(env: NodeJS.ProcessEnv = process.env): StorageLimits {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  return { maxDatabaseBytes: integer('MAX_DATABASE_BYTES', 512 * 1024 * 1024, 1024 * 1024, 4 * 1024 ** 3), maxArtifactTotalBytes: integer('MAX_ARTIFACT_TOTAL_BYTES', 64 * 1024 * 1024, 1024, 1024 ** 3), maxTasks: integer('MAX_TASKS', 1000, 1, 10000), maxPlansPerTask: integer('MAX_PLANS_PER_TASK', 20, 1, 100), maxPublications: integer('MAX_PUBLICATIONS', 1000, 1, 10000) };
}
export class StorageGuard {
  constructor(private db: Database.Database, readonly limits: StorageLimits = loadStorageLimits()) {}
  usage() {
    return { databaseAllocatedBytes: Number(this.db.pragma('page_count', { simple: true })) * Number(this.db.pragma('page_size', { simple: true })), artifactBytes: (this.db.prepare('SELECT coalesce(sum(bytes), 0) AS n FROM artifacts').get() as { n: number }).n, tasks: (this.db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, publications: (this.db.prepare('SELECT count(*) AS n FROM publications').get() as { n: number }).n, limits: this.limits, cache: 'NO_SOURCE_DISK_CACHE' };
  }
  writable(bytes = 0) {
    const used = Number(this.db.pragma('page_count', { simple: true })) * Number(this.db.pragma('page_size', { simple: true }));
    // Reserve headroom for sessions, revocation and operator cleanup.
    if (used + bytes >= this.limits.maxDatabaseBytes - Math.min(1024 * 1024, this.limits.maxDatabaseBytes / 10)) throw new DomainError('DATABASE_QUOTA_REACHED', 409);
  }
  task() { this.writable(); if ((this.db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n >= this.limits.maxTasks) throw new DomainError('TASK_STORAGE_LIMIT', 409); }
  plan(taskId: string) { this.writable(); if ((this.db.prepare('SELECT count(*) AS n FROM plans WHERE task_id = ?').get(taskId) as { n: number }).n >= this.limits.maxPlansPerTask) throw new DomainError('PLAN_STORAGE_LIMIT', 409); }
  artifact(bytes: number) { this.writable(bytes); if ((this.db.prepare('SELECT coalesce(sum(bytes), 0) AS n FROM artifacts').get() as { n: number }).n + bytes > this.limits.maxArtifactTotalBytes) throw new DomainError('ARTIFACT_STORAGE_LIMIT', 409); }
  publication() { this.writable(32768); if ((this.db.prepare('SELECT count(*) AS n FROM publications').get() as { n: number }).n >= this.limits.maxPublications) throw new DomainError('PUBLICATION_STORAGE_LIMIT', 409); }
  cleanup() {
    return this.db.transaction(() => ({ expiredSessions: this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes, expiredPreviews: this.db.prepare('DELETE FROM publication_previews WHERE expires_at <= ?').run(Date.now()).changes }))();
  }
}
