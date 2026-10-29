import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, loadConfig } from '../server/config.js';
import { buildApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { GithubClient, parseGithubUrl, safeSourcePath, type Snapshot } from '../server/github.js';
import { ModelClient, prepareContext, validateAnalysis, type Analysis } from '../server/model.js';
import { TaskService } from '../server/tasks.js';
import { boundedJson, DomainError, type Transport } from '../server/network.js';

const signal = () => new AbortController().signal;
const settings = { ...defaults, model: 'test-model' };
const snapshot = (): Snapshot => ({ repo: 'owner/repo', commit: 'a'.repeat(40), issue: { number: 1, title: '测试问题', body: 'expected behavior', url: 'https://github.com/owner/repo/issues/1' }, files: [{ path: 'src/main.ts', content: 'export const value = 1;', url: `https://github.com/owner/repo/blob/${'a'.repeat(40)}/src/main.ts` }], gaps: ['仅为单元测试夹具'], capturedAt: new Date().toISOString() });
const analysis = (): Analysis => ({ summary: '建议检查边界条件', recommendation: 'NEEDS_REVIEW', rationale: '需人工确认', uncertainties: ['未执行测试'], evidence: [{ path: 'src/main.ts', quote: 'value = 1' }], plan: ['增加边界校验'] });
class FixtureGithub extends GithubClient {
  calls = 0;
  override async snapshot() { this.calls++; return snapshot(); }
}
const fixtureModel = (usage = true) => new ModelClient(async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis()) } }], ...(usage ? { usage: { total_tokens: 300 } } : {}) }), { MODEL_API_KEY: 'unit-test-secret' });
function setup(model = fixtureModel()) {
  const db = openDatabase(':memory:');
  db.prepare('UPDATE settings SET value = ?').run(JSON.stringify(settings));
  const github = new FixtureGithub();
  const tasks = new TaskService(db, { github, model, source: 'FIXTURE' });
  return { db, github, tasks };
}

test('strict GitHub URLs reject SSRF, credentials, encoded paths and non-Issues', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/Owner/Repo/issues/12'), { repo: 'owner/repo', issue: 12 });
  for (const url of ['http://github.com/a/b', 'https://evil.test/a/b', 'https://github.com.evil.test/a/b', 'https://name@github.com/a/b', 'https://github.com/a/b/pull/1', 'https://github.com/a/b?x=1', 'https://github.com/a/%2e%2e', 'https://127.0.0.1/a/b', 'https://github.com/a/b/issues/0']) assert.throws(() => parseGithubUrl(url));
  for (const path of ['../main.ts', '/main.ts', '.env', '.github/workflows/run.yml', 'secrets/key.json', 'a\\b.ts', 'node_modules/a.ts', 'a.pem', 'image.png']) assert.equal(safeSourcePath(path), false, path);
});

test('GitHub only lists two pages, filters PRs and rejects private repositories', async () => {
  const urls: string[] = [];
  const client = new GithubClient(async url => {
    urls.push(url);
    if (!url.includes('/issues?')) return { private: false, default_branch: 'main' };
    return Array.from({ length: 20 }, (_, i) => ({ number: i + 1, title: `issue ${i}`, ...(i === 0 ? { pull_request: {} } : {}) }));
  });
  const result = await client.listIssues('https://github.com/owner/repo', settings, signal());
  assert.equal(result.items.length, 38); assert.equal(urls.length, 3); assert.equal(result.limited, true);
  assert.ok(urls.every(url => url.startsWith('https://api.github.com/repos/owner/repo')));
  await assert.rejects(new GithubClient(async () => ({ private: true, default_branch: 'main' })).listIssues('https://github.com/owner/repo', settings, signal()), /PUBLIC_REPOSITORY/);
});

