import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { defaults, loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { TaskService } from '../server/tasks.js';
import { ModelClient, type Analysis } from '../server/model.js';
import { canonicalPlan, checkPatch, type PlanInput, type PatchOutput } from '../server/patch.js';
import type { Snapshot } from '../server/github.js';
import { buildApp } from '../server/app.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const settings = { ...defaults, model: 'fixture-model' };
const source = (): Snapshot => ({ repo: 'owner/repo', commit: 'a'.repeat(40), issue: { number: 1, title: 'test issue', body: 'expected behavior', url: 'https://github.com/owner/repo/issues/1' }, files: [{ path: 'src/main.ts', content: 'export const value = 1;\n', url: `https://github.com/owner/repo/blob/${'a'.repeat(40)}/src/main.ts` }], gaps: ['FIXTURE'], capturedAt: '2026-10-29T00:00:00Z' });
const analysis: Analysis = { summary: 'FIXTURE', recommendation: 'NEEDS_REVIEW', rationale: '仅为夹具', uncertainties: ['未执行测试'], evidence: [], plan: ['修改常量边界'] };
const input = (): PlanInput => ({ steps: ['修改常量边界'], allowedPaths: ['src/main.ts'], allowSensitive: false, allowDependencies: false });
const patch = (): PatchOutput => ({ diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n', prTitle: '修正边界', prBody: 'FIXTURE：UNVERIFIED，测试 NOT_RUN。' });
const model = (result: PatchOutput = patch()) => new ModelClient(async () => ({ usage: { total_tokens: 120 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { MODEL_API_KEY: 'fixture-secret-key' });
function fixture(provider = model(), dbPath = ':memory:') {
  const db = openDatabase(dbPath), id = randomUUID();
  db.prepare("INSERT INTO tasks(id, repo, issue_number, status, config_snapshot, snapshot, analysis, base_sha, data_source) VALUES (?, 'owner/repo', 1, 'WAITING_CONFIRMATION', ?, ?, ?, ?, 'FIXTURE')").run(id, JSON.stringify(settings), JSON.stringify(source()), JSON.stringify(analysis), source().commit);
  const tasks = new TaskService(db, { model: provider, source: 'FIXTURE' });
  const save = (version = 0) => tasks.review.save(id, input(), version, source().commit);
  const confirmed = () => { const p = save(); tasks.review.confirm(id, p.id, p.hash, p.content.baseSha); return p; };
  return { db, id, tasks, save, confirmed };
}

test('plan confirmation binds exact hash, version, commit and analysis/source snapshots', async () => {
  const { db, id, tasks, save } = fixture();
  try {
    const p = save();
    assert.throws(() => tasks.generate(id, p.id, p.hash, p.content.baseSha), /CONFIRMATION_REQUIRED/);
    assert.throws(() => tasks.review.confirm(id, p.id, '0'.repeat(64), p.content.baseSha), /VERSION_CONFLICT/);
    assert.throws(() => tasks.review.confirm(id, p.id, p.hash, 'b'.repeat(40)), /COMMIT_CONFLICT/);
    tasks.review.confirm(id, p.id, p.hash, p.content.baseSha);
    const p2 = save(1); assert.equal(p2.confirmedAt, null);
    assert.throws(() => tasks.generate(id, p.id, p.hash, p.content.baseSha), /VERSION_CONFLICT/);
    db.prepare('UPDATE tasks SET base_sha = ? WHERE id = ?').run('c'.repeat(40), id);
    assert.throws(() => tasks.review.confirm(id, p2.id, p2.hash, p2.content.baseSha), /SOURCE_CHANGED/);
  } finally { await tasks.close(); db.close(); }
});

test('dangerous paths, absent source, sensitive and dependency scope require explicit plan revision', () => {
  const snapshot = source();
  for (const path of ['../main.ts', '/tmp/x.ts', 'C:/x.ts', '.env', '.git/config', '.github/workflows/run.yml', 'src//main.ts', 'src/空间.ts']) assert.throws(() => canonicalPlan({ ...input(), allowedPaths: [path] }, 'task', 1, snapshot, analysis));
  assert.throws(() => canonicalPlan({ ...input(), allowedPaths: ['missing.ts'] }, 'task', 1, snapshot, analysis), /SOURCE_ANALYSIS/);
  snapshot.files.push({ ...snapshot.files[0], path: 'config/app.yml' }, { ...snapshot.files[0], path: 'package.json' });
  assert.throws(() => canonicalPlan({ ...input(), allowedPaths: ['config/app.yml'] }, 'task', 1, snapshot, analysis), /SENSITIVE_PLAN/);
  assert.throws(() => canonicalPlan({ ...input(), allowedPaths: ['package.json'] }, 'task', 1, snapshot, analysis), /DEPENDENCY_PLAN/);
  assert.equal(canonicalPlan({ ...input(), allowedPaths: ['package.json'], allowDependencies: true }, 'task', 1, snapshot, analysis).allowDependencies, true);
});

test('unified diff validates source lines and counts, rejects scope escapes and unsupported formats', () => {
  const s = source(), p = canonicalPlan(input(), 'task', 1, s, analysis);
  assert.equal(checkPatch(patch(), p, s, settings).checks.sourceHunks, 'PASS');
  for (const invalid of [
    patch().diff.replace('value = 1', 'value = 9'),
    patch().diff.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@'),
    patch().diff.replace('@@ -1 +1 @@', '@@ -1 +4 @@'),
    patch().diff.replace('a/src/main.ts', 'a/../main.ts'),
    patch().diff.replaceAll('src/main.ts', 'src/other.ts'),
    patch().diff.replace('--- a/src/main.ts', 'old mode 100644\nnew mode 120000\n--- a/src/main.ts'),
    patch().diff + '\n', patch().diff.slice(0, -1), patch().diff.replace('+++ b/src/main.ts', '+++ /dev/null'),
  ]) assert.throws(() => checkPatch({ ...patch(), diff: invalid }, p, s, settings));
  const dep = patch().diff.replace('+export const value = 2;', "+import thing from 'new-dependency';");
  assert.throws(() => checkPatch({ ...patch(), diff: dep }, p, s, settings), /DEPENDENCY_REQUIRES_NEW_PLAN/);
});

test('one generation per confirmed plan yields a hashed UNVERIFIED private bundle', async () => {
  const { db, id, tasks, confirmed } = fixture();
  try {
    const p = confirmed(); assert.equal(tasks.generate(id, p.id, p.hash, p.content.baseSha).duplicate, false);
    assert.equal(tasks.generate(id, p.id, p.hash, p.content.baseSha).duplicate, true);
    await tasks.idle(); const detail = tasks.detail(id), a = detail.artifact!;
    assert.equal(detail.status, 'COMPLETED'); assert.equal(detail.usage.length, 1);
    assert.equal(a.bundle.patchStatus, 'UNVERIFIED'); assert.equal(a.bundle.projectTests, 'NOT_RUN'); assert.equal(a.bundle.source, 'FIXTURE');
    assert.equal(a.reviewStatus, 'PENDING'); assert.equal(a.bundle.checks.application, 'NOT_RUN');
    assert.match(tasks.review.download(id, a.id, 'pr').content, /UNVERIFIED/);
    assert.ok(tasks.review.download(id, a.id, 'pr').content.includes('\n'));
    tasks.review.review(id, a.id, a.hash, 'REVIEWED');
    assert.equal(tasks.detail(id).artifact!.reviewStatus, 'REVIEWED');
    assert.equal(tasks.detail(id).artifact!.bundle.patchStatus, 'UNVERIFIED');
    tasks.review.review(id, a.id, a.hash, 'REJECTED');
    assert.throws(() => tasks.review.download(id, a.id, 'diff'), /REJECTED/);
    assert.equal(tasks.generate(id, p.id, p.hash, p.content.baseSha).duplicate, true); assert.equal(tasks.detail(id).usage.length, 1);
  } finally { await tasks.close(); db.close(); }
});

test('revision invalidates prior downloads and confirmations; tampered artifact is refused', async () => {
  const { db, id, tasks, confirmed, save } = fixture();
  try {
    const p = confirmed(); tasks.generate(id, p.id, p.hash, p.content.baseSha); await tasks.idle();
    const a = tasks.detail(id).artifact!;
    db.prepare('UPDATE artifacts SET content = ? WHERE id = ?').run('{}', a.id);
    assert.throws(() => tasks.review.download(id, a.id, 'bundle'), /INTEGRITY/);
    const p2 = save(1);
    assert.equal(tasks.detail(id).artifact, null);
    assert.throws(() => tasks.review.download(id, a.id, 'bundle'), /NOT_CURRENT/);
    assert.throws(() => tasks.generate(id, p2.id, p2.hash, p2.content.baseSha), /CONFIRMATION_REQUIRED/);
  } finally { await tasks.close(); db.close(); }
});

test('out-of-scope generation is rejected without storing unsafe artifacts or retry loops', async () => {
  const { db, id, tasks, confirmed } = fixture(model({ ...patch(), diff: patch().diff.replaceAll('src/main.ts', 'outside.ts') }));
  try {
    const p = confirmed(); tasks.generate(id, p.id, p.hash, p.content.baseSha); await tasks.idle();
    const detail = tasks.detail(id);
    assert.equal(detail.status, 'FAILED'); assert.equal(detail.error_code, 'PATCH_SCOPE_REQUIRES_NEW_PLAN'); assert.equal(detail.artifact, null);
    assert.throws(() => tasks.retry(id, detail.attempt), /PATCH_REQUIRES_NEW_PLAN/);
    assert.equal(tasks.generate(id, p.id, p.hash, p.content.baseSha).duplicate, true);
  } finally { await tasks.close(); db.close(); }
});

test('manual PR records validate target repo and never claim remote verification', async () => {
  const { db, id, tasks } = fixture();
  try {
    for (const url of ['http://github.com/owner/repo/pull/1', 'https://evil.test/owner/repo/pull/1', 'https://github.com/other/repo/pull/1', 'https://github.com/owner/repo/issues/1', 'https://name@github.com/owner/repo/pull/1']) assert.throws(() => tasks.review.recordPr(id, url, 'OPEN'));
    assert.deepEqual(tasks.review.recordPr(id, 'https://github.com/owner/repo/pull/123', 'OPEN'), { ok: true, source: 'MANUAL', remoteVerified: false });
    assert.equal((tasks.detail(id).manualPr as any).source, 'MANUAL');
  } finally { await tasks.close(); db.close(); }
});

test('patch cancellation rejects late output and a new confirmed plan can proceed serially', async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  class Delayed extends ModelClient {
    override available() { return true; }
    override async generatePatch(_s: Snapshot, _a: Analysis, _p: ReturnType<typeof canonicalPlan>, _settings: typeof defaults, _signal: AbortSignal, usage: (n: number | null) => void) {
      calls++;
      if (calls === 1) { entered(); await gate; }
      usage(30); return patch();
    }
  }
  const { db, id, tasks, confirmed, save } = fixture(new Delayed());
  try {
    const first = confirmed(); tasks.generate(id, first.id, first.hash, first.content.baseSha); await started;
    tasks.cancel(id); assert.equal(tasks.detail(id).status, 'CANCELLED');
    const second = save(1); tasks.review.confirm(id, second.id, second.hash, second.content.baseSha); tasks.generate(id, second.id, second.hash, second.content.baseSha);
    release(); await tasks.idle();
    assert.equal(tasks.detail(id).status, 'COMPLETED');
    assert.equal(tasks.detail(id).artifact!.bundle.plan.id, second.id);
    assert.equal((db.prepare('SELECT count(*) AS n FROM artifacts').get() as any).n, 1);
    assert.equal(tasks.detail(id).usage.length, 2);
  } finally { release(); await tasks.close(); db.close(); }
});

test('patch generation obeys cumulative analysis budget and preserves unknown failed call cost', async () => {
  const { db, id, tasks, confirmed } = fixture();
  try {
    db.prepare('UPDATE tasks SET config_snapshot = ? WHERE id = ?').run(JSON.stringify({ ...settings, maxCallsPerTask: 1 }), id);
    db.prepare("INSERT INTO usage(task_id, attempt, reserved_tokens, state) VALUES (?, 0, 5000, 'UNKNOWN')").run(id);
    const p = confirmed(); tasks.generate(id, p.id, p.hash, p.content.baseSha); await tasks.idle();
    assert.equal(tasks.detail(id).error_code, 'TASK_BUDGET_EXCEEDED');
    assert.equal(tasks.detail(id).usage.length, 1); assert.equal(tasks.detail(id).artifact, null);
  } finally { await tasks.close(); db.close(); }
});

test('M2 API requires login and CSRF, then provides private versioned downloads', async () => {
  const { db, id, tasks, confirmed } = fixture();
  const salt = 'f'.repeat(32), password = 'm2-api-fixture-password';
  const config = loadConfig({ ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}` });
  const app = await buildApp(config, db, false, { model: model(), source: 'FIXTURE' });
  try {
    const p = confirmed(); tasks.generate(id, p.id, p.hash, p.content.baseSha); await tasks.idle();
    const a = tasks.detail(id).artifact!, path = `/api/admin/tasks/${id}/artifacts/${a.id}/download?format=diff`;
    assert.equal((await app.inject(path)).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.origin }, payload: { password } });
    const headers = { origin: config.origin, cookie: `scout_session=${login.cookies[0].value}`, 'x-csrf-token': login.json().csrfToken };
    const downloaded = await app.inject({ url: path, headers });
    assert.equal(downloaded.statusCode, 200); assert.equal(downloaded.body, patch().diff);
    assert.match(downloaded.headers['content-disposition'] as string, /UNVERIFIED/); assert.equal(downloaded.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/tasks/${id}/artifacts/${a.id}/review`, headers: { cookie: headers.cookie, origin: config.origin }, payload: { hash: a.hash, status: 'REVIEWED' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/tasks/${id}/artifacts/${a.id}/review`, headers, payload: { hash: a.hash, status: 'VERIFIED' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/admin/tasks/${id}/manual-pr`, headers, payload: { url: 'https://github.com/owner/repo/pull/9', status: 'OPEN' } })).json().source, 'MANUAL');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/tasks/${id}/artifacts/${a.id}/review`, headers, payload: { hash: a.hash, status: 'REJECTED' } })).statusCode, 200);
    assert.equal((await app.inject({ url: path, headers })).statusCode, 409);
    await app.inject({ method: 'POST', url: '/api/admin/logout', headers });
    assert.equal((await app.inject({ url: path, headers })).statusCode, 401);
  } finally { await app.close(); await tasks.close(); db.close(); }
});

test('consistent backup restores versioned plans, artifacts and SHA-256-checked downloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-m2-backup-')); const path = join(dir, 'source.sqlite');
  const { db, id, tasks, confirmed } = fixture(model(), path);
  try {
    const p = confirmed(); tasks.generate(id, p.id, p.hash, p.content.baseSha); await tasks.idle();
    const artifact = tasks.detail(id).artifact!;
    tasks.review.review(id, artifact.id, artifact.hash, 'REVIEWED');
    tasks.review.recordPr(id, 'https://github.com/owner/repo/pull/123', 'OPEN');
    const result = spawnSync(process.execPath, ['dist/server/backup.js', join(dir, 'backups')], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const restoredDb = openDatabase(join(dir, 'backups', readdirSync(join(dir, 'backups')).find(name => name.endsWith('.sqlite'))!), false);
    const restored = new TaskService(restoredDb);
    try {
      assert.equal(restoredDb.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(restored.detail(id).source, 'FIXTURE');
      assert.equal(restored.detail(id).plan!.hash, p.hash);
      assert.equal(restored.detail(id).artifact!.hash, artifact.hash);
      assert.equal(restored.detail(id).artifact!.reviewStatus, 'REVIEWED');
      assert.equal((restored.detail(id).manualPr as any).source, 'MANUAL');
      assert.equal(restored.review.download(id, artifact.id, 'diff').content, patch().diff);
    } finally { await restored.close(); restoredDb.close(); }
  } finally { await tasks.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart never replays a requested patch; it needs a new version and confirmation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-m2-restart-')); const path = join(dir, 'source.sqlite');
  const { db, id, tasks, confirmed } = fixture(model(), path);
  const p = confirmed();
  db.prepare("UPDATE plans SET requested_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  db.prepare("UPDATE tasks SET status = 'RUNNING', phase = 'PATCH' WHERE id = ?").run(id);
  db.prepare("INSERT INTO usage(task_id, attempt, reserved_tokens, state) VALUES (?, 1, 5000, 'RESERVED')").run(id);
  await tasks.close(); db.close();
  const restartedDb = openDatabase(path), restarted = new TaskService(restartedDb, { model: model() });
  try {
    assert.equal(restarted.detail(id).status, 'INTERRUPTED');
    assert.equal((restarted.detail(id).usage[0] as any).state, 'UNKNOWN');
    assert.throws(() => restarted.retry(id, restarted.detail(id).attempt), /NEW_PLAN/);
    assert.equal(restarted.generate(id, p.id, p.hash, p.content.baseSha).duplicate, true); await restarted.idle();
    assert.equal(restarted.detail(id).status, 'INTERRUPTED'); assert.equal(restarted.detail(id).artifact, null);
    const next = restarted.review.save(id, input(), 1, p.content.baseSha);
    assert.equal(next.confirmedAt, null);
    assert.throws(() => restarted.generate(id, next.id, next.hash, next.content.baseSha), /CONFIRMATION/);
  } finally { await restarted.close(); restartedDb.close(); rmSync(dir, { recursive: true, force: true }); }
});
