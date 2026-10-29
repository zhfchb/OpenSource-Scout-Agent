import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { defaults, assertSettings } from './config.js';
import { GithubClient, parseGithubUrl, type Settings, type Snapshot } from './github.js';
import { ModelClient, prepareContext, type Analysis } from './model.js';
import { DomainError } from './network.js';

interface Task { id: string; repo: string; issue_number: number; status: string; attempt: number; config_snapshot: string; snapshot: string | null; request_key: string | null }
export type TaskDependencies = { github?: GithubClient; model?: ModelClient; source?: 'LIVE_API' | 'FIXTURE' };
export class TaskService {
  private github: GithubClient; private model: ModelClient;
  private running?: { id: string; controller: AbortController };
  private pumping?: Promise<void>;
  private closed = false;
  constructor(private db: Database.Database, private deps: TaskDependencies = {}) { this.github = deps.github || new GithubClient(); this.model = deps.model || new ModelClient(); }
  settings(): Settings { return { ...defaults, ...JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id = 1').get() as { value: string }).value) }; }
  ready() { return this.model.available(this.settings()); }
  async issues(url: string) { return this.github.listIssues(url, this.settings(), new AbortController().signal); }
  list() { return this.db.prepare('SELECT id, repo, issue_number, base_sha, status, current_step, attempt, error_code, created_at, updated_at FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT 50').all(); }
  detail(id: string) {
    const task = this.get(id);
    const { config_snapshot: _private, request_key: _key, snapshot, ...rest } = task;
    const data = snapshot ? JSON.parse(snapshot) as Snapshot : null;
    return { ...rest, snapshot: data ? { ...data, files: data.files.map(({ content: _content, ...f }) => f) } : null,
      analysis: JSON.parse((this.db.prepare('SELECT analysis FROM tasks WHERE id = ?').get(id) as { analysis: string | null }).analysis || 'null'),
      steps: this.db.prepare('SELECT attempt, step, status, summary, created_at FROM task_steps WHERE task_id = ? ORDER BY id').all(id),
      usage: this.db.prepare('SELECT attempt, reserved_tokens, actual_tokens, state FROM usage WHERE task_id = ? ORDER BY id').all(id), projectTests: 'NOT_RUN', source: this.deps.source || 'LIVE_API' };
  }
  private get(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!row) throw new DomainError('TASK_NOT_FOUND', 404);
    return row;
  }
  create(url: string, key: string) {
    const target = parseGithubUrl(url);
    if (!target.issue) throw new DomainError('SELECT_ISSUE_FIRST');
    const existing = this.db.prepare('SELECT id, repo, issue_number FROM tasks WHERE request_key = ?').get(key) as { id: string; repo: string; issue_number: number } | undefined;
    if (existing) { if (existing.repo !== target.repo || existing.issue_number !== target.issue) throw new DomainError('IDEMPOTENCY_KEY_CONFLICT', 409); return { id: existing.id, duplicate: true }; }
    const active = this.db.prepare("SELECT id FROM tasks WHERE repo = ? AND issue_number = ? AND status IN ('QUEUED','RUNNING')").get(target.repo, target.issue) as { id: string } | undefined;
    if (active) return { id: active.id, duplicate: true };
    const settings = this.settings();
    try { assertSettings(settings); } catch { throw new DomainError('INVALID_SETTINGS'); }
    if (!this.model.available(settings)) throw new DomainError('MODEL_NOT_CONFIGURED');
    if ((this.db.prepare("SELECT count(*) AS n FROM tasks WHERE status = 'QUEUED'").get() as { n: number }).n >= 10) throw new DomainError('QUEUE_LIMIT_REACHED', 409);
    const id = randomUUID();
    this.db.prepare("INSERT INTO tasks(id, repo, issue_number, status, config_snapshot, request_key) VALUES (?, ?, ?, 'QUEUED', ?, ?)").run(id, target.repo, target.issue, JSON.stringify(settings), key);
    this.kick(); return { id, duplicate: false };
  }
  cancel(id: string) {
    const task = this.get(id);
    if (!['QUEUED', 'RUNNING'].includes(task.status)) throw new DomainError('TASK_NOT_ACTIVE', 409);
    this.db.prepare("UPDATE tasks SET status = 'CANCELLED', attempt = attempt + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('QUEUED','RUNNING')").run(id);
    if (this.running?.id === id) this.running.controller.abort();
    return { ok: true };
  }
  retry(id: string, expectedAttempt: number) {
    const task = this.get(id);
    if (task.attempt !== expectedAttempt || !['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)) throw new DomainError('RETRY_CONFLICT', 409);
    if (this.db.prepare("SELECT 1 FROM tasks WHERE repo = ? AND issue_number = ? AND id != ? AND status IN ('QUEUED','RUNNING')").get(task.repo, task.issue_number, id)) throw new DomainError('TASK_ALREADY_ACTIVE', 409);
    if ((this.db.prepare("SELECT count(*) AS n FROM tasks WHERE status = 'QUEUED'").get() as { n: number }).n >= 10) throw new DomainError('QUEUE_LIMIT_REACHED', 409);
    try { assertSettings(JSON.parse(task.config_snapshot)); } catch { throw new DomainError('INVALID_SETTINGS'); }
    if (!this.model.available(JSON.parse(task.config_snapshot))) throw new DomainError('MODEL_NOT_CONFIGURED');
    this.db.prepare("UPDATE tasks SET status = 'QUEUED', attempt = attempt + 1, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ?").run(id, expectedAttempt);
    this.kick(); return { ok: true };
  }
  private live(task: Task) { return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'RUNNING' AND attempt = ?").get(task.id, task.attempt)); }
  private step(task: Task, name: string, summary: string) {
    this.db.prepare('INSERT INTO task_steps(task_id, attempt, step, status, summary) VALUES (?, ?, ?, ?, ?)').run(task.id, task.attempt, name, 'COMPLETED', summary);
    this.db.prepare('UPDATE tasks SET current_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ?').run(name, task.id, task.attempt);
  }
  private kick() {
    if (this.pumping || this.closed) return;
    this.pumping = Promise.resolve().then(() => this.pump()).finally(() => { this.pumping = undefined; });
  }
  async idle() { await this.pumping; }
  private async pump() {
    while (!this.closed) {
      const task = this.db.prepare("SELECT * FROM tasks WHERE status = 'QUEUED' ORDER BY created_at, rowid LIMIT 1").get() as Task | undefined;
      if (!task) break;
      const claim = this.db.prepare("UPDATE tasks SET status = 'RUNNING', current_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'QUEUED'").run(task.snapshot ? 'analysis' : 'source', task.id);
      if (!claim.changes) continue;
      const controller = new AbortController(); this.running = { id: task.id, controller };
      try { await this.run(task, controller.signal); }
      catch (error) {
        if (this.live(task)) {
          const code = error instanceof DomainError ? error.code : controller.signal.aborted ? 'REQUEST_ABORTED' : 'STEP_REQUEST_FAILED';
          this.db.prepare("UPDATE tasks SET status = 'FAILED', error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ? AND status = 'RUNNING'").run(code, task.id, task.attempt);
          const step = (this.db.prepare('SELECT current_step FROM tasks WHERE id = ?').get(task.id) as { current_step: string }).current_step;
          this.db.prepare("INSERT INTO task_steps(task_id, attempt, step, status, summary) VALUES (?, ?, ?, 'FAILED', ?)").run(task.id, task.attempt, step, code);
        }
      } finally { this.running = undefined; }
    }
  }
  private async run(task: Task, signal: AbortSignal) {
    const settings: Settings = JSON.parse(task.config_snapshot);
    // Snapshots are immutable across manual retry; no network inside a SQLite transaction.
    let context: Snapshot;
    if (task.snapshot) context = JSON.parse(task.snapshot);
    else {
      const snapshot = await this.github.snapshot({ repo: task.repo, issue: task.issue_number }, settings, signal);
      if (!this.live(task)) return;
      context = prepareContext(snapshot, settings).context;
      const value = JSON.stringify(context);
      if (Buffer.byteLength(value) > settings.maxArtifactBytes) throw new DomainError('SNAPSHOT_LIMIT_EXCEEDED');
      this.db.transaction(() => {
        this.db.prepare('UPDATE tasks SET snapshot = ?, base_sha = ? WHERE id = ? AND attempt = ?').run(value, context.commit, task.id, task.attempt);
        this.step(task, 'source', `固定 Commit，保存 ${context.files.length} 个文件；包含 ${context.gaps.length} 条数据缺口。`);
      })();
    }
    if (!this.live(task)) return;
    this.db.prepare("UPDATE tasks SET current_step = 'analysis' WHERE id = ? AND attempt = ?").run(task.id, task.attempt);
    const reserved = prepareContext(context, settings).reservedTokens;
    const usageId = this.db.transaction(() => {
      const used = this.db.prepare('SELECT count(*) AS calls, coalesce(sum(coalesce(actual_tokens, reserved_tokens)), 0) AS tokens FROM usage WHERE task_id = ?').get(task.id) as { calls: number; tokens: number };
      if (used.calls >= settings.maxCallsPerTask || used.tokens + reserved > settings.maxTokensPerTask) throw new DomainError('TASK_BUDGET_EXCEEDED');
      return this.db.prepare("INSERT INTO usage(task_id, attempt, reserved_tokens, state) VALUES (?, ?, ?, 'RESERVED')").run(task.id, task.attempt, reserved).lastInsertRowid;
    })();
    let analysis: Analysis;
    try {
      analysis = await this.model.analyze(context, settings, signal, tokens => {
        this.db.prepare('UPDATE usage SET actual_tokens = ?, state = ? WHERE id = ?').run(tokens, tokens === null ? 'UNKNOWN' : 'KNOWN', usageId);
      });
    } finally { this.db.prepare("UPDATE usage SET state = 'UNKNOWN' WHERE id = ? AND state = 'RESERVED'").run(usageId); }
    if (!this.live(task) || signal.aborted) return;
    const result = JSON.stringify(analysis);
    if (Buffer.byteLength(result) > settings.maxArtifactBytes) throw new DomainError('ANALYSIS_LIMIT_EXCEEDED');
    this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET analysis = ?, status = 'WAITING_CONFIRMATION', current_step = 'analysis', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ? AND status = 'RUNNING'").run(result, task.id, task.attempt);
      this.step(task, 'analysis', '结构化分析已保存；模型引文已与实际输入核对，仍需人工审查，未执行项目测试。');
    })();
  }
  async close() {
    this.closed = true;
    if (this.running) {
      this.db.prepare("UPDATE tasks SET status = 'INTERRUPTED', attempt = attempt + 1 WHERE id = ? AND status = 'RUNNING'").run(this.running.id);
      this.running.controller.abort();
    }
    await this.pumping;
  }
}