test('bounded snapshot pins commit, excludes sensitive files and records missing context', async () => {
  const urls: string[] = [];
  const text = 'export const value = 1;';
  const blobSha = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
  const client = new GithubClient(async url => {
    urls.push(url);
    if (url.includes('/issues/')) return { number: 1, title: 'src/main.ts', body: 'a'.repeat(13000) };
    if (url.includes('/commits/')) return { sha: 'a'.repeat(40) };
    if (url.includes('/git/trees/')) return { truncated: true, tree: ['.env', 'src/main.ts', 'README.md', 'large.ts'].map((path, i) => ({ path, type: 'blob', mode: '100644', sha: blobSha, size: i === 3 ? 1000000 : Buffer.byteLength(text) })) };
    if (url.includes('/git/blobs/')) return { encoding: 'base64', content: Buffer.from('export const value = 1;').toString('base64') };
    return { private: false, default_branch: 'main' };
  });
  const result = await client.snapshot({ repo: 'owner/repo', issue: 1 }, { ...settings, maxFiles: 1 }, signal());
  assert.equal(result.files.length, 1); assert.equal(result.files[0].path, 'src/main.ts');
  assert.ok(result.files[0].url.includes('a'.repeat(40))); assert.equal(result.issue.body.length, 12000);
  assert.ok(result.gaps.some(g => g.includes('截断'))); assert.equal(urls.filter(url => url.includes('/git/blobs/')).length, 1);
});

test('read-only transient retries are bounded and permission errors are not retried', async () => {
  let attempts = 0;
  await assert.rejects(new GithubClient(async () => { attempts++; throw new TypeError('network error'); }).listIssues('https://github.com/owner/repo', settings, signal()));
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(new GithubClient(async () => { attempts++; throw new DomainError('REMOTE_RATE_OR_PERMISSION', 502); }).listIssues('https://github.com/owner/repo', settings, signal()));
  assert.equal(attempts, 1);
});

test('context preflight trims files and output evidence must match actual source', () => {
  const input = snapshot(); input.files.push({ ...input.files[0], path: 'large.ts', content: 'x'.repeat(30000) });
  const prepared = prepareContext(input, settings);
  assert.equal(prepared.context.files.length, 1); assert.ok(prepared.reservedTokens <= settings.maxTokensPerTask);
  assert.equal(prepareContext(prepared.context, settings).reservedTokens, prepared.reservedTokens);
  assert.equal(validateAnalysis(analysis(), snapshot()).evidence[0].url, snapshot().files[0].url);
  assert.throws(() => validateAnalysis({ ...analysis(), evidence: [{ path: 'missing.ts', quote: 'invented' }] }, snapshot()));
  assert.throws(() => validateAnalysis({ ...analysis(), command: 'anything' }, snapshot()));
});

test('restart interrupts queued/running tasks, preserves snapshots and conservatively marks reserved usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-m1-restart-')); const path = join(dir, 'db.sqlite');
  let db = openDatabase(path);
  try {
    for (const [id, status] of [['a', 'RUNNING'], ['b', 'QUEUED'], ['c', 'WAITING_CONFIRMATION']]) db.prepare('INSERT INTO tasks(id, repo, issue_number, status, config_snapshot, snapshot) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'fixture/repo', id.charCodeAt(0), status, JSON.stringify(settings), JSON.stringify(snapshot()));
    db.prepare("INSERT INTO usage(task_id, attempt, reserved_tokens, state) VALUES ('a', 0, 1000, 'RESERVED')").run();
    db.close(); db = openDatabase(path);
    assert.deepEqual((db.prepare('SELECT status FROM tasks ORDER BY id').all() as any[]).map(r => r.status), ['INTERRUPTED', 'INTERRUPTED', 'WAITING_CONFIRMATION']);
    assert.equal((db.prepare('SELECT state FROM usage').get() as any).state, 'UNKNOWN');
    assert.equal(JSON.parse((db.prepare("SELECT snapshot FROM tasks WHERE id = 'a'").get() as any).snapshot).commit, snapshot().commit);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('model rejects malformed JSON, truncated output, ungrounded evidence and credential echoes', async () => {
  for (const response of [
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...analysis(), summary: 'unit-test-secret' }) } }] },
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...analysis(), evidence: [{ path: 'missing.ts', quote: 'fake' }] }) } }] },
  ]) {
    let recorded = false;
    const model = new ModelClient(async () => ({ ...response, usage: { total_tokens: 10 } }), { MODEL_API_KEY: 'unit-test-secret' });
    await assert.rejects(model.analyze(snapshot(), settings, signal(), n => { recorded = n === 10; }));
    assert.equal(recorded, true);
  }
});

