import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { digest } from './auth.js';
import { DomainError } from './network.js';
import { parseGithubUrl, safeSourcePath, type Snapshot } from './github.js';
import type { Analysis } from './model.js';
import { StorageGuard, type StorageLimits } from './storage.js';

export interface PublicDraft { title: string; summary: string; rationale: string; uncertainties: string[] }
export interface PublicSnapshot extends PublicDraft { schemaVersion: 1; repo: string; issueNumber: number; issueUrl: string; commit: string; source: 'LIVE_API' | 'FIXTURE'; sources: { path: string; url: string }[]; hasPatch: boolean; patchStatus: 'UNVERIFIED'; projectTests: 'NOT_RUN'; compilation: 'NOT_RUN' }
interface Publication { id: string; task_id: string; preview_id: string; content: string; hash: string; published_at: string; revoked_at: string | null }
interface Preview { id: string; task_id: string; content: string; hash: string; binding_hash: string; expires_at: number }
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function redactPublicText(value: string, secrets: string[] = []) {
  let output = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(secret).join('[REDACTED]');
  return output
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}|\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:api[_ -]?key|password|secret|token|authorization)\s*[:=]\s*(?:Bearer\s+)?["']?[^\s"'<>;,]+/gi, '[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[链接已省略]')
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'`]+/g, '[私有路径已省略]')
    .replace(/(^|[^A-Za-z0-9_])\/(?:home|Users|root|etc|var|opt|tmp|mnt|private|srv|workspace|workspaces|app|data)(?:\/[^\s<>"'`)]+)+/gm, '$1[私有路径已省略]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已省略]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
export class PublicationService {
  private guard: StorageGuard;
  constructor(private db: Database.Database, private env: NodeJS.ProcessEnv = process.env, limits?: StorageLimits) { this.guard = new StorageGuard(db, limits); }
  private secrets(taskId?: string) {
    const refs = new Set(['MODEL_API_KEY', 'GITHUB_TOKEN', 'ADMIN_PASSWORD_HASH']);
    const settings = (this.db.prepare('SELECT value FROM settings WHERE id = 1').get() as { value: string }).value;
    const task = taskId ? this.db.prepare('SELECT config_snapshot FROM tasks WHERE id = ?').get(taskId) as { config_snapshot: string } | undefined : undefined;
    for (const json of [settings, task?.config_snapshot]) if (json) {
      const value = JSON.parse(json); if (typeof value.modelKeyRef === 'string') refs.add(value.modelKeyRef); if (typeof value.githubTokenRef === 'string') refs.add(value.githubTokenRef);
    }
    return [...refs].map(name => this.env[name]).filter((v): v is string => Boolean(v));
  }
  private source(taskId: string) {
    const task = this.db.prepare('SELECT repo, issue_number, base_sha, snapshot, analysis, data_source, status FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) throw new DomainError('TASK_NOT_FOUND', 404);
    if (!task.analysis || !task.snapshot || !task.base_sha || ['QUEUED', 'RUNNING'].includes(task.status)) throw new DomainError('PUBLICATION_ANALYSIS_REQUIRED', 409);
    const snapshot: Snapshot = JSON.parse(task.snapshot), analysis: Analysis = JSON.parse(task.analysis);
    const target = parseGithubUrl(`https://github.com/${task.repo}/issues/${task.issue_number}`);
    if (target.repo !== task.repo || !/^[a-f0-9]{40}$/.test(task.base_sha) || snapshot.commit !== task.base_sha || snapshot.repo !== task.repo || snapshot.issue.number !== task.issue_number) throw new DomainError('PUBLICATION_SOURCE_INVALID', 409);
    const hasPatch = Boolean(this.db.prepare("SELECT 1 FROM artifacts a JOIN plans p ON p.id = a.plan_id WHERE a.task_id = ? AND a.review_status != 'REJECTED' AND p.version = (SELECT max(version) FROM plans WHERE task_id = ?)").get(taskId, taskId));
    return { task, snapshot, analysis, hasPatch, binding: digest(JSON.stringify({ repo: task.repo, issue: task.issue_number, commit: task.base_sha, snapshot: task.snapshot, analysis: task.analysis, source: task.data_source, hasPatch })) };
  }
  private validateDraft(value: PublicDraft) {
    if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['title', 'summary', 'rationale', 'uncertainties'].includes(k)) || !text(value.title, 160) || !text(value.summary, 4000) || !text(value.rationale, 4000) || !Array.isArray(value.uncertainties) || value.uncertainties.length > 20 || !value.uncertainties.every(v => text(v, 500))) throw new DomainError('INVALID_PUBLIC_DRAFT');
  }
  private projection(taskId: string, draft: PublicDraft) {
    this.validateDraft(draft);
    const source = this.source(taskId), secrets = this.secrets(taskId), clean = (value: string) => redactPublicText(value.trim(), secrets);
    const result: PublicSnapshot = { schemaVersion: 1, title: clean(draft.title), summary: clean(draft.summary), rationale: clean(draft.rationale), uncertainties: draft.uncertainties.map(clean), repo: source.task.repo, issueNumber: source.task.issue_number, issueUrl: `https://github.com/${source.task.repo}/issues/${source.task.issue_number}`, commit: source.task.base_sha,
      source: source.task.data_source === 'LIVE_API' ? 'LIVE_API' : 'FIXTURE', sources: source.snapshot.files.filter(f => typeof f.path === 'string' && /^[A-Za-z0-9_./-]{1,240}$/.test(f.path) && safeSourcePath(f.path)).slice(0, 50).map(f => ({ path: f.path, url: `https://github.com/${source.task.repo}/blob/${source.task.base_sha}/${f.path.split('/').map(encodeURIComponent).join('/')}` })), hasPatch: source.hasPatch, patchStatus: 'UNVERIFIED', compilation: 'NOT_RUN', projectTests: 'NOT_RUN' };
    if (secrets.some(secret => JSON.stringify(result).includes(secret))) throw new DomainError('PUBLICATION_SOURCE_SENSITIVE', 409);
    return { result, binding: source.binding, redacted: JSON.stringify(draft) !== JSON.stringify({ title: result.title, summary: result.summary, rationale: result.rationale, uncertainties: result.uncertainties }) };
  }
  defaults(taskId: string) {
    const { snapshot, analysis } = this.source(taskId);
    const draft = { title: snapshot.issue.title.slice(0, 160), summary: analysis.summary, rationale: analysis.rationale, uncertainties: analysis.uncertainties.map(s => s.slice(0, 500)) };
    return { draft, publication: this.current(taskId), disclosure: '只发布经预览确认的独立快照，不含 Diff、原始源码、内部 Prompt、配置或日志。Markdown 以纯文本展示。' };
  }
  preview(taskId: string, draft: PublicDraft) {
    const { result, binding, redacted } = this.projection(taskId, draft);
    const content = JSON.stringify(result); if (Buffer.byteLength(content) > 32768) throw new DomainError('PUBLICATION_TOO_LARGE');
    const id = randomUUID(), hash = digest(content), expiresAt = Date.now() + 30 * 60000;
    this.guard.writable(Buffer.byteLength(content)); this.guard.cleanup();
    this.db.prepare('INSERT INTO publication_previews(id, task_id, content, hash, binding_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET id = excluded.id, content = excluded.content, hash = excluded.hash, binding_hash = excluded.binding_hash, expires_at = excluded.expires_at').run(id, taskId, content, hash, binding, expiresAt);
    return { id, hash, expiresAt, snapshot: result, redacted, requiresConfirmation: true };
  }
  publish(taskId: string, previewId: string, hash: string, confirmed: boolean) {
    if (confirmed !== true) throw new DomainError('PUBLICATION_CONFIRMATION_REQUIRED', 409);
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM publications WHERE preview_id = ? AND task_id = ?').get(previewId, taskId) as Publication | undefined;
      if (previous) { if (previous.hash !== hash || previous.revoked_at) throw new DomainError('PUBLICATION_PREVIEW_EXPIRED', 409); return { id: previous.id, duplicate: true }; }
      const preview = this.db.prepare('SELECT * FROM publication_previews WHERE task_id = ? AND id = ?').get(taskId, previewId) as Preview | undefined;
      if (!preview || preview.expires_at <= Date.now() || preview.hash !== hash || digest(preview.content) !== hash) throw new DomainError('PUBLICATION_PREVIEW_EXPIRED', 409);
      if (this.source(taskId).binding !== preview.binding_hash) throw new DomainError('PUBLICATION_SOURCE_CHANGED', 409);
      const value: PublicSnapshot = JSON.parse(preview.content);
      const fresh = this.projection(taskId, { title: value.title, summary: value.summary, rationale: value.rationale, uncertainties: value.uncertainties }).result;
      if (JSON.stringify(fresh) !== preview.content) throw new DomainError('PUBLICATION_REDACTION_CHANGED', 409);
      if (this.current(taskId)) throw new DomainError('PUBLICATION_ALREADY_EXISTS', 409);
      this.guard.publication();
      const id = randomUUID();
      this.db.prepare('INSERT INTO publications(id, task_id, preview_id, content, hash) VALUES (?, ?, ?, ?, ?)').run(id, taskId, previewId, preview.content, hash);
      return { id, duplicate: false };
    })();
  }
  current(taskId: string) { return this.db.prepare('SELECT id, hash, published_at FROM publications WHERE task_id = ? AND revoked_at IS NULL').get(taskId) || null; }
  revoke(id: string) {
    const result = this.db.prepare('UPDATE publications SET revoked_at = coalesce(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?').run(id);
    if (!result.changes) throw new DomainError('PUBLICATION_NOT_FOUND', 404);
    return { ok: true, note: '新读取已阻止，已下载或截图的内容无法收回。' };
  }
  private readable(row: Publication) {
    try {
      if (row.revoked_at || digest(row.content) !== row.hash) return false;
      const value = JSON.parse(row.content) as PublicSnapshot;
      const keys = ['schemaVersion', 'title', 'summary', 'rationale', 'uncertainties', 'repo', 'issueNumber', 'issueUrl', 'commit', 'source', 'sources', 'hasPatch', 'patchStatus', 'projectTests', 'compilation'];
      if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)) || value.schemaVersion !== 1 || !['LIVE_API', 'FIXTURE'].includes(value.source) || value.patchStatus !== 'UNVERIFIED' || value.compilation !== 'NOT_RUN' || value.projectTests !== 'NOT_RUN' || typeof value.hasPatch !== 'boolean' || !/^[a-f0-9]{40}$/.test(value.commit) || !Number.isSafeInteger(value.issueNumber)) return false;
      this.validateDraft({ title: value.title, summary: value.summary, rationale: value.rationale, uncertainties: value.uncertainties });
      const issueUrl = `https://github.com/${value.repo}/issues/${value.issueNumber}`;
      if (value.issueUrl !== issueUrl || parseGithubUrl(issueUrl).repo !== value.repo || !Array.isArray(value.sources) || value.sources.length > 50) return false;
      if (!value.sources.every(s => s && Object.keys(s).length === 2 && typeof s.path === 'string' && /^[A-Za-z0-9_./-]{1,240}$/.test(s.path) && safeSourcePath(s.path) && s.url === `https://github.com/${value.repo}/blob/${value.commit}/${s.path.split('/').map(encodeURIComponent).join('/')}`)) return false;
      const secrets = this.secrets(row.task_id), fields = [value.title, value.summary, value.rationale, ...value.uncertainties];
      return fields.every(field => redactPublicText(field, secrets) === field) && !secrets.some(secret => row.content.includes(secret));
    } catch { return false; }
  }
  list(page = 1) {
    const rows = this.db.prepare('SELECT * FROM publications WHERE revoked_at IS NULL ORDER BY published_at DESC, rowid DESC LIMIT 12 OFFSET ?').all((page - 1) * 12) as Publication[];
    return { page, pageSize: 12, hasMore: rows.length === 12, items: rows.filter(row => this.readable(row)).map(row => { const value: PublicSnapshot = JSON.parse(row.content); return { id: row.id, title: value.title, summary: value.summary.slice(0, 240), repo: value.repo, source: value.source, hasPatch: value.hasPatch, publishedAt: row.published_at }; }) };
  }
  read(id: string) {
    const row = this.db.prepare('SELECT * FROM publications WHERE id = ? AND revoked_at IS NULL').get(id) as Publication | undefined;
    if (!row || !this.readable(row)) throw new DomainError('PUBLICATION_NOT_FOUND', 404);
    return { id: row.id, hash: row.hash, publishedAt: row.published_at, snapshot: JSON.parse(row.content) as PublicSnapshot };
  }
}
