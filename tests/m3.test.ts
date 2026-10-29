import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../server/db.js';
import { defaults, loadConfig } from '../server/config.js';
import { PublicationService, redactPublicText } from '../server/publication.js';
import { StorageGuard, loadStorageLimits } from '../server/storage.js';
import { RuntimeMetrics } from '../server/metrics.js';
import { digest } from '../server/auth.js';
import { buildApp } from '../server/app.js';
import { verifyBackup } from '../server/backup-integrity.js';
import { ReviewService } from '../server/review.js';
import { TaskService } from '../server/tasks.js';
import { ModelClient } from '../server/model.js';
const draft = () => ({ title: '公开分析', summary: '明确边界并人工核查', rationale: '根据有限源码推断', uncertainties: ['尚未测试'] });
function fixture(path = ':memory:') {
  const db = openDatabase(path), id = randomUUID();
  const snapshot = { repo: 'fixture/repo', commit: 'a'.repeat(40), issue: { number: 1, title: '公开 Issue', body: 'INTERNAL_BODY_MUST_NOT_LEAK', url: 'https://github.com/fixture/repo/issues/1' }, files: [{ path: 'src/main.ts', content: 'PRIVATE_SOURCE_MUST_NOT_LEAK', url: 'https://evil.test/not-trusted' }], gaps: ['INTERNAL_GAP_MUST_NOT_LEAK'] };
  const analysis = { ...draft(), recommendation: 'NEEDS_REVIEW', evidence: [], plan: ['INTERNAL_PLAN_MUST_NOT_LEAK'] };
  db.prepare("INSERT INTO tasks(id, repo, issue_number, base_sha, snapshot, analysis, status, config_snapshot, data_source) VALUES (?, 'fixture/repo', 1, ?, ?, ?, 'WAITING_CONFIRMATION', ?, 'FIXTURE')").run(id, snapshot.commit, JSON.stringify(snapshot), JSON.stringify(analysis), JSON.stringify(defaults));
  const env: NodeJS.ProcessEnv = { MODEL_API_KEY: 'fixture-private-secret-123' };
  return { db, id, env, service: new PublicationService(db, env) };
}
test('public text redacts configured secrets, credentials, emails and private paths', () => {
  const input = 'fixture-private-secret-123 C:\\Users\\someone\\private.txt /home/user/secret.txt path=/srv/scout/private.txt mail@example.test sk-abcdefghijklmnop ghp_abcdefghijklmnop token=other-value https://evil.test/access?key=x';
  const clean = redactPublicText(input, ['fixture-private-secret-123']);
  for (const raw of ['fixture-private-secret-123', 'C:\\Users', '/home/user', '/srv/scout', 'mail@example.test', 'sk-abcdefghijklmnop', 'ghp_abcdefghijklmnop', 'other-value', 'https://evil.test']) assert.equal(clean.includes(raw), false, raw);
  assert.equal(redactPublicText(clean, ['fixture-private-secret-123']), clean);
});
test('only previewed white-list snapshots publish; public data excludes all internal payloads', () => {
  const { db, id, service } = fixture();
  try {
    const p = service.preview(id, { ...draft(), summary: 'fixture-private-secret-123 at C:\\Users\\someone\\secret.txt' });
    assert.equal(p.redacted, true); assert.equal(service.list().items.length, 0);
    assert.throws(() => service.publish(id, p.id, p.hash, false), /CONFIRMATION/);
    assert.throws(() => service.publish(id, p.id, '0'.repeat(64), true), /EXPIRED/);
    const published = service.publish(id, p.id, p.hash, true);
    assert.equal(service.publish(id, p.id, p.hash, true).id, published.id);
    const report = service.read(published.id), serialized = JSON.stringify(report);
    for (const raw of ['fixture-private-secret-123', 'C:\\Users', 'INTERNAL_', 'PRIVATE_SOURCE', 'config_snapshot', id, 'evil.test']) assert.equal(serialized.includes(raw), false, raw);
    assert.equal(report.snapshot.source, 'FIXTURE'); assert.equal(report.snapshot.projectTests, 'NOT_RUN'); assert.equal(report.snapshot.hasPatch, false);
    assert.equal(report.snapshot.sources[0].url, `https://github.com/fixture/repo/blob/${'a'.repeat(40)}/src/main.ts`);
    service.revoke(published.id);
    assert.equal(service.list().items.length, 0); assert.throws(() => service.read(published.id), /NOT_FOUND/);
    assert.throws(() => service.publish(id, p.id, p.hash, true), /EXPIRED/);
  } finally { db.close(); }
});
test('preview replacement, expiry, source changes and secret rotation require a fresh preview', () => {
  const { db, id, service, env } = fixture();
  try {
    const first = service.preview(id, draft()), second = service.preview(id, draft());
    assert.throws(() => service.publish(id, first.id, first.hash, true), /EXPIRED/);
    db.prepare('UPDATE publication_previews SET expires_at = 0').run();
    assert.throws(() => service.publish(id, second.id, second.hash, true), /EXPIRED/);
    const third = service.preview(id, draft()); db.prepare('UPDATE tasks SET analysis = ? WHERE id = ?').run(JSON.stringify({ summary: 'changed' }), id);
    assert.throws(() => service.publish(id, third.id, third.hash, true), /SOURCE_CHANGED/);
    const fourth = service.preview(id, draft()); env.MODEL_API_KEY = draft().summary;
    assert.throws(() => service.publish(id, fourth.id, fourth.hash, true), /REDACTION_CHANGED/);
  } finally { db.close(); }
});
test('public reader fails closed on unexpected fields, untrusted URLs and newly sensitive text', () => {
  const { db, id, service, env } = fixture();
  try {
    const p = service.preview(id, draft()), pub = service.publish(id, p.id, p.hash, true);
    const content = JSON.stringify({ ...p.snapshot, internalPrompt: 'SHOULD_NOT_LEAK' });
    db.prepare('UPDATE publications SET content = ?, hash = ? WHERE id = ?').run(content, digest(content), pub.id);
    assert.throws(() => service.read(pub.id), /NOT_FOUND/); assert.equal(service.list().items.length, 0);
    const unsafe = structuredClone(p.snapshot); unsafe.sources[0].url = 'javascript:alert(1)';
    const unsafeJson = JSON.stringify(unsafe); db.prepare('UPDATE publications SET content = ?, hash = ? WHERE id = ?').run(unsafeJson, digest(unsafeJson), pub.id);
    assert.throws(() => service.read(pub.id), /NOT_FOUND/);
    db.prepare('UPDATE publications SET content = ?, hash = ? WHERE id = ?').run(JSON.stringify(p.snapshot), p.hash, pub.id);
    env.MODEL_API_KEY = draft().summary;
    assert.throws(() => service.read(pub.id), /NOT_FOUND/);
  } finally { db.close(); }
});
test('storage caps and cleanup are bounded and never delete task/publication history', () => {
  const { db, id, service } = fixture();
  try {
    const limits = { ...loadStorageLimits({}), maxTasks: 1, maxArtifactTotalBytes: 1024, maxPublications: 1 };
    const guard = new StorageGuard(db, limits);
    assert.throws(() => guard.task(), /TASK_STORAGE/); assert.throws(() => guard.artifact(1025), /ARTIFACT_STORAGE/);
    const p = service.preview(id, draft()); service.publish(id, p.id, p.hash, true);
    assert.throws(() => guard.publication(), /PUBLICATION_STORAGE/);
    db.prepare('UPDATE publication_previews SET expires_at = 0').run(); db.prepare("INSERT INTO sessions VALUES ('fixture-hash', 0)").run();
    assert.deepEqual(guard.cleanup(), { expiredSessions: 1, expiredPreviews: 1 });
    assert.equal(guard.usage().tasks, 1); assert.equal(service.list().items.length, 1);
    const reviewer = new ReviewService(db, { ...limits, maxPlansPerTask: 1 });
    const planInput = { steps: ['核对边界'], allowedPaths: ['src/main.ts'], allowSensitive: false, allowDependencies: false };
    reviewer.save(id, planInput, 0, 'a'.repeat(40));
    assert.throws(() => reviewer.save(id, planInput, 1, 'a'.repeat(40)), /PLAN_STORAGE_LIMIT/);
    assert.throws(() => loadStorageLimits({ MAX_TASKS: '0' }));
  } finally { db.close(); }
});
test('runtime observation ring is bounded and never claims capacity validation', () => {
  const metrics = new RuntimeMetrics();
  try {
    metrics.mark('analysis'); for (let i = 0; i < 150; i++) metrics.snapshot(); metrics.mark('patch');
    const value = metrics.snapshot();
    assert.ok(value.recentSamples.length <= 120); assert.equal(value.capacityValidated, false);
    assert.ok(value.phases.analysis!.peakRssBytes > 0); assert.ok(value.processPeakRssBytes > 0);
  } finally { metrics.close(); }
});
test('guest API reads only published reports; publishing and operations require login plus CSRF', async () => {
  const { db, id } = fixture(); const salt = 'e'.repeat(32), password = 'm3-fixture-password';
  const config = loadConfig({ ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}` });
  const app = await buildApp(config, db, false);
  try {
    assert.equal((await app.inject('/api/public/reports')).statusCode, 200);
    assert.equal((await app.inject('/api/admin/operations')).statusCode, 401);
    assert.equal((await app.inject(`/api/admin/tasks/${id}/publication`)).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.origin }, payload: { password } });
    const headers = { origin: config.origin, cookie: `scout_session=${login.cookies[0].value}`, 'x-csrf-token': login.json().csrfToken };
    const path = `/api/admin/tasks/${id}/publication`;
    assert.equal((await app.inject({ method: 'POST', url: path + '/preview', headers: { cookie: headers.cookie, origin: config.origin }, payload: draft() })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: path + '/preview', headers, payload: { ...draft(), secret: 'forbidden' } })).statusCode, 400);
    const preview = (await app.inject({ method: 'POST', url: path + '/preview', headers, payload: draft() })).json();
    const pub = (await app.inject({ method: 'POST', url: path + '/publish', headers, payload: { previewId: preview.id, hash: preview.hash, confirmed: true } })).json();
    const response = await app.inject(`/api/public/reports/${pub.id}`);
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store'); assert.match(response.headers['content-security-policy'] as string, /default-src 'self'/);
    assert.equal((await app.inject({ method: 'POST', url: `/api/public/reports/${pub.id}`, headers: { origin: config.origin }, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/publications/${pub.id}/revoke`, headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject(`/api/public/reports/${pub.id}`)).statusCode, 404);
    assert.equal((await app.inject('/api/public/reports?page=1')).statusCode, 200);
    assert.equal((await app.inject('/api/public/reports?page=0')).statusCode, 400);
  } finally { await app.close(); db.close(); }
});
test('backup restore preserves snapshot hashes but revokes publication and clears sessions/previews', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-m3-restore-')); const path = join(dir, 'source.sqlite');
  const { db, id, service } = fixture(path);
  try {
    const p = service.preview(id, draft()), pub = service.publish(id, p.id, p.hash, true);
    db.prepare("INSERT INTO sessions VALUES ('fixture-session-hash', ?)").run(Date.now() + 100000);
    const backup = spawnSync(process.execPath, ['dist/server/backup.js', join(dir, 'backups')], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' }); assert.equal(backup.status, 0, backup.stderr);
    const backupPath = join(dir, 'backups', readdirSync(join(dir, 'backups')).find(name => name.endsWith('.sqlite'))!);
    const manifest = await verifyBackup(backupPath); assert.equal(manifest.integrity, 'ok');
    const tooMany = spawnSync(process.execPath, ['dist/server/backup.js', join(dir, 'backups')], { env: { ...process.env, DB_PATH: path, MAX_BACKUPS: '1' }, encoding: 'utf8' });
    assert.notEqual(tooMany.status, 0); assert.match(tooMany.stderr, /BACKUP_COUNT_LIMIT/);
    const target = join(dir, 'restored', 'restored.sqlite');
    const restored = spawnSync(process.execPath, ['dist/server/restore.js', backupPath, target], { encoding: 'utf8' }); assert.equal(restored.status, 0, restored.stderr);
    const restoredDb = openDatabase(target, false);
    try {
      const restoredService = new PublicationService(restoredDb);
      assert.equal((restoredDb.prepare('SELECT hash FROM publications WHERE id = ?').get(pub.id) as any).hash, p.hash);
      assert.throws(() => restoredService.read(pub.id), /NOT_FOUND/);
      assert.equal((restoredDb.prepare('SELECT count(*) AS n FROM sessions').get() as any).n, 0);
      assert.equal((restoredDb.prepare('SELECT count(*) AS n FROM publication_previews').get() as any).n, 0);
      const preview = restoredService.preview(id, draft()); const republished = restoredService.publish(id, preview.id, preview.hash, true);
      assert.notEqual(republished.id, pub.id); assert.equal(restoredService.read(republished.id).hash, preview.hash);
    } finally { restoredDb.close(); }
    assert.notEqual(spawnSync(process.execPath, ['dist/server/restore.js', backupPath, target]).status, 0);
    const file = readFileSync(backupPath); file[file.length - 1] ^= 1; writeFileSync(backupPath, file);
    await assert.rejects(verifyBackup(backupPath), /HASH_INVALID/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('artifact quota rejects the queued patch before any paid model invocation', async () => {
  const { db, id } = fixture(); let calls = 0;
  class Provider extends ModelClient { override available() { return true; } override async generatePatch(): Promise<any> { calls++; throw new Error('must not call'); } }
  const tasks = new TaskService(db, { model: new Provider(), limits: { ...loadStorageLimits({}), maxArtifactTotalBytes: 1024 } });
  try {
    const p = tasks.review.save(id, { steps: ['核对边界'], allowedPaths: ['src/main.ts'], allowSensitive: false, allowDependencies: false }, 0, 'a'.repeat(40));
    tasks.review.confirm(id, p.id, p.hash, p.content.baseSha); tasks.generate(id, p.id, p.hash, p.content.baseSha); await tasks.idle();
    assert.equal(calls, 0); assert.equal(tasks.detail(id).usage.length, 0); assert.equal(tasks.detail(id).error_code, 'ARTIFACT_STORAGE_LIMIT');
  } finally { await tasks.close(); db.close(); }
});
