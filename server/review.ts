import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { digest } from './auth.js';
import { DomainError } from './network.js';
import { canonicalPlan, type PlanInput, type PlanContent } from './patch.js';
import type { Snapshot } from './github.js';

export interface PlanRow { id: string; task_id: string; version: number; content: string; hash: string; confirmed_at: string | null; requested_at: string | null }
export interface ArtifactRow { id: string; task_id: string; plan_id: string; content: string; hash: string; bytes: number; review_status: string }
interface ReviewTask { id: string; status: string; phase: string; analysis: string | null; snapshot: string | null; base_sha: string | null }
export class ReviewService {
  constructor(private db: Database.Database) {}
  private task(id: string) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as ReviewTask | undefined;
    if (!task) throw new DomainError('TASK_NOT_FOUND', 404);
    return task;
  }
  latest(id: string) { return this.db.prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(id) as PlanRow | undefined; }
  checkBinding(taskId: string, plan: PlanRow) {
    const task = this.task(taskId), content = JSON.parse(plan.content) as PlanContent;
    if (plan.task_id !== taskId || digest(plan.content) !== plan.hash || !task.snapshot || !task.analysis || content.baseSha !== task.base_sha || content.baseSha !== (JSON.parse(task.snapshot) as Snapshot).commit || content.snapshotHash !== digest(task.snapshot) || content.analysisHash !== digest(task.analysis)) throw new DomainError('PLAN_SOURCE_CHANGED_REANALYZE', 409);
    return content;
  }
  save(taskId: string, input: PlanInput, expectedVersion: number, baseSha: string) {
    return this.db.transaction(() => {
      const task = this.task(taskId);
      if (!task.analysis || !task.snapshot || ['QUEUED', 'RUNNING'].includes(task.status)) throw new DomainError('PLAN_NOT_EDITABLE', 409);
      const latest = this.latest(taskId);
      if ((latest?.version || 0) !== expectedVersion || task.base_sha !== baseSha) throw new DomainError('PLAN_VERSION_CONFLICT', 409);
      const snapshot = JSON.parse(task.snapshot) as Snapshot;
      if (snapshot.commit !== task.base_sha) throw new DomainError('PLAN_SOURCE_CHANGED_REANALYZE', 409);
      const content = canonicalPlan(input, taskId, expectedVersion + 1, snapshot, JSON.parse(task.analysis));
      const json = JSON.stringify(content), id = randomUUID();
      this.db.prepare('INSERT INTO plans(id, task_id, version, content, hash) VALUES (?, ?, ?, ?, ?)').run(id, taskId, content.version, json, digest(json));
      this.db.prepare("UPDATE tasks SET phase = 'PATCH', status = 'WAITING_CONFIRMATION', attempt = attempt + 1, error_code = NULL, current_step = 'plan', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
      return this.view(taskId).plan!;
    })();
  }
  match(taskId: string, planId: string, hash: string, baseSha: string) {
    const plan = this.latest(taskId);
    if (!plan || plan.id !== planId || plan.hash !== hash) throw new DomainError('PLAN_VERSION_CONFLICT', 409);
    const content = this.checkBinding(taskId, plan);
    if (content.baseSha !== baseSha) throw new DomainError('PLAN_COMMIT_CONFLICT', 409);
    return plan;
  }
  confirm(taskId: string, planId: string, hash: string, baseSha: string) {
    return this.db.transaction(() => {
      const plan = this.match(taskId, planId, hash, baseSha);
      if (this.task(taskId).status !== 'WAITING_CONFIRMATION' || plan.requested_at) throw new DomainError('PLAN_NOT_CONFIRMABLE', 409);
      this.db.prepare('UPDATE plans SET confirmed_at = coalesce(confirmed_at, CURRENT_TIMESTAMP) WHERE id = ?').run(plan.id);
      return this.view(taskId).plan!;
    })();
  }
  view(taskId: string) {
    const plan = this.latest(taskId);
    const artifact = plan ? this.db.prepare('SELECT * FROM artifacts WHERE plan_id = ?').get(plan.id) as ArtifactRow | undefined : undefined;
    let valid = true;
    if (plan) { try { this.checkBinding(taskId, plan); } catch { valid = false; } }
    return { plan: plan ? { id: plan.id, version: plan.version, hash: plan.hash, content: JSON.parse(plan.content) as PlanContent, confirmedAt: plan.confirmed_at, requestedAt: plan.requested_at, bindingValid: valid } : null,
      artifact: artifact ? { id: artifact.id, hash: artifact.hash, bytes: artifact.bytes, reviewStatus: artifact.review_status, bundle: JSON.parse(artifact.content), bindingValid: valid } : null,
      manualPr: this.db.prepare('SELECT url, status, source, updated_at FROM manual_pr_records WHERE task_id = ?').get(taskId) || null };
  }
  artifact(taskId: string, artifactId: string) {
    const artifact = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? AND id = ?').get(taskId, artifactId) as ArtifactRow | undefined;
    const plan = this.latest(taskId);
    if (!artifact || !plan || plan.id !== artifact.plan_id) throw new DomainError('ARTIFACT_NOT_CURRENT', 409);
    this.checkBinding(taskId, plan);
    if (digest(artifact.content) !== artifact.hash || Buffer.byteLength(artifact.content) !== artifact.bytes) throw new DomainError('ARTIFACT_INTEGRITY_FAILED', 409);
    return artifact;
  }
  review(taskId: string, artifactId: string, hash: string, status: 'REVIEWED' | 'REJECTED') {
    const artifact = this.artifact(taskId, artifactId);
    if (hash !== artifact.hash) throw new DomainError('ARTIFACT_VERSION_CONFLICT', 409);
    this.db.prepare('UPDATE artifacts SET review_status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, artifactId);
    return { ok: true, patchStatus: 'UNVERIFIED', projectTests: 'NOT_RUN' };
  }
  download(taskId: string, artifactId: string, format: 'bundle' | 'diff' | 'pr') {
    const artifact = this.artifact(taskId, artifactId);
    if (artifact.review_status === 'REJECTED') throw new DomainError('ARTIFACT_REJECTED', 409);
    const bundle = JSON.parse(artifact.content);
    return { content: format === 'bundle' ? artifact.content : format === 'diff' ? bundle.patch.diff : bundle.prDraft,
      filename: `scout-UNVERIFIED-${artifact.id}.${format === 'bundle' ? 'json' : format === 'diff' ? 'patch' : 'md'}`, type: format === 'bundle' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' };
  }
  recordPr(taskId: string, url: string, status: string) {
    const task = this.task(taskId);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new DomainError('INVALID_PR_URL'); }
    const repo = (this.db.prepare('SELECT repo FROM tasks WHERE id = ?').get(task.id) as { repo: string }).repo;
    if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !new RegExp(`^/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[1-9]\\d*/?$`, 'i').test(parsed.pathname)) throw new DomainError('INVALID_PR_URL');
    this.db.prepare("INSERT INTO manual_pr_records(task_id, url, status) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET url = excluded.url, status = excluded.status, source = 'MANUAL', updated_at = CURRENT_TIMESTAMP").run(taskId, parsed.href, status);
    return { ok: true, source: 'MANUAL', remoteVerified: false };
  }
}
