import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, logOptions } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { loadConfig, defaults } from '../server/config.js';
import { digest } from '../server/auth.js';
import pino from 'pino';
import { spawnSync } from 'node:child_process';
const salt = 'a'.repeat(32), password = 'fixture-password-only';
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const config = () => loadConfig({ ADMIN_PASSWORD_HASH: hash });

test('configuration rejects unsafe production and invalid secrets or limits', () => {
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ ADMIN_PASSWORD_HASH: hash, NODE_ENV: 'production' }));
  assert.throws(() => loadConfig({ ADMIN_PASSWORD_HASH: hash, SESSION_HOURS: '0' }));
  assert.equal(loadConfig({ ADMIN_PASSWORD_HASH: hash, APP_ORIGIN: 'https://scout.example.com', NODE_ENV: 'production' }).secureCookie, true);
});

test('migration persists settings, detects tampering and interrupts only running tasks on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-'));
  const path = join(dir, 'test.sqlite');
  let db = openDatabase(path);
  try {
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.prepare("INSERT INTO tasks(id, repo, issue_number, status, config_snapshot) VALUES ('t1', 'fixture/repo', 1, 'RUNNING', '{}'), ('t2', 'fixture/repo', 2, 'WAITING_CONFIRMATION', '{}')").run();
    db.close(); db = openDatabase(path);
    assert.equal((db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as any).status, 'INTERRUPTED');
    assert.equal((db.prepare("SELECT status FROM tasks WHERE id = 't2'").get() as any).status, 'WAITING_CONFIRMATION');
    assert.equal((db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as any).n, 6);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered'").run();
    db.close();
    assert.throws(() => openDatabase(path), /checksum/);
  } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('admin authentication, session hashes, CSRF, strict schemas, persistence, expiry and logout', async () => {
  const db = openDatabase(':memory:');
  const app = await buildApp(config(), db, false);
  try {
    assert.equal((await app.inject('/api/health')).json().database, 'ok');
    assert.equal((await app.inject('/api/admin/settings')).statusCode, 401);
    assert.equal((await app.inject('/api/admin/tasks')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode, 403);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config().origin }, payload: { password } });
    assert.equal(login.statusCode, 200);
    const raw = login.cookies[0].value;
    const headers = { origin: config().origin, cookie: `scout_session=${raw}`, 'x-csrf-token': login.json().csrfToken };
    assert.match(login.headers['set-cookie'] as string, /HttpOnly/);
    assert.match(login.headers['set-cookie'] as string, /SameSite=Strict/);
    assert.equal((db.prepare('SELECT token_hash FROM sessions').get() as any).token_hash, digest(raw));
    assert.equal((await app.inject({ url: '/api/admin/session', headers })).json().csrfToken, login.json().csrfToken);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: headers.cookie, origin: headers.origin }, payload: defaults })).statusCode, 403);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { ...headers, origin: 'https://attacker.example' }, payload: defaults })).statusCode, 403);
    for (const payload of [{ ...defaults, secret: 'forbidden' }, { ...defaults, maxFiles: 0 }, { ...defaults, modelKeyRef: 'sk-secret' }, { ...defaults, maxFiles: '20' }]) {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers, payload })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers, payload: { settings: { ...defaults, model: 'fixture-model' }, expectedRevision: 1 } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/admin/settings', headers })).json().settings.model, 'fixture-model');
    assert.deepEqual((await app.inject({ url: '/api/admin/tasks', headers })).json().items, []);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/tasks', headers, payload: {} })).statusCode, 400);
    db.prepare('UPDATE sessions SET expires_at = 0').run();
    assert.equal((await app.inject({ url: '/api/admin/session', headers })).statusCode, 401);
    db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() + 60000);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/logout', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/admin/session', headers })).statusCode, 401);
    assert.equal((await app.inject('/.env')).statusCode, 403);
    assert.equal((await app.inject('/api/unknown')).statusCode, 404);
  } finally { await app.close(); db.close(); }
});

test('HTTPS cookie and login throttling', async () => {
  const cfg = loadConfig({ ADMIN_PASSWORD_HASH: hash, NODE_ENV: 'production', APP_ORIGIN: 'https://scout.example.com' });
  const db = openDatabase(':memory:'); const app = await buildApp(cfg, db, false);
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: cfg.origin }, payload: { password } });
    assert.match(login.headers['set-cookie'] as string, /Secure/);
    for (let n = 0; n < 4; n++) assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: cfg.origin }, payload: { password: 'wrong' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: cfg.origin }, payload: { password: 'wrong' } })).statusCode, 429);
  } finally { await app.close(); db.close(); }
});

test('structured logger omits URL, headers, body and sensitive fields', () => {
  let output = '';
  const logger = pino(logOptions, { write: (chunk: string) => { output += chunk; } });
  logger.info({ req: { method: 'POST', url: '/?token=fixture-url-secret', headers: { authorization: 'fixture-auth-secret', cookie: 'fixture-cookie-secret' }, body: { password: 'fixture-body-secret' } }, password: 'fixture-password-secret', token: 'fixture-token-secret', body: 'fixture-top-secret', res: { statusCode: 200, headers: { 'set-cookie': 'fixture-set-cookie-secret' } } });
  for (const text of ['fixture-url', 'fixture-auth', 'fixture-cookie', 'fixture-body', 'fixture-password', 'fixture-token', 'fixture-top', 'fixture-set-cookie']) assert.equal(output.includes(text), false);
  assert.match(output, /REDACTED/);
});

test('application server contains no child-process or target execution entry point', () => {
  for (const name of readdirSync('server').filter(name => name.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(join('server', name), 'utf8'), /child_process|\beval\s*\(|new Function|docker\.sock/);
  }
});

test('compiled backup preserves source task status and restores an integral database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-backup-'));
  const path = join(dir, 'source.sqlite');
  const db = openDatabase(path);
  try {
    db.prepare("INSERT INTO tasks(id, repo, issue_number, status, config_snapshot) VALUES ('running', 'fixture/repo', 1, 'RUNNING', '{}')").run();
    const result = spawnSync(process.execPath, ['dist/server/backup.js', join(dir, 'backups')], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((db.prepare('SELECT status FROM tasks').get() as any).status, 'RUNNING');
    const restored = openDatabase(join(dir, 'backups', readdirSync(join(dir, 'backups')).find(name => name.endsWith('.sqlite'))!), false);
    try {
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal((restored.prepare('SELECT status FROM tasks').get() as any).status, 'RUNNING');
      assert.equal((restored.prepare('SELECT value FROM settings').get() as any).value, JSON.stringify(defaults));
    } finally { restored.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