test('admin task API validates input and protects details and mutations', async () => {
  const db = openDatabase(':memory:'); db.prepare('UPDATE settings SET value = ?').run(JSON.stringify(settings));
  const salt = 'd'.repeat(32), password = 'api-fixture-password';
  const config = loadConfig({ ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}` });
  const app = await buildApp(config, db, false, { github: new FixtureGithub(), model: fixtureModel(), source: 'FIXTURE' });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/tasks', headers: { origin: config.origin }, payload: { url: 'https://github.com/owner/repo/issues/1', requestKey: randomUUID() } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.origin }, payload: { password } });
    const headers = { origin: config.origin, cookie: `scout_session=${login.cookies[0].value}`, 'x-csrf-token': login.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/tasks', headers, payload: { url: 'https://evil.test/', requestKey: randomUUID() } })).statusCode, 400);
    const created = await app.inject({ method: 'POST', url: '/api/admin/tasks', headers, payload: { url: 'https://github.com/owner/repo/issues/1', requestKey: randomUUID() } });
    assert.equal(created.statusCode, 202); const id = created.json().id;
    assert.equal((await app.inject(`/api/admin/tasks/${id}`)).statusCode, 401);
    const detail = await app.inject({ url: `/api/admin/tasks/${id}`, headers });
    assert.equal(detail.statusCode, 200); assert.equal(detail.json().source, 'FIXTURE');
    assert.equal(detail.body.includes('config_snapshot'), false);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/tasks/${id}/retry`, headers: { cookie: headers.cookie, origin: config.origin }, payload: { expectedAttempt: 0 } })).statusCode, 403);
  } finally { await app.close(); db.close(); }
});

test('duplicate submission is idempotent; analysis and known usage persist without exposing source content', async () => {
  const { db, github, tasks } = setup();
  try {
    const key = randomUUID(); const first = tasks.create('https://github.com/owner/repo/issues/1', key);
    assert.equal(tasks.create('https://github.com/owner/repo/issues/1', key).id, first.id);
    assert.equal(tasks.create('https://github.com/owner/repo/issues/1', randomUUID()).id, first.id);
    assert.throws(() => tasks.create('https://github.com/owner/repo/issues/2', key), /IDEMPOTENCY/);
    await tasks.idle();
    const detail = tasks.detail(first.id);
    assert.equal(detail.status, 'WAITING_CONFIRMATION'); assert.equal(detail.source, 'FIXTURE');
    assert.equal(detail.analysis.summary, analysis().summary); assert.equal(github.calls, 1);
    assert.equal((detail.usage[0] as any).actual_tokens, 300); assert.equal((detail.usage[0] as any).state, 'KNOWN');
    assert.equal('content' in detail.snapshot!.files[0], false); assert.equal(detail.steps.length, 2);
    assert.equal(tasks.create('https://github.com/owner/repo/issues/1', key).id, first.id);
  } finally { await tasks.close(); db.close(); }
});

