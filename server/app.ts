import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { type Config, defaults, settingsSchema } from './config.js';
import { csrfToken, digest, newToken, verifyPassword } from './auth.js';

export const logOptions = {
  level: 'info',
  redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'password', 'token', 'secret', 'body'], censor: '[REDACTED]' },
  // No URL, query, headers, bodies or raw errors from untrusted input.
  serializers: { req: (r: { method: string }) => ({ method: r.method }), res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }) },
};
export async function buildApp(config: Config, db: Database.Database, logger = true) {
  const app = Fastify({ logger: logger ? logOptions : false, bodyLimit: 16384, trustProxy: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 5, timeWindow: '1 minute', cache: 1000 });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== config.origin) return reply.code(403).send({ error: 'ORIGIN_REJECTED' });
  });
  app.setErrorHandler((error, req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) req.log.error({ code: 'INTERNAL_ERROR' }, 'Request failed');
    reply.code(status).send({ error: status === 400 ? 'INVALID_INPUT' : status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED' });
  });
  const cookieOptions = { httpOnly: true, secure: config.secureCookie, sameSite: 'strict' as const, path: '/' };
  const sessionFor = (raw: string | undefined) => raw && /^[a-f0-9]{64}$/.test(raw) ? db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?').get(digest(raw), Date.now()) : undefined;
  app.get('/api/health', async (_req, reply) => {
    try { db.prepare('SELECT 1').get(); return { status: 'ok', database: 'ok', phase: 'M0' }; }
    catch { return reply.code(503).send({ status: 'unhealthy', database: 'unavailable' }); }
  });
  app.post<{ Body: { password: string } }>('/api/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 256 } } } },
  }, async (req, reply) => {
    if (!await verifyPassword(req.body.password, config.passwordHash)) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    const raw = newToken();
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      if (req.cookies.scout_session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies.scout_session));
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(digest(raw), Date.now() + config.sessionHours * 3600000);
      db.prepare('DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY expires_at DESC LIMIT 20)').run();
    })();
    reply.setCookie('scout_session', raw, { ...cookieOptions, maxAge: config.sessionHours * 3600 });
    return { csrfToken: csrfToken(raw) };
  });
  await app.register(async admin => {
    admin.addHook('onRequest', async (req, reply) => {
      const raw = req.cookies.scout_session;
      if (!sessionFor(raw)) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== csrfToken(raw!)) return reply.code(403).send({ error: 'CSRF_REJECTED' });
    });
    admin.get('/session', async req => ({ csrfToken: csrfToken(req.cookies.scout_session!), phase: 'M0' }));
    admin.post('/logout', async (req, reply) => {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies.scout_session!));
      reply.clearCookie('scout_session', cookieOptions);
      return { ok: true };
    });
    admin.get('/tasks', { schema: { querystring: { type: 'object', additionalProperties: false } } }, async () => ({ items: db.prepare('SELECT id, repo, issue_number, status, created_at FROM tasks ORDER BY created_at DESC LIMIT 50').all(), creationEnabled: false, phase: 'M0' }));
    admin.get('/settings', async () => ({ settings: JSON.parse((db.prepare('SELECT value FROM settings WHERE id = 1').get() as { value: string }).value), policy: { targetCodeExecution: false, githubAccess: 'READ_ONLY', patchStatus: 'UNVERIFIED', projectTests: 'NOT_RUN', activeTasks: 1 } }));
    admin.put<{ Body: typeof defaults }>('/settings', { schema: { body: settingsSchema } }, async req => {
      db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(JSON.stringify(req.body));
      return { ok: true };
    });
  }, { prefix: '/api/admin' });
  const frontend = resolve('frontend/dist');
  if (existsSync(frontend)) await app.register(staticFiles, { root: frontend, index: ['index.html'], dotfiles: 'deny' });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'NOT_FOUND' }));
  return app;
}
