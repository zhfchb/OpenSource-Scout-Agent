import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { defaults, assertSettings } from './config.js';
import { GithubClient, parseGithubUrl, type Settings, type Snapshot } from './github.js';
import { ModelClient, prepareContext, preparePatchRequest, type Analysis } from './model.js';
import { DomainError } from './network.js';
import { ReviewService } from './review.js';
import { checkPatch, type PlanContent } from './patch.js';
import { digest } from './auth.js';
import { StorageGuard, type StorageLimits } from './storage.js';
import type { RuntimeMetrics } from './metrics.js';
import { executionSlot } from './execution-slot.js';
import { errorGuidance } from './error-guidance.js';
import {enqueue,queueHead,queueCount,finishWork,cancelQueued} from './work-queue.js';
import type {Transport} from './network.js';

interface Task { id: string; repo: string; issue_number: number; status: string; phase: string; data_source: string; attempt: number; config_snapshot: string; snapshot: string | null; analysis: string | null; request_key: string | null }
export type TaskDependencies = { github?: GithubClient; model?: ModelClient; env?:NodeJS.ProcessEnv; source?: 'LIVE_API' | 'FIXTURE'; limits?: StorageLimits; metrics?: RuntimeMetrics; discoveryTransport?:Transport; sourceGate?:(taskId:string,signal:AbortSignal,snapshot?:Snapshot)=>Promise<boolean> };
export class TaskService {
  readonly review: ReviewService;
  private guard: StorageGuard;
  private github: GithubClient; private model: ModelClient;
  private running?: { id: string; controller: AbortController };
  private pumping?: Promise<void>;
  private closed = false;
  private unsubscribe: () => void;
  constructor(private db: Database.Database, private deps: TaskDependencies = {}) { this.github = deps.github || new GithubClient(); this.model = deps.model || new ModelClient(); this.review = new ReviewService(db, deps.limits); this.guard = new StorageGuard(db, deps.limits); this.unsubscribe = executionSlot(db).subscribe(() => this.kick()); }
  settings(): Settings { return { ...defaults, ...JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id = 1').get() as { value: string }).value) }; }
  ready() { return this.model.available(this.settings()); }
  setSourceGate(gate:NonNullable<TaskDependencies['sourceGate']>){this.deps.sourceGate=gate;}
  resumeSource(id:string){const task=this.get(id);if(task.analysis)throw new DomainError('SOURCE_NEW_SELECTION_REQUIRED',409);if(task.phase!=='ANALYSIS'||task.status!=='WAITING_CONFIRMATION'||(task as any).source_gate_status!=='WAITING_SOURCE_CONFIRMATION'||!(task as any).source_selection_id)throw new DomainError('SOURCE_RECHECK_REQUIRED',409);if(!this.model.available(JSON.parse(task.config_snapshot)))throw new DomainError('MODEL_NOT_CONFIGURED');if(queueCount(this.db)>=10)throw new DomainError('QUEUE_LIMIT_REACHED',409);this.db.prepare("UPDATE tasks SET status='QUEUED',attempt=attempt+1,source_gate_status=NULL,snapshot=NULL,analysis=NULL WHERE id=?").run(id);this.kick();}
  async issues(url: string) { const release = executionSlot(this.db).acquire(); if (!release) throw new DomainError('EXECUTION_BUSY', 409); try { return await this.github.listIssues(url, this.settings(), new AbortController().signal); } finally { release(); } }
  list() { return this.db.prepare('SELECT id, repo, issue_number, base_sha, status, phase, current_step, attempt, error_code, created_at, updated_at FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT 50').all(); }
  detail(id: string) {
    const task = this.get(id);
    const { config_snapshot: _private, request_key: _key, snapshot, ...rest } = task;
    const data = snapshot ? JSON.parse(snapshot) as Snapshot : null;
    const failure = this.db.prepare('SELECT error_code, error_request_id, current_step FROM tasks WHERE id=?').get(id) as {error_code:string|null;error_request_id:string|null;current_step:string|null};
    const errorDetails = failure.error_code ? {code:failure.error_code,requestId:failure.error_request_id,step:failure.current_step,...errorGuidance(failure.error_code),resultsSaved:Boolean(task.analysis),usageUnknown:Boolean(this.db.prepare("SELECT 1 FROM usage WHERE task_id=? AND state='UNKNOWN'").get(id))} : null;
    return { ...rest, errorDetails, snapshot: data ? { ...data, files: data.files.map(({ content: _content, ...f }) => f) } : null,
      analysis: JSON.parse((this.db.prepare('SELECT analysis FROM tasks WHERE id = ?').get(id) as { analysis: string | null }).analysis || 'null'),
      steps: this.db.prepare('SELECT attempt, step, status, summary, created_at FROM task_steps WHERE task_id = ? ORDER BY id').all(id),
      usage: this.db.prepare('SELECT attempt, reserved_tokens, actual_tokens, state FROM usage WHERE task_id = ? ORDER BY id').all(id), projectTests: 'NOT_RUN', source: task.data_source, ...this.review.view(id) };
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
    this.guard.task();
    const settings = this.settings();
    try { assertSettings(settings); } catch { throw new DomainError('INVALID_SETTINGS'); }
    if (!this.model.available(settings)) throw new DomainError('MODEL_NOT_CONFIGURED');
    if (queueCount(this.db) >= 10) throw new DomainError('QUEUE_LIMIT_REACHED', 409);
    const id = randomUUID();
    this.db.prepare("INSERT INTO tasks(id, repo, issue_number, status, config_snapshot, request_key, data_source) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)").run(id, target.repo, target.issue, JSON.stringify(settings), key, this.deps.source || 'LIVE_API');
    this.db.prepare('UPDATE tasks SET settings_revision=(SELECT revision FROM settings WHERE id=1) WHERE id=?').run(id);
    this.kick(); return { id, duplicate: false };
  }
  cancel(id: string) {
    const task = this.get(id);
    if (!['QUEUED', 'RUNNING'].includes(task.status)) throw new DomainError('TASK_NOT_ACTIVE', 409);
    this.db.prepare("UPDATE tasks SET status = 'CANCELLED', attempt = attempt + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('QUEUED','RUNNING')").run(id);
    if (this.running?.id === id) this.running.controller.abort();
    cancelQueued(this.db,'TASK',id);
    return { ok: true };
  }
  retry(id: string, expectedAttempt: number) {
    const task = this.get(id);
    if (task.phase === 'PATCH') throw new DomainError('PATCH_REQUIRES_NEW_PLAN', 409);
    if (task.attempt !== expectedAttempt || !['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)) throw new DomainError('RETRY_CONFLICT', 409);
    if (this.db.prepare("SELECT 1 FROM tasks WHERE repo = ? AND issue_number = ? AND id != ? AND status IN ('QUEUED','RUNNING')").get(task.repo, task.issue_number, id)) throw new DomainError('TASK_ALREADY_ACTIVE', 409);
    if (queueCount(this.db) >= 10) throw new DomainError('QUEUE_LIMIT_REACHED', 409);
    try { assertSettings(JSON.parse(task.config_snapshot)); } catch { throw new DomainError('INVALID_SETTINGS'); }
    if (!this.model.available(JSON.parse(task.config_snapshot))) throw new DomainError('MODEL_NOT_CONFIGURED');
    this.db.prepare("UPDATE tasks SET status = 'QUEUED', attempt = attempt + 1, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ?").run(id, expectedAttempt);
    this.kick(); return { ok: true };
  }
  generate(id: string, planId: string, hash: string, baseSha: string) {
    const result = this.db.transaction(() => {
      const plan = this.review.match(id, planId, hash, baseSha), task = this.get(id);
      if (!plan.confirmed_at) throw new DomainError('PLAN_CONFIRMATION_REQUIRED', 409);
      if (plan.requested_at) return { id, duplicate: true };
      if (task.status !== 'WAITING_CONFIRMATION') throw new DomainError('PATCH_TASK_NOT_READY', 409);
      if (this.db.prepare("SELECT 1 FROM tasks WHERE repo = ? AND issue_number = ? AND id != ? AND status IN ('QUEUED','RUNNING')").get(task.repo, task.issue_number, id)) throw new DomainError('TASK_ALREADY_ACTIVE', 409);
      if (queueCount(this.db) >= 10) throw new DomainError('QUEUE_LIMIT_REACHED', 409);
      const settings = JSON.parse(task.config_snapshot);
      try { assertSettings(settings); } catch { throw new DomainError('INVALID_SETTINGS'); }
      if (!this.model.available(settings)) throw new DomainError('MODEL_NOT_CONFIGURED');
      preparePatchRequest(JSON.parse(task.snapshot!), JSON.parse(task.analysis!), JSON.parse(plan.content), settings);
      this.db.prepare('UPDATE plans SET requested_at = CURRENT_TIMESTAMP WHERE id = ? AND requested_at IS NULL').run(plan.id);
      this.db.prepare("UPDATE tasks SET status = 'QUEUED', phase = 'PATCH', current_step = 'patch', attempt = attempt + 1, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      return { id, duplicate: false };
    })();
    this.kick(); return result;
  }
  private live(task: Task) { return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'RUNNING' AND attempt = ?").get(task.id, task.attempt)); }
  private step(task: Task, name: string, summary: string) {
    this.db.prepare('INSERT INTO task_steps(task_id, attempt, step, status, summary) VALUES (?, ?, ?, ?, ?)').run(task.id, task.attempt, name, 'COMPLETED', summary);
    this.db.prepare('UPDATE tasks SET current_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ?').run(name, task.id, task.attempt);
  }
  private kick() {
    if (this.closed) return;
    for(const row of this.db.prepare("SELECT id,attempt FROM tasks WHERE status='QUEUED' ORDER BY created_at,rowid").all() as {id:string;attempt:number}[])enqueue(this.db,'TASK',row.id,row.attempt);
    if(this.pumping)return;
    this.pumping = Promise.resolve().then(() => this.pump()).finally(() => { this.pumping = undefined; });
  }
  async idle() { await this.pumping; }
  private async pump() {
    while (!this.closed) {
      const head=queueHead(this.db);if(!head||head.kind!=='TASK')break;
      const task = this.db.prepare("SELECT * FROM tasks WHERE id=? AND status='QUEUED' AND attempt=?").get(head.entity_id,head.attempt) as Task | undefined;
      if(!task){finishWork(this.db,'TASK',head.entity_id,head.attempt);continue;}
      const release = executionSlot(this.db).acquire();
      if (!release) break;
      const claim = this.db.prepare("UPDATE tasks SET status = 'RUNNING', current_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'QUEUED'").run(task.phase === 'PATCH' ? 'patch' : task.snapshot ? 'analysis' : 'source', task.id);
      if (!claim.changes) { release(); continue; }
      this.db.prepare("UPDATE execution_queue SET state='RUNNING' WHERE seq=?").run(head.seq);
      const controller = new AbortController(); this.running = { id: task.id, controller };
      this.deps.metrics?.mark(task.phase === 'PATCH' ? 'patch' : task.snapshot ? 'analysis' : 'source');
      try { await this.run(task, controller.signal); }
      catch (error) {
        if (this.live(task)) {
          const code = error instanceof DomainError ? error.code : controller.signal.aborted ? 'REQUEST_ABORTED' : 'STEP_REQUEST_FAILED';
          this.db.prepare("UPDATE tasks SET status = 'FAILED', error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ? AND status = 'RUNNING'").run(code, task.id, task.attempt);
          this.db.prepare('UPDATE tasks SET error_request_id=? WHERE id=?').run(randomUUID(),task.id);
          const step = (this.db.prepare('SELECT current_step FROM tasks WHERE id = ?').get(task.id) as { current_step: string }).current_step;
          this.db.prepare("INSERT INTO task_steps(task_id, attempt, step, status, summary) VALUES (?, ?, ?, 'FAILED', ?)").run(task.id, task.attempt, step, code);
        }
      } finally { finishWork(this.db,'TASK',task.id,task.attempt);this.running = undefined; this.deps.metrics?.mark('idle'); release(); }
    }
  }
  private async run(task: Task, signal: AbortSignal) {
    if (task.phase === 'PATCH') return this.runPatch(task, signal);
    if(this.deps.sourceGate&&!await this.deps.sourceGate(task.id,signal))return;
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
      this.guard.writable(Buffer.byteLength(value));
      this.db.transaction(() => {
        this.db.prepare('UPDATE tasks SET snapshot = ?, base_sha = ? WHERE id = ? AND attempt = ?').run(value, context.commit, task.id, task.attempt);
        this.step(task, 'source', `固定 Commit，保存 ${context.files.length} 个文件；包含 ${context.gaps.length} 条数据缺口。`);
      })();
    }
    if (!this.live(task)) return;
    if(this.deps.sourceGate&&!await this.deps.sourceGate(task.id,signal,context))return;
    this.db.prepare("UPDATE tasks SET current_step = 'analysis' WHERE id = ? AND attempt = ?").run(task.id, task.attempt);
    this.deps.metrics?.mark('analysis');
    const reserved = prepareContext(context, settings).reservedTokens;
    const usageId = this.reserve(task, reserved);
    let analysis: Analysis;
    try {
      analysis = await this.model.analyze(context, settings, signal, tokens => {
        this.db.prepare('UPDATE usage SET actual_tokens = ?, state = ? WHERE id = ?').run(tokens, tokens === null ? 'UNKNOWN' : 'KNOWN', usageId);
      });
    } finally { this.db.prepare("UPDATE usage SET state = 'UNKNOWN' WHERE id = ? AND state = 'RESERVED'").run(usageId); }
    if (!this.live(task) || signal.aborted) return;
    const result = JSON.stringify(analysis);
    if (Buffer.byteLength(result) > settings.maxArtifactBytes) throw new DomainError('ANALYSIS_LIMIT_EXCEEDED');
    this.guard.writable(Buffer.byteLength(result));
    this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET analysis = ?, status = 'WAITING_CONFIRMATION', current_step = 'analysis', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ? AND status = 'RUNNING'").run(result, task.id, task.attempt);
      this.step(task, 'analysis', '结构化分析已保存；模型引文已与实际输入核对，仍需人工审查，未执行项目测试。');
    })();
  }
  private reserve(task: Task, reserved: number) {
    const settings = JSON.parse(task.config_snapshot);
    return this.db.transaction(() => {
      const used = this.db.prepare('SELECT count(*) AS calls, coalesce(sum(coalesce(actual_tokens, reserved_tokens)), 0) AS tokens FROM usage WHERE task_id = ?').get(task.id) as { calls: number; tokens: number };
      if (used.calls >= settings.maxCallsPerTask || used.tokens + reserved > settings.maxTokensPerTask) throw new DomainError('TASK_BUDGET_EXCEEDED');
      return this.db.prepare("INSERT INTO usage(task_id, attempt, reserved_tokens, state) VALUES (?, ?, ?, 'RESERVED')").run(task.id, task.attempt, reserved).lastInsertRowid;
    })();
  }
  private async runPatch(task: Task, signal: AbortSignal) {
    const row = this.review.latest(task.id);
    if (!row?.confirmed_at || !row.requested_at) throw new DomainError('PLAN_CONFIRMATION_REQUIRED', 409);
    const plan = this.review.checkBinding(task.id, row);
    const snapshot = JSON.parse(task.snapshot!) as Snapshot, analysis = JSON.parse(task.analysis!) as Analysis, settings = JSON.parse(task.config_snapshot) as Settings;
    const { reservedTokens } = preparePatchRequest(snapshot, analysis, plan, settings);
    this.guard.artifact(settings.maxArtifactBytes);
    const usageId = this.reserve(task, reservedTokens);
    let output: unknown;
    try {
      output = await this.model.generatePatch(snapshot, analysis, plan, settings, signal, tokens => {
        this.db.prepare('UPDATE usage SET actual_tokens = ?, state = ? WHERE id = ?').run(tokens, tokens === null ? 'UNKNOWN' : 'KNOWN', usageId);
      });
    } finally { this.db.prepare("UPDATE usage SET state = 'UNKNOWN' WHERE id = ? AND state = 'RESERVED'").run(usageId); }
    if (!this.live(task) || signal.aborted) return;
    const checked = checkPatch(output, plan, snapshot, settings);
    const prDraft = `# ${checked.patch.prTitle}\n\n> UNVERIFIED · 未编译、未测试、未应用。编译/测试：NOT_RUN。需人工核实以下模型草稿。\n\n${checked.patch.prBody}`;
    const bundle = { schemaVersion: 1, patchStatus: 'UNVERIFIED', compilation: 'NOT_RUN', projectTests: 'NOT_RUN', source: task.data_source, repo: task.repo, issueNumber: task.issue_number, commit: snapshot.commit,
      plan: { id: row.id, hash: row.hash, content: plan }, analysis, patch: checked.patch, prDraft, checks: checked.checks, createdAt: new Date().toISOString() };
    const content = JSON.stringify(bundle), bytes = Buffer.byteLength(content);
    if (bytes > settings.maxArtifactBytes) throw new DomainError('REVIEW_BUNDLE_SIZE_EXCEEDED', 502);
    this.guard.artifact(bytes);
    this.db.transaction(() => {
      this.review.checkBinding(task.id, row);
      this.db.prepare('INSERT INTO artifacts(id, task_id, plan_id, content, hash, bytes) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), task.id, row.id, content, digest(content), bytes);
      this.db.prepare("UPDATE tasks SET status = 'COMPLETED', current_step = 'patch', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt = ? AND status = 'RUNNING'").run(task.id, task.attempt);
      this.step(task, 'patch', '单次补丁审核包已保存；仅完成格式、范围、路径与原始行核对，UNVERIFIED，编译/测试 NOT_RUN。');
    })();
  }
  async close() {
    this.closed = true;
    this.unsubscribe();
    if (this.running) {
      this.db.prepare("UPDATE tasks SET status = 'INTERRUPTED', attempt = attempt + 1 WHERE id = ? AND status = 'RUNNING'").run(this.running.id);
      this.running.controller.abort();
    }
    await this.pumping;
  }
}