test('unknown usage retains reservation; retry reuses pinned snapshot and cumulative budgets', async () => {
  const { db, github, tasks } = setup(fixtureModel(false));
  try {
    db.prepare('UPDATE settings SET value = ?').run(JSON.stringify({ ...settings, maxCallsPerTask: 1 }));
    const { id } = tasks.create('https://github.com/owner/repo/issues/1', randomUUID()); await tasks.idle();
    assert.equal((tasks.detail(id).usage[0] as any).actual_tokens, null);
    assert.equal((tasks.detail(id).usage[0] as any).state, 'UNKNOWN');
    db.prepare("UPDATE tasks SET status = 'INTERRUPTED' WHERE id = ?").run(id);
    tasks.retry(id, 0); assert.throws(() => tasks.retry(id, 0), /CONFLICT/); await tasks.idle();
    assert.equal((db.prepare('SELECT error_code FROM tasks WHERE id = ?').get(id) as any).error_code, 'TASK_BUDGET_EXCEEDED');
    assert.equal(github.calls, 1); assert.equal(tasks.detail(id).usage.length, 1);
  } finally { await tasks.close(); db.close(); }
});

test('single executor rejects cancelled late results and proceeds to the next task', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0, active = 0, peak = 0;
  class Delayed extends ModelClient {
    override available() { return true; }
    override async analyze(_context: Snapshot, _settings: typeof defaults, _signal: AbortSignal, usage: (n: number | null) => void) {
      calls++; active++; peak = Math.max(peak, active);
      if (calls === 1) { entered(); await gate; }
      usage(30); active--; return analysis();
    }
  }
  const { db, tasks } = setup(new Delayed());
  try {
    const a = tasks.create('https://github.com/owner/repo/issues/1', randomUUID());
    const b = tasks.create('https://github.com/owner/repo/issues/2', randomUUID());
    await started; tasks.cancel(a.id); release(); await tasks.idle();
    assert.equal(tasks.detail(a.id).status, 'CANCELLED'); assert.equal(tasks.detail(a.id).analysis, null);
    assert.equal(tasks.detail(b.id).status, 'WAITING_CONFIRMATION'); assert.equal(peak, 1);
  } finally { release(); await tasks.close(); db.close(); }
});

test('missing configuration does not enqueue or spend; model failures keep unknown usage', async () => {
  const db = openDatabase(':memory:'); const tasks = new TaskService(db);
  assert.throws(() => tasks.create('https://github.com/owner/repo/issues/1', randomUUID()), /MODEL_NOT_CONFIGURED/);
  assert.equal(tasks.list().length, 0); await tasks.close(); db.close();
  const failed = setup(new ModelClient(async () => { throw new Error('secret remote error'); }, { MODEL_API_KEY: 'unit-test-secret' }));
  try {
    const { id } = failed.tasks.create('https://github.com/owner/repo/issues/1', randomUUID()); await failed.tasks.idle();
    assert.equal(failed.tasks.detail(id).status, 'FAILED'); assert.equal((failed.tasks.detail(id).usage[0] as any).state, 'UNKNOWN');
    assert.equal(JSON.stringify(failed.tasks.detail(id)).includes('secret remote error'), false);
  } finally { await failed.tasks.close(); failed.db.close(); }
});

test('network rejects arbitrary destinations and caps streamed JSON, timeout and redirects', async () => {
  await assert.rejects(boundedJson('http://127.0.0.1/', {}, 100, 100), /DESTINATION/);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => { assert.equal(init?.redirect, 'error'); return new Response('x'.repeat(100)); }) as typeof fetch;
    await assert.rejects(boundedJson('https://api.github.com/repos/a/b', {}, 10, 1000), /TOO_LARGE/);
    globalThis.fetch = (async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('timed out'))); })) as typeof fetch;
    // Keep an ordinary timer alive: AbortSignal.timeout uses an unreferenced timer.
    const keepAlive = setTimeout(() => {}, 100);
    try { await assert.rejects(boundedJson('https://api.github.com/repos/a/b', {}, 10, 10), /timed out/); } finally { clearTimeout(keepAlive); }
  } finally { globalThis.fetch = original; }
});
